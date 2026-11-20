from datetime import date, datetime, timedelta, timezone
from typing import Literal

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator, model_validator

from database import attendance_collection, attendance_entries_collection, students_collection
from dependencies.auth import assigned_subjects, require_roles, user_role
from dependencies.student import (
    NOT_LINKED_MESSAGE,
    StudentContext,
    StudentInfo,
    get_student_context,
    student_info,
)
from services.data_filters import (
    is_local_demo_account,
    is_local_demo_student,
    visible_academic_filter,
)
from validators import CODE_PATTERN, TIME_PATTERN

router = APIRouter(prefix="/attendance", tags=["Attendance"])

LOW_ATTENDANCE_THRESHOLD = 75.0

staff_only = require_roles("faculty", "admin")

AttendanceStatus = Literal["present", "absent"]


# ---------- Models ----------

class AttendanceInput(BaseModel):
    """Totals for one student in one subject. Absent count and percentage are
    always calculated, never accepted from the client."""

    student_id: str = Field(min_length=1, max_length=50)
    subject_code: str = Field(min_length=1, max_length=20)
    subject_name: str = Field(min_length=1, max_length=120)
    total_classes: int = Field(gt=0, le=1000, description="Must be positive")
    present_classes: int = Field(ge=0, description="Cannot exceed total_classes")

    @model_validator(mode="after")
    def present_not_more_than_total(self):
        if self.present_classes > self.total_classes:
            raise ValueError("present_classes cannot exceed total_classes")
        return self


class AttendanceRecord(BaseModel):
    student_id: str
    subject_code: str
    subject_name: str
    total_classes: int
    present_classes: int
    absent_classes: int
    attendance_percentage: float
    low_attendance: bool
    is_demo: bool
    updated_at: datetime | None


class StaffAttendanceRecord(AttendanceRecord):
    student_name: str = ""


class AttendanceSummary(BaseModel):
    total_classes: int
    present_classes: int
    absent_classes: int
    attendance_percentage: float
    subject_count: int
    low_attendance_subjects: list[str]
    threshold: float = LOW_ATTENDANCE_THRESHOLD


class AttendanceSummaryResponse(BaseModel):
    linked: bool
    is_demo: bool
    message: str | None
    student: StudentInfo | None
    summary: AttendanceSummary


class AttendanceReport(AttendanceSummaryResponse):
    records: list[AttendanceRecord]


class AttendanceMark(BaseModel):
    student_id: str = Field(min_length=1, max_length=50)
    status: AttendanceStatus


class AttendanceSessionInput(BaseModel):
    """Marks for one class session. Re-submitting the same session updates
    the existing marks instead of creating duplicates."""

    subject_code: str = Field(pattern=CODE_PATTERN)
    subject_name: str = Field(min_length=1, max_length=120)
    session_date: date
    start_time: str = Field(pattern=TIME_PATTERN, description="24-hour HH:MM")
    records: list[AttendanceMark] = Field(min_length=1, max_length=500)

    @field_validator("subject_code")
    @classmethod
    def upper_code(cls, value: str) -> str:
        return value.upper()

    @field_validator("session_date")
    @classmethod
    def date_in_range(cls, value: date) -> date:
        today = date.today()
        if value > today:
            raise ValueError("session_date cannot be in the future")
        if value < today - timedelta(days=366):
            raise ValueError("session_date cannot be more than a year ago")
        return value

    @model_validator(mode="after")
    def no_duplicate_students(self):
        ids = [r.student_id for r in self.records]
        if len(ids) != len(set(ids)):
            raise ValueError("Each student can only appear once per session")
        return self


class AttendanceSessionResult(BaseModel):
    subject_code: str
    session_date: date
    start_time: str
    created: int
    updated: int
    unchanged: int


class AttendanceEntry(BaseModel):
    id: str
    student_id: str
    student_name: str
    subject_code: str
    subject_name: str
    session_date: date
    start_time: str
    status: AttendanceStatus
    recorded_by_name: str
    updated_at: datetime | None


class StatusUpdate(BaseModel):
    status: AttendanceStatus


# ---------- Helpers ----------

def percentage(present: int, total: int) -> float:
    return round(present / total * 100, 2) if total > 0 else 0.0


def build_attendance_document(data: AttendanceInput, is_demo: bool = False) -> dict:
    """The aggregate document stored in MongoDB, with derived fields kept consistent."""
    return {
        "student_id": data.student_id,
        "subject_code": data.subject_code,
        "subject_name": data.subject_name,
        "total_classes": data.total_classes,
        "present_classes": data.present_classes,
        "absent_classes": data.total_classes - data.present_classes,
        "attendance_percentage": percentage(data.present_classes, data.total_classes),
        "updated_at": datetime.now(timezone.utc),
        "is_demo": is_demo,
    }


