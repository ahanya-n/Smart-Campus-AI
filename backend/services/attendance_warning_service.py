"""Weekly Low Attendance Warning Service.
Identifies subjects where a student's attendance is below 75% threshold.
Ensures warnings are generated once per weekly reporting period without duplicates.
Never uses demo records to generate official warnings.
"""

from datetime import date, datetime, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId
from pymongo.errors import DuplicateKeyError

from database import attendance_collection, notifications_collection, students_collection

DEFAULT_ATTENDANCE_THRESHOLD = 75.0


def current_week_id() -> str:
    """Returns standard ISO week string (e.g. '2026-W42')."""
    today = date.today()
    iso = today.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def check_weekly_low_attendance(
    threshold: float = DEFAULT_ATTENDANCE_THRESHOLD,
    reporting_week: str | None = None,
) -> dict[str, Any]:
    """Scans official attendance records and generates in-app low attendance warnings.
    Prevents duplicate warnings for the same student, subject, and reporting week.
    Skips records with insufficient data (total_classes == 0) or attendance >= threshold.
    """
    week_id = reporting_week or current_week_id()
    now = datetime.now(timezone.utc)
    today_str = date.today().isoformat()

    # Query official attendance records only (never demo)
    records = list(attendance_collection.find({"is_demo": {"$ne": True}}))

    # Preload student names for user-friendly notices
    student_ids = list({r.get("student_id") for r in records if r.get("student_id")})
    student_map = {
        s["student_id"]: s.get("name", s["student_id"])
        for s in students_collection.find({"student_id": {"$in": student_ids}}, {"student_id": 1, "name": 1})
    }

    scanned_count = 0
    generated_count = 0
    duplicate_count = 0
    healthy_count = 0
    skipped_insufficient = 0

    for r in records:
        student_id = r.get("student_id")
        subject_code = r.get("subject_code")
        subject_name = r.get("subject_name", subject_code)
        total_classes = int(r.get("total_classes", 0))
        present_classes = int(r.get("present_classes", 0))

        if not student_id or not subject_code:
            continue

        scanned_count += 1

        # Skip records with insufficient data
        if total_classes <= 0:
            skipped_insufficient += 1
            continue

        pct = round(present_classes / total_classes * 100, 2)

        # Only warn if strictly below the threshold
        if pct >= threshold:
            healthy_count += 1
            continue

        # Check for existing warning for this student, subject, and week
        existing = notifications_collection.find_one({
            "student_id": student_id,
            "subject_code": subject_code,
            "week_id": week_id,
        })

        if existing is not None:
            duplicate_count += 1
            continue

        student_name = student_map.get(student_id, student_id)
        doc = {
            "student_id": student_id,
            "student_name": student_name,
            "subject_code": subject_code,
            "subject_name": subject_name,
            "attendance_percentage": pct,
            "threshold": threshold,
            "total_classes": total_classes,
            "present_classes": present_classes,
            "week_id": week_id,
            "warning_type": "low_attendance",
            "title": f"Low Attendance Warning: {subject_code}",
            "message": (
                f"Your attendance in {subject_name} ({subject_code}) is {pct}%, "
                f"which is below the college minimum requirement of {threshold}%."
            ),
            "reporting_date": today_str,
            "created_at": now,
            "is_read": False,
        }

        try:
            notifications_collection.insert_one(doc)
            generated_count += 1
        except DuplicateKeyError:
            duplicate_count += 1

    return {
        "week_id": week_id,
        "scanned_records": scanned_count,
        "generated_warnings": generated_count,
        "duplicates_skipped": duplicate_count,
        "healthy_records": healthy_count,
        "insufficient_data_skipped": skipped_insufficient,
        "threshold": threshold,
    }


def _notification_output(document: dict[str, Any]) -> dict[str, Any]:
    is_lost_found = (
        document.get("action_type") == "lost_found_claim"
        or document.get("warning_type") == "lost_found_match"
    )
    return {
        "id": str(document["_id"]),
        "student_id": document.get("student_id", ""),
        "subject_code": document.get("subject_code", ""),
        "subject_name": document.get("subject_name", ""),
        "attendance_percentage": document.get("attendance_percentage", 0.0),
        "threshold": document.get("threshold", DEFAULT_ATTENDANCE_THRESHOLD),
        "week_id": document.get("week_id", ""),
        "warning_type": document.get("warning_type", "low_attendance"),
        "title": document.get("title", "Attendance Alert"),
        "message": document.get("message", ""),
        "reporting_date": document.get("reporting_date", ""),
        "created_at": (
            document.get("created_at").isoformat()
            if isinstance(document.get("created_at"), datetime)
            else None
        ),
        "is_read": bool(document.get("is_read", False)),
        "action_type": "lost_found_claim" if is_lost_found else None,
        "claim_id": (
            str(document["claim_id"]) if document.get("claim_id") is not None else None
        ),
        "match_id": (
            str(document["match_id"]) if document.get("match_id") is not None else None
        ),
        "lost_report_id": (
            str(document["lost_report_id"])
            if document.get("lost_report_id") is not None
            else None
        ),
        "found_report_id": (
            str(document["found_report_id"])
            if document.get("found_report_id") is not None
            else None
        ),
    }


def _get_notifications(query: dict[str, Any]) -> list[dict[str, Any]]:
    docs = list(
        notifications_collection.find(query)
        .sort("created_at", -1)
        .limit(100)
    )
    return [_notification_output(document) for document in docs]


def get_student_notifications(student_id: str) -> list[dict[str, Any]]:
    """Returns in-app notifications for a student, newest first."""
    return _get_notifications({"student_id": student_id})


def get_user_notifications(
    student_id: str | None,
    user_id: Any,
) -> list[dict[str, Any]]:
    """Returns notifications addressed to this user or linked student."""
    owners = [{"recipient_user_id": user_id}]
    if student_id:
        owners.append({"student_id": student_id})
    return _get_notifications({"$or": owners})


def mark_notification_read(student_id: str, notification_id: str) -> bool:
    """Marks a student's notification as read."""
    try:
        oid = ObjectId(notification_id)
    except InvalidId:
        return False
    res = notifications_collection.update_one(
        {"_id": oid, "student_id": student_id},
        {"$set": {"is_read": True}},
    )
    return res.modified_count > 0


def mark_user_notification_read(
    student_id: str | None,
    user_id: Any,
    notification_id: str,
) -> bool:
    """Marks a notification read only when addressed to this user or student."""
    try:
        oid = ObjectId(notification_id)
    except InvalidId:
        return False
    owners = [{"recipient_user_id": user_id}]
    if student_id:
        owners.append({"student_id": student_id})
    res = notifications_collection.update_one(
        {"_id": oid, "$or": owners},
        {"$set": {"is_read": True}},
    )
    return res.modified_count > 0
