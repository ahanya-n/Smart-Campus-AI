"""Weekly Attendance Warning and Notification APIs.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from dependencies.auth import get_current_user, require_roles
from dependencies.student import find_linked_student
from services.attendance_warning_service import (
    DEFAULT_ATTENDANCE_THRESHOLD,
    check_weekly_low_attendance,
    get_user_notifications,
    mark_user_notification_read,
)

router = APIRouter(prefix="/notifications", tags=["Notifications"])
staff_only = require_roles("faculty", "admin")


class NotificationItem(BaseModel):
    id: str
    student_id: str
    subject_code: str
    subject_name: str
    attendance_percentage: float
    threshold: float
    week_id: str
    warning_type: str
    title: str
    message: str
    reporting_date: str
    created_at: str | None
    is_read: bool
    action_type: str | None = None
    claim_id: str | None = None
    match_id: str | None = None
    lost_report_id: str | None = None
    found_report_id: str | None = None


class NotificationListResponse(BaseModel):
    linked: bool
    student_id: str | None
    unread_count: int
    notifications: list[NotificationItem]


class WeeklyCheckResponse(BaseModel):
    week_id: str
    scanned_records: int
    generated_warnings: int
    duplicates_skipped: int
    healthy_records: int
    insufficient_data_skipped: int
    threshold: float


@router.get("", response_model=NotificationListResponse)
def list_notifications(current_user: dict = Depends(get_current_user)):
    """Returns in-app notifications for the authenticated student.
    Never trusts a client-supplied student_id; derives it from the auth token.
    """
    student = find_linked_student(current_user)
    sid = (
        student["student_id"]
        if student
        else current_user.get("student_id")
        if isinstance(current_user.get("student_id"), str)
        else None
    )
    items = get_user_notifications(sid, current_user["_id"])
    parsed = [NotificationItem(**item) for item in items]
    unread = sum(1 for n in parsed if not n.is_read)

    return NotificationListResponse(
        linked=bool(student),
        student_id=sid if student else None,
        unread_count=unread,
        notifications=parsed,
    )


@router.post("/check-weekly", response_model=WeeklyCheckResponse)
def trigger_weekly_check(
    threshold: float = Query(DEFAULT_ATTENDANCE_THRESHOLD, ge=1.0, le=100.0),
    week_id: str | None = Query(None, description="Optional override, e.g. '2026-W42'"),
    _admin: dict = Depends(staff_only),
):
    """Triggers the weekly low attendance scan across official records.
    Only generates warnings for subjects below threshold.
    Avoids duplicate warnings for the same student, subject and week.
    """
    res = check_weekly_low_attendance(threshold=threshold, reporting_week=week_id)
    return WeeklyCheckResponse(**res)


@router.patch("/{notification_id}/read")
def mark_read(
    notification_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Marks a notification as read for the logged-in student."""
    student = find_linked_student(current_user)
    student_id = (
        student["student_id"]
        if student
        else current_user.get("student_id")
        if isinstance(current_user.get("student_id"), str)
        else None
    )
    success = mark_user_notification_read(
        student_id,
        current_user["_id"],
        notification_id,
    )
    if not success:
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"message": "Notification marked as read", "id": notification_id}