def to_record(doc: dict, model=AttendanceRecord, **extra):
    # Derived values are recalculated on read so responses stay consistent
    # even if a document was edited by hand in Compass.
    total = max(int(doc.get("total_classes", 0)), 0)
    present = min(max(int(doc.get("present_classes", 0)), 0), total)
    pct = percentage(present, total)
    return model(
        student_id=str(doc.get("student_id", "")),
        subject_code=str(doc.get("subject_code", "")),
        subject_name=str(doc.get("subject_name", "")),
        total_classes=total,
        present_classes=present,
        absent_classes=total - present,
        attendance_percentage=pct,
        low_attendance=pct < LOW_ATTENDANCE_THRESHOLD,
        is_demo=bool(doc.get("is_demo", False)),
        updated_at=doc.get("updated_at"),
        **extra,
    )


def summarize(records: list[AttendanceRecord]) -> AttendanceSummary:
    total = sum(r.total_classes for r in records)
    present = sum(r.present_classes for r in records)
    return AttendanceSummary(
        total_classes=total,
        present_classes=present,
        absent_classes=total - present,
        attendance_percentage=percentage(present, total),
        subject_count=len(records),
        low_attendance_subjects=[r.subject_name for r in records if r.low_attendance],
    )


def make_report(student: dict | None, query: dict | None, *, linked: bool, demo: bool) -> AttendanceReport:
    if query is None:
        return AttendanceReport(
            linked=False,
            is_demo=demo,
            message=NOT_LINKED_MESSAGE if not demo else "Demo data is not available.",
            student=None,
            summary=summarize([]),
            records=[],
        )

    docs = attendance_collection.find(query, {"_id": 0}).sort("subject_code", 1)
    records = [to_record(doc) for doc in docs]
    is_demo = demo or any(r.is_demo for r in records)

    message = None
    if not records:
        message = "No official attendance has been recorded yet."
    elif is_demo:
        message = "DEMO DATA: sample records for demonstration, not official attendance."

    return AttendanceReport(
        linked=linked,
        is_demo=is_demo,
        message=message,
        student=student_info(student),
        summary=summarize(records),
        records=records,
    )


def build_report(context: StudentContext) -> AttendanceReport:
    return make_report(context.student, context.record_filter(), linked=context.linked, demo=context.demo)


def ensure_can_manage_subject(user: dict, subject_code: str) -> None:
    if user_role(user) == "admin":
        return
    if subject_code.upper() not in assigned_subjects(user):
        raise HTTPException(
            status_code=403,
            detail=f"You are not assigned to subject {subject_code}. Ask an admin to assign it.",
        )


def recompute_aggregate(student_id: str, subject_code: str, subject_name: str) -> None:
    """Rebuilds the official per-subject totals from the session marks.
    Demo aggregates are never touched (is_demo is part of the key)."""
    base = {"student_id": student_id, "subject_code": subject_code}
    total = attendance_entries_collection.count_documents(base)
    if total == 0:
        return
    present = attendance_entries_collection.count_documents({**base, "status": "present"})

    doc = build_attendance_document(
        AttendanceInput(
            student_id=student_id,
            subject_code=subject_code,
            subject_name=subject_name,
            total_classes=total,
            present_classes=present,
        ),
        is_demo=False,
    )
    key = {**base, "is_demo": False}
    attendance_collection.update_one(
        key, {"$set": {k: v for k, v in doc.items() if k not in key}}, upsert=True
    )


def student_names(student_ids) -> dict[str, str]:
    ids = list(set(student_ids))
    return {
        s["student_id"]: str(s.get("name", ""))
        for s in students_collection.find({"student_id": {"$in": ids}}, {"student_id": 1, "name": 1})
    }


def to_entry(doc: dict, names: dict[str, str]) -> AttendanceEntry:
    return AttendanceEntry(
        id=str(doc["_id"]),
        student_id=doc["student_id"],
        student_name=names.get(doc["student_id"], ""),
        subject_code=doc["subject_code"],
        subject_name=doc.get("subject_name", ""),
        session_date=date.fromisoformat(doc["session_date"]),
        start_time=doc["start_time"],
        status=doc["status"],
        recorded_by_name=doc.get("recorded_by_name", ""),
        updated_at=doc.get("updated_at"),
    )


# ---------- Student endpoints ----------

@router.get("/me", response_model=AttendanceReport)
def get_my_attendance(context: StudentContext = Depends(get_student_context)):
    """Official subject-wise attendance for the signed-in student's linked record.

    If your account is not linked, `linked` is false and no records are returned.
    Add `?demo=true` to view the clearly-labelled demo records.
    """
    return build_report(context)


@router.get("/summary", response_model=AttendanceSummaryResponse)
def get_attendance_summary(context: StudentContext = Depends(get_student_context)):
    """Overall attendance totals (or demo data with `?demo=true`)."""
    report = build_report(context)
    return AttendanceSummaryResponse(**report.model_dump(exclude={"records"}))


# ---------- Faculty / admin endpoints ----------

