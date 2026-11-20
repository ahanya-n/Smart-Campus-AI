from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field, field_validator, model_validator
from pymongo.errors import DuplicateKeyError

from database import timetable_collection, users_collection
from dependencies.auth import assigned_subjects, get_current_user, require_roles, user_role
from dependencies.student import (
    NOT_LINKED_MESSAGE,
    StudentContext,
    StudentInfo,
    get_student_context,
)
from services.data_filters import visible_academic_filter
from validators import CODE_PATTERN, DAYS, TIME_PATTERN, DayOfWeek

router = APIRouter(prefix="/timetable", tags=["Timetable"])

staff_only = require_roles("faculty", "admin")


class TimetableInput(BaseModel):
    department: str = Field(min_length=1, max_length=50)
    semester: int = Field(ge=1, le=12)
    day_of_week: DayOfWeek
    subject_code: str = Field(pattern=CODE_PATTERN)
    subject_name: str = Field(min_length=1, max_length=120)
    start_time: str = Field(pattern=TIME_PATTERN, description="24-hour HH:MM")
    end_time: str = Field(pattern=TIME_PATTERN, description="24-hour HH:MM")
    faculty_name: str | None = Field(
        None, max_length=100,
        description="Required for admins unless faculty_user_id is given; faculty are filled in automatically",
    )
    faculty_user_id: str | None = Field(None, description="Admin only: the faculty account teaching this class")
    room_number: str = Field(min_length=1, max_length=30)

    @field_validator("subject_code")
    @classmethod
    def upper_code(cls, value: str) -> str:
        return value.upper()

    @model_validator(mode="after")
    def end_after_start(self):
        # Zero-padded HH:MM strings compare correctly as text.
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


class TimetableEntry(BaseModel):
    id: str
    department: str
    semester: str
    day_of_week: str
    subject_code: str
    subject_name: str
    start_time: str
    end_time: str
    faculty_name: str
    faculty_user_id: str | None
    room_number: str
    is_demo: bool


class TimetableResponse(BaseModel):
    linked: bool
    is_demo: bool
    scope: str = Field(description="student, faculty, admin or demo")
    message: str | None
    student: StudentInfo | None
    day: str | None = Field(None, description="Set when the response is for a single day")
    entries: list[TimetableEntry]


def build_timetable_document(data: TimetableInput, is_demo: bool = False) -> dict:
    return {**data.model_dump(), "is_demo": is_demo}


def _semester_value(raw) -> int | str:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return str(raw)


def to_entry(d: dict) -> TimetableEntry:
    return TimetableEntry(
        id=str(d.get("_id", "")),
        department=str(d.get("department", "")),
        semester=str(d.get("semester", "")),
        day_of_week=str(d.get("day_of_week", "")),
        subject_code=str(d.get("subject_code", "")),
        subject_name=str(d.get("subject_name", "")),
        start_time=str(d.get("start_time", "")),
        end_time=str(d.get("end_time", "")),
        faculty_name=str(d.get("faculty_name") or ""),
        faculty_user_id=d.get("faculty_user_id"),
        room_number=str(d.get("room_number", "")),
        is_demo=bool(d.get("is_demo", False)),
    )


def build_timetable(
    user: dict,
    context: StudentContext,
    day: str | None,
    department: str | None = None,
    semester: int | None = None,
) -> TimetableResponse:
    role = user_role(user)

    if context.demo:
        scope = "demo"
        if context.student is None:
            return TimetableResponse(linked=False, is_demo=True, scope=scope,
                                     message="Demo data is not available.",
                                     student=None, day=day, entries=[])
        query: dict = {
            "department": context.student.get("department"),
            "semester": _semester_value(context.student.get("semester")),
            "is_demo": True,
        }
        linked = False
    elif role == "student":
        scope = "student"
        if context.student is None:
            return TimetableResponse(linked=False, is_demo=False, scope=scope,
                                     message=NOT_LINKED_MESSAGE, student=None, day=day, entries=[])
        query = {
            "department": context.student.get("department"),
            "semester": _semester_value(context.student.get("semester")),
            **visible_academic_filter(context.student),
        }
        linked = True
    else:
        scope = role
        linked = True
        query = visible_academic_filter(user)
        if role == "faculty":
            query["$or"] = [
                {"faculty_user_id": str(user["_id"])},
                {"subject_code": {"$in": assigned_subjects(user)}},
            ]
        if department:
            query["department"] = department
        if semester is not None:
            query["semester"] = semester

    if day is not None:
        query["day_of_week"] = day

    docs = list(timetable_collection.find(query))
    docs.sort(key=lambda d: (DAYS.index(d["day_of_week"]) if d.get("day_of_week") in DAYS else 99,
                             d.get("start_time", "")))
    entries = [to_entry(d) for d in docs]
    is_demo = context.demo or any(e.is_demo for e in entries)

    message = None
    if not entries:
        if day:
            message = f"No classes on {day}."
        elif scope == "student":
            message = "No official timetable has been published yet."
        else:
            message = "No timetable entries yet."
    elif is_demo:
        message = "DEMO DATA: sample timetable for demonstration, not the official schedule."

    return TimetableResponse(
        linked=linked,
        is_demo=is_demo,
        scope=scope,
        message=message,
        student=context.info() if scope in ("student", "demo") else None,
        day=day,
        entries=entries,
    )


