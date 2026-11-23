"""Centralized allowlisted tools for the campus agent."""

from datetime import datetime, timezone
from typing import Any, Callable, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, ValidationError, field_validator
from bson import ObjectId

from database import (
    attendance_collection,
    attendance_entries_collection,
    books_collection,
    complaints_collection,
    lost_found_items_collection,
    notifications_collection,
    students_collection,
    timetable_collection,
)
from dependencies.auth import user_role
from dependencies.student import find_linked_student
from services.academic_intelligence import analyze_student, generate_study_plan
from services.data_filters import visible_academic_filter


ToolFunction = Callable[[dict, dict[str, Any]], dict[str, Any]]


class EmptyToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DayToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    day: StrictStr = Field(default="", max_length=20)

    @field_validator("day")
    @classmethod
    def valid_day(cls, value: str) -> str:
        if value and value.title() not in (
            "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"
        ):
            raise ValueError("day must be a weekday")
        return value.title()


class SubjectToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subject_code: StrictStr = Field(default="", max_length=20)


class NotificationToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    limit: StrictInt = Field(default=20, ge=1, le=100)
    unread_only: StrictBool = Field(default=False)


class LibraryToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    search: StrictStr = Field(default="", max_length=100)
    limit: StrictInt = Field(default=20, ge=1, le=100)


class LostFoundToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    report_type: Literal["", "lost", "found"] = ""
    limit: StrictInt = Field(default=20, ge=1, le=100)


class ComplaintStatusToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    complaint_id: StrictStr = Field(default="", max_length=24)
    limit: StrictInt = Field(default=20, ge=1, le=100)


class CreateComplaintToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category: Literal["academic", "facilities", "transport", "library", "safety", "other"]
    title: StrictStr = Field(min_length=3, max_length=120)
    description: StrictStr = Field(min_length=10, max_length=5000)


class AgentTool:
    def __init__(
        self,
        name: str,
        description: str,
        roles: tuple[str, ...],
        input_schema: dict[str, Any],
        access: str,
        confirmation_required: bool,
        execute: ToolFunction,
        arg_model: type[BaseModel] | None = None,
    ) -> None:
        self.name = name
        self.description = description
        self.roles = roles
        self.input_schema = input_schema
        self.access = access
        self.confirmation_required = confirmation_required
        self.execute = execute
        self.arg_model = arg_model

    def authorize(self, user: dict) -> None:
        role = user_role(user)
        if role not in self.roles:
            raise HTTPException(status_code=403, detail="This tool is not allowed for your role")

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "roles": list(self.roles),
            "input_schema": self.input_schema,
            "access": self.access,
            "confirmation_required": self.confirmation_required,
        }


def _validate_arguments(arguments: dict[str, Any], allowed: set[str]) -> dict[str, Any]:
    if not isinstance(arguments, dict):
        raise HTTPException(status_code=422, detail="Tool arguments must be an object")
    unknown = set(arguments) - allowed
    if unknown:
        raise HTTPException(status_code=422, detail="Unknown tool arguments")
    return arguments


def _get_timetable(user: dict, arguments: dict[str, Any]) -> dict[str, Any]:
    arguments = _validate_arguments(arguments, {"day"})
    day = str(arguments.get("day", "")).strip().title()[:20]
    role = user_role(user)
    if role == "student":
        student = find_linked_student(user)
        if not student:
            return {"linked": False, "entries": []}
        query = {"department": student.get("department"), "semester": student.get("semester")}
        if student.get("section"):
            query["$or"] = [{"section": student["section"]}, {"section": {"$exists": False}}]
    elif role == "faculty":
        codes = [str(code).upper() for code in user.get("assigned_subject_codes", [])]
        query = {"$or": [
            {"faculty_user_id": str(user["_id"])},
            {"subject_code": {"$in": codes}},
        ]}
    else:
        query = {}
    query.update(visible_academic_filter(user))
    if day:
        query["day_of_week"] = day
    entries = list(timetable_collection.find(query, {"_id": 0}).limit(100))
    return {"entries": entries, "total": len(entries)}