@router.post("/sessions", response_model=AttendanceSessionResult)
def record_session(data: AttendanceSessionInput, user: dict = Depends(staff_only)):
    """Records attendance for one class session (faculty: assigned subjects only).

    Each student has at most one mark per subject, date and start time;
    sending the same session again updates the marks.
    """
    ensure_can_manage_subject(user, data.subject_code)

    ids = [r.student_id for r in data.records]
    names = student_names(ids)
    unknown = [i for i in ids if i not in names]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown student IDs: {', '.join(unknown)}")

    now = datetime.now(timezone.utc)
    created = updated = unchanged = 0
    for mark in data.records:
        key = {
            "student_id": mark.student_id,
            "subject_code": data.subject_code,
            "session_date": data.session_date.isoformat(),
            "start_time": data.start_time,
        }
        existing = attendance_entries_collection.find_one(key, {"status": 1})
        if existing is not None and existing.get("status") == mark.status:
            unchanged += 1
            continue

        attendance_entries_collection.update_one(
            key,
            {
                "$set": {
                    "status": mark.status,
                    "subject_name": data.subject_name,
                    "updated_at": now,
                    "recorded_by": str(user["_id"]),
                    "recorded_by_name": user.get("name", ""),
                },
                "$setOnInsert": {"created_at": now},
            },
            upsert=True,
        )
        if existing is None:
            created += 1
        else:
            updated += 1
        recompute_aggregate(mark.student_id, data.subject_code, data.subject_name)

    return AttendanceSessionResult(
        subject_code=data.subject_code,
        session_date=data.session_date,
        start_time=data.start_time,
        created=created,
        updated=updated,
        unchanged=unchanged,
    )


@router.get("/sessions", response_model=list[AttendanceEntry])
def get_session(
    subject_code: str = Query(..., pattern=CODE_PATTERN),
    session_date: date = Query(...),
    start_time: str | None = Query(None, pattern=TIME_PATTERN),
    user: dict = Depends(staff_only),
):
    """Marks already recorded for a subject on a date (faculty: assigned subjects only)."""
    subject_code = subject_code.upper()
    ensure_can_manage_subject(user, subject_code)

    query: dict = {"subject_code": subject_code, "session_date": session_date.isoformat()}
    if start_time:
        query["start_time"] = start_time
    docs = list(attendance_entries_collection.find(query).sort([("start_time", 1), ("student_id", 1)]))
    names = student_names(d["student_id"] for d in docs)
    return [to_entry(d, names) for d in docs]


@router.patch("/entries/{entry_id}", response_model=AttendanceEntry)
def update_entry(entry_id: str, data: StatusUpdate, user: dict = Depends(staff_only)):
    """Changes one recorded mark (faculty: assigned subjects only)."""
    try:
        oid = ObjectId(entry_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail="Attendance entry not found")

    entry = attendance_entries_collection.find_one({"_id": oid})
    if entry is None:
        raise HTTPException(status_code=404, detail="Attendance entry not found")
    ensure_can_manage_subject(user, entry["subject_code"])

    attendance_entries_collection.update_one(
        {"_id": oid},
        {"$set": {
            "status": data.status,
            "updated_at": datetime.now(timezone.utc),
            "recorded_by": str(user["_id"]),
            "recorded_by_name": user.get("name", ""),
        }},
    )
    recompute_aggregate(entry["student_id"], entry["subject_code"], entry.get("subject_name", ""))

    updated = attendance_entries_collection.find_one({"_id": oid})
    return to_entry(updated, student_names([updated["student_id"]]))


@router.get("/records", response_model=list[StaffAttendanceRecord])
def list_records(
    subject_code: str | None = Query(None, pattern=CODE_PATTERN),
    student_id: str | None = Query(None, max_length=50),
    include_demo: bool = Query(False, description="Also return demo records (labelled is_demo)"),
    user: dict = Depends(staff_only),
):
    """Per-subject attendance totals. Faculty only see their assigned subjects."""
    query: dict = {}
    if is_local_demo_account(user):
        query.update(visible_academic_filter(user))
    elif not include_demo:
        query["is_demo"] = {"$ne": True}

    if subject_code:
        subject_code = subject_code.upper()
        ensure_can_manage_subject(user, subject_code)
        query["subject_code"] = subject_code
    elif user_role(user) != "admin":
        query["subject_code"] = {"$in": assigned_subjects(user)}

    if student_id:
        query["student_id"] = student_id

    docs = list(attendance_collection.find(query, {"_id": 0})
                .sort([("subject_code", 1), ("student_id", 1)]).limit(1000))
    names = student_names(d.get("student_id") for d in docs)
    return [
        to_record(d, StaffAttendanceRecord, student_name=names.get(d.get("student_id"), ""))
        for d in docs
    ]


@router.get("/students/{student_id}", response_model=AttendanceReport)
def get_student_attendance(student_id: str, user: dict = Depends(staff_only)):
    """Official attendance report for one student (faculty: assigned subjects only)."""
    student = students_collection.find_one({"student_id": student_id}, {"_id": 0})
    if student is None:
        raise HTTPException(status_code=404, detail=f"Student {student_id} not found")

    query: dict = {"student_id": student_id, "is_demo": {"$ne": True}}
    if user_role(user) != "admin":
        query["subject_code"] = {"$in": assigned_subjects(user)}
        if is_local_demo_account(user) and is_local_demo_student(student):
            query.update(visible_academic_filter(user))
    return make_report(student, query, linked=True, demo=False)
