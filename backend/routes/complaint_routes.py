import re
from datetime import datetime, timezone
from typing import Literal

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator

from database import complaints_collection, users_collection
from dependencies.auth import get_current_user, require_roles

router = APIRouter(prefix="/complaints", tags=["Complaints"])

ComplaintCategory = Literal[
    "academic", "facilities", "transport", "library", "safety", "other"
]
ComplaintStatus = Literal["pending", "in_progress", "resolved", "rejected"]
ADMIN = require_roles("admin")
STUDENT = require_roles("student")


class ComplaintCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: ComplaintCategory
    title: str = Field(min_length=3, max_length=120)
    description: str = Field(min_length=10, max_length=5000)

    @field_validator("title", "description")
    @classmethod
    def clean_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


class ComplaintUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: ComplaintStatus | None = None
    assigned_to: str | None = Field(None, min_length=24, max_length=24)
    resolution_notes: str | None = Field(None, max_length=3000)

    @field_validator("assigned_to")
    @classmethod
    def validate_assignee_id(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                ObjectId(value)
            except (InvalidId, TypeError):
                raise ValueError("must be a valid user ID")
        return value

    @field_validator("resolution_notes")
    @classmethod
    def clean_notes(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


class ComplaintResponseInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1, max_length=3000)
    resolution_notes: str | None = Field(None, max_length=3000)

    @field_validator("message", "resolution_notes")
    @classmethod
    def clean_response_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


def _object_id(raw_id: str) -> ObjectId:
    try:
        return ObjectId(raw_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail="Complaint not found")


def _iso(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return str(value)


def _response_output(response: dict) -> dict:
    return {
        "id": str(response.get("_id", "")),
        "author_name": response.get("author_name", ""),
        "author_role": response.get("author_role", ""),
        "message": response.get("message", ""),
        "resolution_notes": response.get("resolution_notes"),
        "created_at": _iso(response.get("created_at")),
    }


def _complaint_output(complaint: dict) -> dict:
    return {
        "id": str(complaint["_id"]),
        "user_id": str(complaint["user_id"]),
        "student_id": complaint.get("student_id"),
        "student_name": complaint.get("student_name", ""),
        "student_email": complaint.get("student_email", ""),
        "category": complaint["category"],
        "title": complaint["title"],
        "description": complaint["description"],
        "status": complaint["status"],
        "assigned_to": (
            str(complaint["assigned_to"]) if complaint.get("assigned_to") else None
        ),
        "assigned_staff_name": complaint.get("assigned_staff_name"),
        "resolution_notes": complaint.get("resolution_notes"),
        "responses": [
            _response_output(item) for item in complaint.get("responses", [])
        ],
        "created_at": _iso(complaint.get("created_at")),
        "updated_at": _iso(complaint.get("updated_at")),
    }


def _find_complaint(complaint_id: str) -> dict:
    complaint = complaints_collection.find_one({"_id": _object_id(complaint_id)})
    if complaint is None:
        raise HTTPException(status_code=404, detail="Complaint not found")
    return complaint


def _student_or_admin_complaint(complaint_id: str, user: dict) -> dict:
    complaint = _find_complaint(complaint_id)
    if user.get("role") != "admin" and complaint["user_id"] != user["_id"]:
        raise HTTPException(status_code=404, detail="Complaint not found")
    return complaint


@router.get("")
def list_complaints(
    status: ComplaintStatus | None = None,
    category: ComplaintCategory | None = None,
    search: str | None = Query(None, max_length=100),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: dict = Depends(get_current_user),
):
    query: dict = {}
    if user.get("role") != "admin":
        if user.get("role") != "student":
            raise HTTPException(status_code=403, detail="Students and admins can view complaints.")
        query["user_id"] = user["_id"]
    if status:
        query["status"] = status
    if category:
        query["category"] = category
    term = search.strip() if search else ""
    if term:
        expression = re.escape(term)
        fields = ["title", "description"]
        if user.get("role") == "admin":
            fields.extend(["student_name", "student_email", "assigned_staff_name"])
        query["$or"] = [{field: {"$regex": expression, "$options": "i"}} for field in fields]

    complaints = list(
        complaints_collection.find(query)
        .sort("created_at", -1)
        .skip(offset)
        .limit(limit)
    )
    return {
        "items": [_complaint_output(item) for item in complaints],
        "total": complaints_collection.count_documents(query),
        "limit": limit,
        "offset": offset,
    }


@router.post("", status_code=201)
def create_complaint(
    data: ComplaintCreate,
    user: dict = Depends(STUDENT),
):
    now = datetime.now(timezone.utc)
    document = {
        "user_id": user["_id"],
        "student_id": user.get("student_id"),
        "student_name": user.get("name", ""),
        "student_email": user.get("email", ""),
        **data.model_dump(),
        "status": "pending",
        "assigned_to": None,
        "assigned_staff_name": None,
        "resolution_notes": None,
        "responses": [],
        "created_at": now,
        "updated_at": now,
    }
    result = complaints_collection.insert_one(document)
    return _complaint_output({**document, "_id": result.inserted_id})


@router.get("/stats")
def complaint_stats(_admin: dict = Depends(ADMIN)):
    return {
        "total": complaints_collection.count_documents({}),
        "pending": complaints_collection.count_documents({"status": "pending"}),
        "in_progress": complaints_collection.count_documents({"status": "in_progress"}),
        "resolved": complaints_collection.count_documents({"status": "resolved"}),
        "rejected": complaints_collection.count_documents({"status": "rejected"}),
    }


@router.get("/{complaint_id}")
def get_complaint(complaint_id: str, user: dict = Depends(get_current_user)):
    return _complaint_output(_student_or_admin_complaint(complaint_id, user))


@router.patch("/{complaint_id}")
def update_complaint(
    complaint_id: str,
    data: ComplaintUpdate,
    _admin: dict = Depends(ADMIN),
):
    changes = data.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail="At least one complaint field is required")
    complaint = _find_complaint(complaint_id)
    if "assigned_to" in changes:
        assignee_id = changes["assigned_to"]
        if assignee_id is None:
            changes["assigned_staff_name"] = None
        else:
            staff = users_collection.find_one(
                {"_id": ObjectId(assignee_id), "role": {"$in": ["faculty", "admin"]}},
                {"name": 1},
            )
            if staff is None:
                raise HTTPException(status_code=422, detail="Assignee must be a faculty or admin account")
            changes["assigned_staff_name"] = staff.get("name", "")
            changes["assigned_to"] = staff["_id"]
    changes["updated_at"] = datetime.now(timezone.utc)
    result = complaints_collection.update_one(
        {"_id": complaint["_id"], "updated_at": complaint.get("updated_at")},
        {"$set": changes},
    )
    if result.matched_count != 1:
        raise HTTPException(status_code=409, detail="Complaint changed during update. Please retry.")
    return _complaint_output({**complaint, **changes})


@router.post("/{complaint_id}/responses", status_code=201)
def add_complaint_response(
    complaint_id: str,
    data: ComplaintResponseInput,
    admin: dict = Depends(ADMIN),
):
    complaint = _find_complaint(complaint_id)
    now = datetime.now(timezone.utc)
    response = {
        "_id": ObjectId(),
        "author_id": admin["_id"],
        "author_name": admin.get("name", ""),
        "author_role": "admin",
        **data.model_dump(),
        "created_at": now,
    }
    updates = {"updated_at": now}
    if data.resolution_notes is not None:
        updates["resolution_notes"] = data.resolution_notes
    result = complaints_collection.update_one(
        {"_id": complaint["_id"], "updated_at": complaint.get("updated_at")},
        {"$push": {"responses": response}, "$set": updates},
    )
    if result.matched_count != 1:
        raise HTTPException(status_code=409, detail="Complaint changed during update. Please retry.")
    return _response_output(response)