def _get_attendance(user: dict, arguments: dict[str, Any]) -> dict[str, Any]:
    arguments = _validate_arguments(arguments, {"subject_code"})
    role = user_role(user)
    if role == "student":
        student = find_linked_student(user)
        if not student:
            return {"linked": False, "records": []}
        query = {"student_id": student["student_id"]}
    elif role == "faculty":
        codes = [str(code).upper() for code in user.get("assigned_subject_codes", [])]
        subject_code = str(arguments.get("subject_code", "")).strip().upper()
        if subject_code:
            if subject_code not in codes:
                raise HTTPException(status_code=403, detail="Subject is outside your authorized scope")
            codes = [subject_code]
        timetable_entries = list(timetable_collection.find(
            {
                "$or": [
                    {"faculty_user_id": str(user["_id"])},
                    {"subject_code": {"$in": codes}},
                ]
            },
            {"department": 1, "semester": 1, "section": 1, "subject_code": 1},
        ))
        authorized_student_ids: set[str] = set()
        for entry in timetable_entries:
            if str(entry.get("subject_code", "")).upper() not in codes:
                continue
            student_query: dict[str, Any] = {
                "department": entry.get("department"),
                "semester": entry.get("semester"),
            }
            if entry.get("section"):
                student_query["$or"] = [
                    {"section": entry["section"]},
                    {"section": {"$exists": False}},
                ]
            for student in students_collection.find(student_query, {"student_id": 1}):
                if student.get("student_id"):
                    authorized_student_ids.add(str(student["student_id"]))
        query = {
            "subject_code": {"$in": codes},
            "student_id": {"$in": sorted(authorized_student_ids)},
        }
    else:
        query = {}
    query.update(visible_academic_filter(user))
    subject_code = str(arguments.get("subject_code", "")).strip().upper()
    if subject_code and role != "faculty":
        query["subject_code"] = subject_code
    records = list(attendance_collection.find(query, {"_id": 0}).limit(500))
    return {"records": records, "total": len(records)}


def _get_marks(user: dict, arguments: dict[str, Any]) -> dict[str, Any]:
    arguments = _validate_arguments(arguments, {"subject_code"})
    role = user_role(user)
    if role == "student":
        student = find_linked_student(user)
        if not student:
            return {"linked": False, "records": []}
        query = {"student_id": student["student_id"]}
    elif role == "faculty":
        codes = [str(code).upper() for code in user.get("assigned_subject_codes", [])]
        subject_code = str(arguments.get("subject_code", "")).strip().upper()
        if subject_code and subject_code not in codes:
            raise HTTPException(status_code=403, detail="Subject is outside your authorized scope")
        if subject_code:
            codes = [subject_code]
        timetable_entries = list(timetable_collection.find(
            {
                "$or": [
                    {"faculty_user_id": str(user["_id"])},
                    {"subject_code": {"$in": codes}},
                ]
            },
            {"department": 1, "semester": 1, "section": 1, "subject_code": 1},
        ))
        authorized_student_ids: set[str] = set()
        for entry in timetable_entries:
            if str(entry.get("subject_code", "")).upper() not in codes:
                continue
            student_query = {
                "department": entry.get("department"),
                "semester": entry.get("semester"),
            }
            if entry.get("section"):
                student_query["$or"] = [
                    {"section": entry["section"]},
                    {"section": {"$exists": False}},
                ]
            for student in students_collection.find(student_query, {"student_id": 1}):
                if student.get("student_id"):
                    authorized_student_ids.add(str(student["student_id"]))
        query = {
            "subject_code": {"$in": codes},
            "student_id": {"$in": sorted(authorized_student_ids)},
        }
    else:
        query = {}
    query.update(visible_academic_filter(user))
    subject_code = str(arguments.get("subject_code", "")).strip().upper()
    if subject_code and role != "faculty":
        query["subject_code"] = subject_code
    records = list(database_marks().find(query, {"_id": 0}).limit(500))
    return {"records": records, "total": len(records)}


def database_marks():
    from database import database
    return database["marks"]


def _get_free_periods(user: dict, arguments: dict[str, Any]) -> dict[str, Any]:
    arguments = _validate_arguments(arguments, {"day"})
    if user_role(user) != "student":
        raise HTTPException(status_code=403, detail="Free-period lookup is available to students")
    student = find_linked_student(user)
    if not student:
        return {"linked": False, "free_slots": []}
    day = str(arguments.get("day", "")).strip().title()[:20]
    query = {
        "department": student.get("department"),
        "semester": student.get("semester"),
        **visible_academic_filter(user),
    }
    if day:
        query["day_of_week"] = day
    entries = list(timetable_collection.find(query, {"_id": 0}))
    from services.free_time_service import calculate_free_time
    day_name = day or datetime.now(timezone.utc).strftime("%A")
    return calculate_free_time(entries, day_name)


