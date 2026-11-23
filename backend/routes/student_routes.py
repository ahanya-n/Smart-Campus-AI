import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from pymongo import ReturnDocument
from pymongo.collation import Collation
from pymongo.errors import DuplicateKeyError
from bson import ObjectId

from database import database
from dependencies.student import find_linked_student
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
attendance_collection = database["attendance"]
attendance_entries_collection = database["attendance_entries"]
marks_collection = database["marks"]
assignments_collection = database["assignments"]
notifications_collection = database["notifications"]
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
STUDENT_DEPARTMENTS = {"MCA", "MBA", "B.Tech"}
KOLKATA = timezone(timedelta(hours=5, minutes=30), name="Asia/Kolkata")


def json_safe(value: Any) -> Any:
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [json_safe(item) for item in value]
    return value


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
    return json_safe({
        "$and": [
            {"$or": list(groups.values())},
            student_filter,
        ]
    })


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

    return json_safe({
        "message": "Student added successfully",
        "id": str(result.inserted_id),
        "student_id": document["student_id"],
    })


@router.get("/assignments/me")
def get_student_assignments(user: dict = Depends(require_roles("student"))):
    student = find_linked_student(user)
    if student is None:
        raise HTTPException(status_code=404, detail="Student profile not found")
    student_id = str(student["student_id"])
    items = list(assignments_collection.find(
        {"student_id": student_id, **visible_academic_filter(user)},
        {"_id": 0},
    ).sort("due_date", 1).limit(100))
    return json_safe({
        "total": len(items),
        "pending": sum(1 for item in items if item.get("status") != "submitted"),
        "submitted": sum(1 for item in items if item.get("status") == "submitted"),
        "items": items,
    })


@router.get("/dashboard/me")
def get_student_dashboard(user: dict = Depends(require_roles("student"))):
    student = find_linked_student(user)
    if student is None:
        raise HTTPException(
            status_code=404,
            detail="Student profile not found",
        )

    student_id = str(student["student_id"])
    academic_filter = visible_academic_filter(user)
    attendance_records = list(attendance_collection.find(
        {"student_id": student_id, **academic_filter},
        {"_id": 0},
    ))
    timetable_records = list(timetable_collection.find(
        {
            "department": student.get("department"),
            "semester": student.get("semester"),
            "$or": [
                {"section": student.get("section")},
                {"section": {"$exists": False}},
            ],
            **academic_filter,
        },
        {"_id": 0},
    ))
    marks = list(marks_collection.find(
        {"student_id": student_id, **academic_filter},
        {"_id": 0},
    ))
    assignment_records = list(assignments_collection.find(
        {"student_id": student_id, **academic_filter},
        {"_id": 0},
    ).sort("due_date", 1).limit(50))
    notification_records = list(notifications_collection.find(
        {"student_id": student_id, **academic_filter},
        {"_id": 0},
    ).sort("created_at", -1).limit(10))
    library_loans = list(database["book_loans"].find(
        {"user_id": user["_id"]},
        {"_id": 0},
    ).sort("borrowed_at", -1).limit(10))

    total_classes = sum(int(record.get("total_classes", 0) or 0) for record in attendance_records)
    present_classes = sum(int(record.get("present_classes", 0) or 0) for record in attendance_records)
    attendance_percentage = (
        round((present_classes / total_classes) * 100, 2)
        if total_classes > 0
        else None
    )

    subject_scores: dict[str, list[float]] = {}
    for mark in marks:
        code = str(mark.get("subject_code", "")).strip()
        score = mark.get("score")
        max_score = mark.get("max_score")
        if not code or not isinstance(score, (int, float)) or not isinstance(max_score, (int, float)):
            continue
        if isinstance(score, bool) or isinstance(max_score, bool) or max_score <= 0:
            continue
        subject_scores.setdefault(code, []).append((float(score) / float(max_score)) * 100)
    subject_percentages = [
        sum(scores) / len(scores)
        for scores in subject_scores.values()
    ]
    cgpa = (
        round((sum(subject_percentages) / len(subject_percentages) / 10), 2)
        if subject_percentages
        else None
    )

    weekdays = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
    today = weekdays[datetime.now(KOLKATA).weekday()]
    today_entries = sorted(
        [
            entry for entry in timetable_records
            if str(entry.get("day_of_week", "")) == today
        ],
        key=lambda entry: str(entry.get("start_time", "")),
    )

    submitted = sum(
        1 for assignment in assignment_records
        if assignment.get("status") == "submitted"
    )
    pending = sum(
        1 for assignment in assignment_records
        if assignment.get("status") != "submitted"
    )
    upcoming = [
        {
            **assignment,
            "due_date": (
                assignment["due_date"].isoformat()
                if isinstance(assignment.get("due_date"), datetime)
                else str(assignment.get("due_date") or "")
            ),
        }
        for assignment in assignment_records
        if assignment.get("status") != "submitted"
    ]

    streak = 0
    present_dates = sorted(
        {
            str(entry.get("session_date", ""))[:10]
            for entry in attendance_entries_collection.find(
                {"student_id": student_id, "status": "present", **academic_filter},
                {"session_date": 1, "_id": 0},
            )
            if entry.get("session_date")
        },
        reverse=True,
    )
    cursor = date.today()
    date_strings = set(present_dates)
    while cursor.isoformat() in date_strings:
        streak += 1
        cursor = cursor.fromordinal(cursor.toordinal() - 1)

    return json_safe({
        "profile": {
            "name": student.get("name", ""),
            "email": student.get("email", ""),
            "student_id": student_id,
            "roll_number": student.get("registration_number") or student.get("student_id"),
            "department": student.get("department", ""),
            "course": student.get("course") or student.get("department", ""),
            "semester": student.get("semester"),
            "section": student.get("section", ""),
            "avatar_url": student.get("avatar_url"),
        },
        "attendance": {
            "percentage": attendance_percentage,
            "present_classes": present_classes,
            "total_classes": total_classes,
            "subject_count": len(attendance_records),
            "records": attendance_records,
        },
        "cgpa": cgpa,
        "study_streak": streak,
        "timetable": {
            "today": weekdays[datetime.now(KOLKATA).weekday()],
            "entries": today_entries,
        },
        "marks": marks,
        "assignments": {
            "total": len(assignment_records),
            "pending": pending,
            "submitted": submitted,
            "upcoming": upcoming[:6],
        },
        "notifications": notification_records,
        "library_loans": library_loans,
        "is_demo": bool(
            student.get("is_demo") or student.get("synthetic_demo")
        ),
    })


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
