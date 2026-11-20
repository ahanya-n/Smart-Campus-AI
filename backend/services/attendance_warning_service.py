"""Weekly Low Attendance Warning Service.
Identifies subjects where a student's attendance is below 75% threshold.
Ensures warnings are generated once per weekly reporting period without duplicates.
Never uses demo records to generate official warnings.
"""

from datetime import date, datetime, timezone
from typing import Any

from bson import ObjectId
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


def get_student_notifications(student_id: str) -> list[dict[str, Any]]:
    """Returns in-app notifications for a student, newest first."""
    docs = list(
        notifications_collection.find({"student_id": student_id})
        .sort("created_at", -1)
        .limit(100)
    )
    result = []
    for d in docs:
        result.append({
            "id": str(d["_id"]),
            "student_id": d["student_id"],
            "subject_code": d.get("subject_code", ""),
            "subject_name": d.get("subject_name", ""),
            "attendance_percentage": d.get("attendance_percentage", 0.0),
            "threshold": d.get("threshold", DEFAULT_ATTENDANCE_THRESHOLD),
            "week_id": d.get("week_id", ""),
            "warning_type": d.get("warning_type", "low_attendance"),
            "title": d.get("title", "Attendance Alert"),
            "message": d.get("message", ""),
            "reporting_date": d.get("reporting_date", ""),
            "created_at": d.get("created_at").isoformat() if isinstance(d.get("created_at"), datetime) else None,
            "is_read": bool(d.get("is_read", False)),
        })
    return result


def mark_notification_read(student_id: str, notification_id: str) -> bool:
    """Marks a student's notification as read."""
    try:
        oid = ObjectId(notification_id)
    except Exception:
        return False
    res = notifications_collection.update_one(
        {"_id": oid, "student_id": student_id},
        {"$set": {"is_read": True}},
    )
    return res.modified_count > 0