def _search_notifications(user: dict, arguments: dict[str, Any]) -> dict[str, Any]:
    arguments = _validate_arguments(arguments, {"limit", "unread_only"})
    if user_role(user) != "student":
        raise HTTPException(status_code=403, detail="Notification lookup is available to students")
    student = find_linked_student(user)
    if not student:
        return {"linked": False, "notifications": []}
    limit = arguments.get("limit", 20)
    if not isinstance(limit, int) or limit < 1 or limit > 100:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 100")
    query = {
        "student_id": student["student_id"],
        **visible_academic_filter(user),
    }
    if arguments.get("unread_only") is True:
        query["is_read"] = False
    items = list(notifications_collection.find(query, {"_id": 0}).sort("created_at", -1).limit(limit))
    return {"notifications": items, "total": len(items)}


def _search_library(user: dict, arguments: dict[str, Any]) -> dict[str, Any]:
    arguments = _validate_arguments(arguments, {"search", "limit"})
    search = str(arguments.get("search", "")).strip().lower()[:100]
    limit = arguments.get("limit", 20)
    if not isinstance(limit, int) or limit < 1 or limit > 100:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 100")
    query = {}
    if search:
        expression = {"$regex": search, "$options": "i"}
        query["$or"] = [
            {"title": expression},
            {"author": expression},
            {"isbn": expression},
            {"category": expression},
        ]
    items = list(books_collection.find(query, {"_id": 0}).limit(limit))
    return {"books": items, "total": len(items)}


def _search_lost_found(user: dict, arguments: dict[str, Any]) -> dict[str, Any]:
    arguments = _validate_arguments(arguments, {"report_type", "limit"})
    report_type = str(arguments.get("report_type", "")).strip().lower()
    if report_type not in ("lost", "found", ""):
        raise HTTPException(status_code=422, detail="report_type must be lost or found")
    limit = arguments.get("limit", 20)
    if not isinstance(limit, int) or limit < 1 or limit > 100:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 100")
    query = {"user_id": user["_id"], "status": {"$in": ["active", "match_found", "verification_pending"]}}
    if report_type:
        query["report_type"] = report_type
    items = list(lost_found_items_collection.find(
        query,
        {"description": 0, "additional_details": 0, "location": 0, "user_id": 0},
    ).limit(limit))
    for item in items:
        item["id"] = str(item.pop("_id"))
    return {"reports": items, "total": len(items)}


def _get_complaint_status(user: dict, arguments: dict[str, Any]) -> dict[str, Any]:
    arguments = _validate_arguments(arguments, {"complaint_id", "limit"})
    complaint_id = str(arguments.get("complaint_id", "")).strip()
    role = user_role(user)
    if complaint_id:
        try:
            object_id = ObjectId(complaint_id)
        except Exception:
            raise HTTPException(status_code=422, detail="complaint_id is invalid")
        query = {"_id": object_id}
        if role != "admin":
            query["user_id"] = user["_id"]
        complaint = complaints_collection.find_one(query, {"responses": 0, "student_email": 0, "student_name": 0})
        if not complaint:
            raise HTTPException(status_code=404, detail="Complaint not found")
        complaint["id"] = str(complaint.pop("_id"))
        return {"complaint": complaint}
    if role not in ("student", "admin"):
        raise HTTPException(status_code=403, detail="This role cannot view complaints")
    query = {} if role == "admin" else {"user_id": user["_id"]}
    limit = arguments.get("limit", 20)
    if not isinstance(limit, int) or limit < 1 or limit > 100:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 100")
    items = list(complaints_collection.find(query, {"responses": 0, "student_email": 0}).sort("created_at", -1).limit(limit))
    for item in items:
        item["id"] = str(item.pop("_id"))
    return {"complaints": items, "total": len(items)}


