from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from database import users_collection
from dependencies.auth import require_roles
from services.link_codes import issue_code
from services.user_service import (
    UserError,
    create_user,
    link_student,
    public_user,
    set_assigned_subjects,
    set_role,
)
from validators import Role

router = APIRouter(prefix="/admin", tags=["Admin"])

admin_only = require_roles("admin")


class AdminUser(BaseModel):
    id: str
    name: str
    email: str
    role: str
    student_id: str | None = None
    registration_number: str | None = None
    faculty_id: str | None = None
    department: str | None = None
    designation: str | None = None
    assigned_subject_codes: list[str] = []
    assigned_class_ids: list[str] = []


class CreateUserRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=128)
    role: Role


class RoleUpdate(BaseModel):
    role: Role


class SubjectsUpdate(BaseModel):
    subject_codes: list[str] = Field(max_length=50)


class StudentLinkUpdate(BaseModel):
    student_id: str | None = Field(None, max_length=50, description="null to unlink")


class LinkCodeResponse(BaseModel):
    student_id: str
    link_code: str
    expires_at: datetime
    note: str = "Give this code only to the student in person. It is shown once."


def _run(action):
    try:
        return action()
    except UserError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.get("/users", response_model=list[AdminUser])
def list_users(_admin: dict = Depends(admin_only)):
    """All accounts (no password hashes)."""
    users = users_collection.find({}, {"password": 0}).sort("name", 1)
    return [public_user(u) for u in users]


@router.post("/users", response_model=AdminUser, status_code=201)
def create_account(data: CreateUserRequest, _admin: dict = Depends(admin_only)):
    """Creates a student, faculty or admin account with an initial password."""
    return _run(lambda: create_user(data.name, data.email, data.password, data.role))


@router.patch("/users/{user_id}/role", response_model=AdminUser)
def change_role(user_id: str, data: RoleUpdate, admin: dict = Depends(admin_only)):
    """Changes a user's role. You cannot remove your own admin role or the last admin."""
    return _run(lambda: set_role(user_id, data.role, acting_user_id=str(admin["_id"])))


@router.put("/users/{user_id}/subjects", response_model=AdminUser)
def assign_subjects(user_id: str, data: SubjectsUpdate, _admin: dict = Depends(admin_only)):
    """Sets the subject codes a faculty member may manage (replaces the list)."""
    return _run(lambda: set_assigned_subjects(user_id, data.subject_codes))


@router.put("/users/{user_id}/student-link", response_model=AdminUser)
def set_student_link(user_id: str, data: StudentLinkUpdate, _admin: dict = Depends(admin_only)):
    """Links a student account to a student record (or unlinks with null)."""
    student_id = data.student_id.strip() if data.student_id else None
    return _run(lambda: link_student(user_id, student_id))


@router.post("/students/{student_id}/link-code", response_model=LinkCodeResponse, status_code=201)
def create_link_code(student_id: str, admin: dict = Depends(admin_only)):
    """Issues a one-time code (valid 7 days) the student uses to link their account."""
    code, expires_at = _run(lambda: issue_code(student_id, issued_by=str(admin["_id"])))
    return LinkCodeResponse(student_id=student_id, link_code=code, expires_at=expires_at)


class StatsResponse(BaseModel):
    total_students: int
    total_faculty: int
    total_subjects: int
    total_classes: int
    total_users: int
    total_attendance_sessions: int
    total_classes_scheduled: int
    total_books: int
    pending_complaints: int


@router.get("/stats", response_model=StatsResponse)
def get_system_stats(_admin: dict = Depends(admin_only)):
    """Summary metrics across campus modules for the admin console."""
    from database import (
        attendance_entries_collection,
        books_collection,
        complaints_collection,
        classes_collection,
        students_collection,
        subjects_collection,
        timetable_collection,
    )

    return StatsResponse(
        total_students=students_collection.count_documents({}),
        total_faculty=users_collection.count_documents({"role": "faculty"}),
        total_subjects=subjects_collection.count_documents({}),
        total_classes=classes_collection.count_documents({}),
        total_users=users_collection.count_documents({}),
        total_attendance_sessions=attendance_entries_collection.count_documents({}),
        total_classes_scheduled=timetable_collection.count_documents({"is_demo": {"$ne": True}}),
        total_books=books_collection.count_documents({}),
        pending_complaints=complaints_collection.count_documents({"status": "pending"}),
    )
