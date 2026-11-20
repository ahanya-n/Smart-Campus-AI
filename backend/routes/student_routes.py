import re
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from pymongo import ReturnDocument
from pymongo.collation import Collation
from pymongo.errors import DuplicateKeyError

from database import database
from dependencies.auth import assigned_subjects, get_current_user, require_roles, user_role
from services.data_filters import (
    LOCAL_DEMO_SEED_MARKER,
    is_local_demo_account,
    non_synthetic_filter,
    visible_academic_filter,
)

router = APIRouter(tags=["Students"])

students_collection = database["students"]
timetable_collection = database["timetable"]
student_id_counters = database["counters"]
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
STUDENT_DEPARTMENTS = {"MCA", "MBA", "B.Tech"}


class StudentInput(BaseModel):
    student_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=50,
        pattern=r"^[A-Za-z0-9-]+$",
    )
    name: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    department: str
    semester: int = Field(ge=1, le=3)

    @field_validator("student_id", "name", "email", "department")
    @classmethod
    def strip_strings(cls, value: str | None) -> str | None:
        return value.strip() if isinstance(value, str) else value

    @field_validator("name")
    @classmethod
    def require_name(cls, value: str) -> str:
        if not value:
            raise ValueError("name cannot be blank")
        return value

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        value = value.lower()
        if not EMAIL_PATTERN.fullmatch(value):
            raise ValueError("email must be a valid email address")
        return value

    @field_validator("department")
    @classmethod
    def validate_department(cls, value: str) -> str:
        if value not in STUDENT_DEPARTMENTS:
            raise ValueError("department must be MCA, MBA, or B.Tech")
        return value


def generate_student_id(department: str) -> str:
    department_code = department.replace(".", "").upper()
    prefix = f"{date.today().year}0{department_code}"
    pattern = re.compile(rf"^{re.escape(prefix)}(\d+)$")
    existing_ids = students_collection.find(
        {"student_id": {"$regex": rf"^{re.escape(prefix)}\d+$"}},
        {"student_id": 1},
    )
    max_sequence = max(
        (
            int(match.group(1))
            for record in existing_ids
            if (match := pattern.match(record.get("student_id", "")))
        ),
        default=0,
    )
    counter_key = {"_id": f"student_id:{prefix}"}
    student_id_counters.update_one(
        counter_key,
        {"$max": {"value": max_sequence}},
        upsert=True,
    )
    counter = student_id_counters.find_one_and_update(
        counter_key,
        {"$inc": {"value": 1}},
        return_document=ReturnDocument.AFTER,
    )
    return f"{prefix}{counter['value']:04d}"


def _faculty_group_filter(user: dict) -> dict | None:
    subjects = [
        code.strip().upper()
        for code in assigned_subjects(user)
        if code.strip()
    ]
    faculty_id = str(user.get("_id", ""))
    classes = timetable_collection.find(
        {
            **visible_academic_filter(user),
            "$or": [
                {"faculty_user_id": faculty_id},
                {
                    "$and": [
                        {
                            "$or": [
                                {"faculty_user_id": None},
                                {"faculty_user_id": {"$exists": False}},
                            ]
                        },
                        {"subject_code": {"$in": subjects}},
                    ]
                },
            ],
        },
        {"_id": 0, "department": 1, "semester": 1},
    )

    groups = {}
    for entry in classes:
        department = entry.get("department")
        semester = entry.get("semester")
        if not isinstance(department, str) or not department.strip() or semester is None:
            continue
        if isinstance(semester, bool):
            continue
        semester_text = str(semester).strip()
        if not semester_text:
            continue
        semester_value = int(semester_text) if semester_text.isdigit() else semester_text
        groups[(department, semester_text)] = {
            "department": department,
            "semester": {
                "$in": [semester_value, semester_text]
                if isinstance(semester_value, int)
                else [semester_value]
            },
        }

    if not groups:
        return None
    student_filter = (
        {"local_demo_seed": LOCAL_DEMO_SEED_MARKER}
        if is_local_demo_account(user)
        else non_synthetic_filter()
    )
    return {
        "$and": [
            {"$or": list(groups.values())},
            student_filter,
        ]
    }


@router.post("/students")
def add_student(student: StudentInput, _admin: dict = Depends(require_roles("admin"))):
    """Adds a student record (admin only)."""
    document = student.model_dump()
    if not document["student_id"]:
        document["student_id"] = generate_student_id(document["department"])

    existing_id = students_collection.find_one(
        {"student_id": document["student_id"]},
        {"_id": 1},
    )
    if existing_id:
        raise HTTPException(status_code=409, detail="Student ID already exists")

    existing_email = students_collection.find_one(
        {"email": document["email"]},
        {"_id": 1},
        collation=Collation(locale="en", strength=2),
    )
    if existing_email:
        raise HTTPException(status_code=409, detail="Student email already exists")

    try:
        result = students_collection.insert_one(document)
    except DuplicateKeyError as error:
        raise HTTPException(
            status_code=409,
            detail="Student ID or email already exists",
        ) from error

    return {
        "message": "Student added successfully",
        "id": str(result.inserted_id),
        "student_id": document["student_id"],
    }


@router.get("/students")
def get_students(user: dict = Depends(get_current_user)):
    role = user_role(user)
    if role == "student":
        student_id = user.get("student_id")
        if not isinstance(student_id, str) or not student_id.strip():
            return []
        query = {"student_id": student_id}
    elif role == "faculty":
        query = _faculty_group_filter(user)
        if query is None:
            return []
    else:
        query = {}

    return list(students_collection.find(query, {"_id": 0}))