def _generate_academic_recommendations(user: dict, arguments: dict[str, Any]) -> dict[str, Any]:
    arguments = _validate_arguments(arguments, set())
    if user_role(user) not in ("student", "faculty", "admin"):
        raise HTTPException(status_code=403, detail="Academic recommendations are not allowed")
    if user_role(user) == "student":
        student = find_linked_student(user)
        if not student:
            return {"linked": False, "recommendations": []}
        query = {
            "student_id": student["student_id"],
            **visible_academic_filter(user),
        }
        attendance = list(attendance_collection.find(query, {"_id": 0}))
        entries = list(attendance_entries_collection.find(query, {"_id": 0}))
        marks = list(database_marks().find(query, {"_id": 0}))
        report = analyze_student(student, attendance, entries, marks)
        plan = generate_study_plan(report)
        return {
            "recommendations": report["recommendations"],
            "weak_subjects": report["weak_subjects"],
            "study_plan": plan,
        }
    raise HTTPException(status_code=403, detail="Class-level recommendations require a dedicated academic endpoint")


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, AgentTool] = {}

    def register(self, tool: AgentTool) -> None:
        if tool.name in self._tools:
            raise RuntimeError(f"Duplicate tool: {tool.name}")
        self._tools[tool.name] = tool

    def get(self, name: str) -> AgentTool:
        tool = self._tools.get(name)
        if tool is None:
            raise HTTPException(status_code=404, detail="Unknown tool")
        return tool

    def execute(self, name: str, user: dict, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        tool = self.get(name)
        tool.authorize(user)
        if arguments is None:
            arguments = {}
        if tool.arg_model is not None:
            try:
                validated = tool.arg_model.model_validate(arguments)
            except ValidationError as error:
                raise HTTPException(status_code=422, detail="Invalid tool arguments") from error
        if tool.confirmation_required:
            raise HTTPException(status_code=409, detail="This tool requires explicit confirmation")
            arguments = validated.model_dump(exclude_unset=True)
        else:
            try:
                EmptyToolArguments.model_validate(arguments)
            except ValidationError as error:
                raise HTTPException(status_code=422, detail="Invalid tool arguments") from error
        result = tool.execute(user, arguments)
        if not isinstance(result, dict):
            raise HTTPException(status_code=500, detail="Tool returned an invalid response")
        return {"tool": name, "result": result}

    def list(self) -> list[dict[str, Any]]:
        return [tool.to_dict() for tool in self._tools.values()]


tool_registry = ToolRegistry()
tool_registry.register(AgentTool("get_timetable", "Get authorized timetable entries", ("student", "faculty", "admin"), {"type": "object", "properties": {"day": {"type": "string"}}, "additionalProperties": False}, "read", False, _get_timetable, DayToolArguments))
tool_registry.register(AgentTool("get_attendance", "Get authorized attendance records", ("student", "faculty", "admin"), {"type": "object", "properties": {"subject_code": {"type": "string"}}, "additionalProperties": False}, "read", False, _get_attendance, SubjectToolArguments))
tool_registry.register(AgentTool("get_internal_marks", "Get authorized internal marks", ("student", "faculty", "admin"), {"type": "object", "properties": {"subject_code": {"type": "string"}}, "additionalProperties": False}, "read", False, _get_marks, SubjectToolArguments))
tool_registry.register(AgentTool("get_free_periods", "Get free periods for a student", ("student",), {"type": "object", "properties": {"day": {"type": "string"}}, "additionalProperties": False}, "read", False, _get_free_periods, DayToolArguments))
tool_registry.register(AgentTool("search_notifications", "Search authorized notifications", ("student",), {"type": "object", "properties": {"limit": {"type": "integer"}, "unread_only": {"type": "boolean"}}, "additionalProperties": False}, "read", False, _search_notifications, NotificationToolArguments))
tool_registry.register(AgentTool("search_library", "Search library catalog", ("student", "faculty", "admin"), {"type": "object", "properties": {"search": {"type": "string"}, "limit": {"type": "integer"}}, "additionalProperties": False}, "read", False, _search_library, LibraryToolArguments))
tool_registry.register(AgentTool("search_lost_found", "Search owned Lost and Found reports", ("student", "admin"), {"type": "object", "properties": {"report_type": {"type": "string"}, "limit": {"type": "integer"}}, "additionalProperties": False}, "read", False, _search_lost_found, LostFoundToolArguments))
tool_registry.register(AgentTool("get_complaint_status", "Get authorized complaint status", ("student", "admin"), {"type": "object", "properties": {"complaint_id": {"type": "string"}, "limit": {"type": "integer"}}, "additionalProperties": False}, "read", False, _get_complaint_status, ComplaintStatusToolArguments))
tool_registry.register(AgentTool("generate_academic_recommendations", "Generate explainable academic recommendations", ("student",), {"type": "object", "properties": {}, "additionalProperties": False}, "read", False, _generate_academic_recommendations, EmptyToolArguments))
tool_registry.register(AgentTool("create_complaint", "Prepare complaint creation for confirmation", ("student",), {"type": "object", "properties": {"category": {"type": "string"}, "title": {"type": "string"}, "description": {"type": "string"}}, "required": ["category", "title", "description"], "additionalProperties": False}, "write", True, lambda _user, _arguments: {"requires_confirmation": True}, CreateComplaintToolArguments))