def _find_entry(entry_id: str) -> dict:
    try:
        oid = ObjectId(entry_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail="Timetable entry not found")
    entry = timetable_collection.find_one({"_id": oid})
    if entry is None:
        raise HTTPException(status_code=404, detail="Timetable entry not found")
    if entry.get("is_demo"):
        raise HTTPException(status_code=409, detail="Demo timetable entries are read-only")
    return entry


def _ensure_subject_allowed(user: dict, subject_code: str) -> None:
    if user_role(user) != "admin" and subject_code not in assigned_subjects(user):
        raise HTTPException(
            status_code=403,
            detail=f"You are not assigned to subject {subject_code}. Ask an admin to assign it.",
        )


def _prepare_document(data: TimetableInput, user: dict) -> dict:
    _ensure_subject_allowed(user, data.subject_code)
    doc = build_timetable_document(data)

    if user_role(user) == "faculty":
        # Faculty always schedule themselves.
        doc["faculty_user_id"] = str(user["_id"])
        doc["faculty_name"] = user.get("name", "")
    elif data.faculty_user_id:
        try:
            faculty = users_collection.find_one(
                {"_id": ObjectId(data.faculty_user_id), "role": "faculty"}, {"name": 1}
            )
        except (InvalidId, TypeError):
            faculty = None
        if faculty is None:
            raise HTTPException(status_code=422, detail="faculty_user_id is not a faculty account")
        doc["faculty_name"] = data.faculty_name or faculty.get("name", "")
    elif not data.faculty_name:
        raise HTTPException(status_code=422, detail="faculty_name is required")

    doc["updated_at"] = datetime.now(timezone.utc)
    return doc


def _check_conflicts(doc: dict, exclude_id: ObjectId | None = None) -> None:
    """Rejects overlapping official classes for the same class group, room or faculty."""
    query: dict = {
        "is_demo": {"$ne": True},
        "day_of_week": doc["day_of_week"],
        "start_time": {"$lt": doc["end_time"]},
        "end_time": {"$gt": doc["start_time"]},
    }
    clashes = [
        {"department": doc["department"], "semester": doc["semester"]},
        {"room_number": doc["room_number"]},
    ]
    if doc.get("faculty_user_id"):
        clashes.append({"faculty_user_id": doc["faculty_user_id"]})
    query["$or"] = clashes
    if exclude_id is not None:
        query["_id"] = {"$ne": exclude_id}

    other = timetable_collection.find_one(query)
    if other is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Schedule conflict with {other.get('subject_code')} "
                f"({other.get('start_time')}-{other.get('end_time')}, room {other.get('room_number')}, "
                f"{other.get('department')} sem {other.get('semester')}) on {doc['day_of_week']}"
            ),
        )


@router.get("", response_model=TimetableResponse)
def get_timetable(
    day: str | None = Query(None, max_length=9, description="Only return classes for this day"),
    department: str | None = Query(None, max_length=50, description="Faculty/admin filter"),
    semester: int | None = Query(None, ge=1, le=12, description="Faculty/admin filter"),
    context: StudentContext = Depends(get_student_context),
    user: dict = Depends(get_current_user),
):
    """Timetable for the signed-in user (Monday-Saturday).

    - Students: their linked class group (department + semester).
    - Faculty: classes they teach or for subjects assigned to them.
    - Admin: all official entries (optionally filtered).
    - `?demo=true`: the clearly-labelled demo timetable.
    """
    if day is not None and day not in DAYS and day != "Sunday":
        raise HTTPException(status_code=422, detail="day is invalid")
    return build_timetable(user, context, day, department, semester)


@router.get("/today", response_model=TimetableResponse)
def get_today_timetable(
    context: StudentContext = Depends(get_student_context),
    user: dict = Depends(get_current_user),
):
    """Today's classes in Asia/Kolkata. Sunday returns no classes."""
    from services.assistant_service import KOLKATA

    return build_timetable(user, context, datetime.now(KOLKATA).strftime("%A"))


@router.post("", response_model=TimetableEntry, status_code=201)
def create_timetable_entry(data: TimetableInput, user: dict = Depends(staff_only)):
    """Adds a class (faculty: assigned subjects only, scheduled as themselves).
    Overlapping classes for the same class group, room or faculty are rejected."""
    doc = _prepare_document(data, user)
    _check_conflicts(doc)
    try:
        result = timetable_collection.insert_one(doc)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="A class already starts at this time for this group")
    doc["_id"] = result.inserted_id
    return to_entry(doc)


@router.put("/{entry_id}", response_model=TimetableEntry)
def update_timetable_entry(entry_id: str, data: TimetableInput, user: dict = Depends(staff_only)):
    """Updates an official class. Demo entries are read-only."""
    existing = _find_entry(entry_id)
    _ensure_subject_allowed(user, existing.get("subject_code", ""))
    doc = _prepare_document(data, user)
    _check_conflicts(doc, exclude_id=existing["_id"])
    try:
        timetable_collection.update_one({"_id": existing["_id"]}, {"$set": doc})
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="A class already starts at this time for this group")
    doc["_id"] = existing["_id"]
    return to_entry(doc)


@router.delete("/{entry_id}", status_code=204)
def delete_timetable_entry(entry_id: str, user: dict = Depends(staff_only)):
    """Removes an official class. Demo entries are read-only."""
    existing = _find_entry(entry_id)
    _ensure_subject_allowed(user, existing.get("subject_code", ""))
    timetable_collection.delete_one({"_id": existing["_id"]})
    return Response(status_code=204)
