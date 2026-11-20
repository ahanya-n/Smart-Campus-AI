"""Automated tests for:
- Feature 1: AI Campus Assistant
- Feature 2: Weekly Low Attendance Warning
- Feature 3: Smart Free-Time Finder
"""

import pytest
from datetime import datetime, timezone
from database import attendance_collection, notifications_collection, timetable_collection, students_collection
from main import _seconds_until_next_weekly_run
from services.assistant_service import _extract_requested_day
from services.attendance_warning_service import check_weekly_low_attendance
from services.free_time_service import calculate_free_time


# ---------- Feature 1: Assistant Day Selection Tests ----------

@pytest.mark.parametrize(
    ("today_name", "expected_day"),
    [
        ("Monday", "Tuesday"),
        ("Friday", "Saturday"),
        ("Saturday", "Monday"),
    ],
)
def test_extract_requested_day_tomorrow(today_name, expected_day):
    assert _extract_requested_day("What do I have tomorrow?", today_name) == expected_day


def test_extract_requested_day_tomorrow_after_sunday_is_monday():
    assert _extract_requested_day("What do I have tomorrow?", "Sunday") == "Monday"


# ---------- Feature 3: Free-Time Calculations Unit Tests ----------

def test_free_time_with_timetable_gaps():
    entries = [
        {"day_of_week": "Monday", "start_time": "09:00", "end_time": "10:00", "subject_code": "CS101"},
        {"day_of_week": "Monday", "start_time": "11:30", "end_time": "13:00", "subject_code": "CS102"},
        {"day_of_week": "Monday", "start_time": "14:00", "end_time": "15:00", "subject_code": "CS103"},
    ]
    res = calculate_free_time(entries, "Monday")
    assert res["total_classes"] == 3
    assert len(res["free_slots"]) == 2

    # Slot 1: 10:00 - 11:30 (90 mins)
    assert res["free_slots"][0]["start_time"] == "10:00"
    assert res["free_slots"][0]["end_time"] == "11:30"
    assert res["free_slots"][0]["duration_minutes"] == 90

    # Slot 2: 13:00 - 14:00 (60 mins)
    assert res["free_slots"][1]["start_time"] == "13:00"
    assert res["free_slots"][1]["end_time"] == "14:00"
    assert res["free_slots"][1]["duration_minutes"] == 60

    assert res["total_free_minutes"] == 150
    assert res["best_slot"]["duration_minutes"] == 90


def test_free_time_consecutive_classes():
    entries = [
        {"day_of_week": "Tuesday", "start_time": "09:00", "end_time": "10:00", "subject_code": "CS101"},
        {"day_of_week": "Tuesday", "start_time": "10:00", "end_time": "11:00", "subject_code": "CS102"},
        {"day_of_week": "Tuesday", "start_time": "11:00", "end_time": "12:00", "subject_code": "CS103"},
    ]
    res = calculate_free_time(entries, "Tuesday")
    assert res["total_classes"] == 3
    assert len(res["free_slots"]) == 0
    assert res["total_free_minutes"] == 0
    assert res["best_slot"] is None
    assert "consecutive classes" in res["message"].lower()


def test_free_time_overlapping_entries():
    entries = [
        {"day_of_week": "Wednesday", "start_time": "09:00", "end_time": "11:00", "subject_code": "CS101"},
        {"day_of_week": "Wednesday", "start_time": "10:30", "end_time": "12:00", "subject_code": "CS102"},
        {"day_of_week": "Wednesday", "start_time": "13:30", "end_time": "15:00", "subject_code": "CS103"},
    ]
    res = calculate_free_time(entries, "Wednesday")
    assert res["total_classes"] == 3
    # Merged first block is 09:00 - 12:00. Next block is 13:30 - 15:00. Gap is 12:00 - 13:30 (90 mins).
    assert len(res["free_slots"]) == 1
    assert res["free_slots"][0]["start_time"] == "12:00"
    assert res["free_slots"][0]["end_time"] == "13:30"
    assert res["free_slots"][0]["duration_minutes"] == 90


def test_free_time_missing_or_empty_timetable():
    res = calculate_free_time([], "Thursday")
    assert res["total_classes"] == 0
    assert len(res["free_slots"]) == 0
    assert res["total_free_minutes"] == 0
    assert "no classes scheduled" in res["message"].lower()


def test_free_time_incomplete_class_times_fail_closed():
    res = calculate_free_time(
        [
            {"day_of_week": "Thursday", "start_time": "09:00", "end_time": "10:00"},
            {"day_of_week": "Thursday", "start_time": "invalid", "end_time": "11:00"},
        ],
        "Thursday",
    )
    assert res["data_complete"] is False
    assert res["free_slots"] == []
    assert "cannot be calculated reliably" in res["message"]


def test_weekly_scheduler_targets_monday_after_midnight():
    monday = datetime(2026, 10, 12, 0, 6, tzinfo=timezone.utc)
    assert _seconds_until_next_weekly_run(monday) == 7 * 24 * 60 * 60 - 60


# ---------- Feature 2: Weekly Low Attendance Warning Tests ----------

def test_weekly_threshold_and_duplicate_prevention(run_id):
    week_test = f"2026-W{run_id[:2]}"

    # Seed 3 official records:
    # 1: 70% (below 75% -> must warn)
    # 2: 75% (exactly 75% -> no warning)
    # 3: 90% (above 75% -> no warning)
    # 4: 50% demo (is_demo: True -> must NOT generate official warning)
    s_low = f"SLOW_{run_id}"
    s_exact = f"SEXACT_{run_id}"
    s_high = f"SHIGH_{run_id}"
    s_demo = f"SDEMO_{run_id}"

    attendance_collection.insert_many([
        {
            "student_id": s_low,
            "subject_code": "SUB1",
            "subject_name": "Data Structures",
            "total_classes": 10,
            "present_classes": 7,
            "attendance_percentage": 70.0,
            "is_demo": False,
        },
        {
            "student_id": s_exact,
            "subject_code": "SUB2",
            "subject_name": "Algorithms",
            "total_classes": 20,
            "present_classes": 15,
            "attendance_percentage": 75.0,
            "is_demo": False,
        },
        {
            "student_id": s_high,
            "subject_code": "SUB3",
            "subject_name": "Databases",
            "total_classes": 10,
            "present_classes": 9,
            "attendance_percentage": 90.0,
            "is_demo": False,
        },
        {
            "student_id": s_demo,
            "subject_code": "SUB4",
            "subject_name": "Demo Subject",
            "total_classes": 10,
            "present_classes": 5,
            "attendance_percentage": 50.0,
            "is_demo": True,
        },
    ])

    # First run
    res1 = check_weekly_low_attendance(threshold=75.0, reporting_week=week_test)
    assert res1["generated_warnings"] >= 1

    # Check notification for low attendance student
    notif_low = notifications_collection.find_one({
        "student_id": s_low,
        "subject_code": "SUB1",
        "week_id": week_test,
    })
    assert notif_low is not None
    assert notif_low["attendance_percentage"] == 70.0
    assert notif_low["threshold"] == 75.0
    assert notif_low["warning_type"] == "low_attendance"

    # Exactly 75% must NOT have a warning
    notif_exact = notifications_collection.find_one({
        "student_id": s_exact,
        "subject_code": "SUB2",
        "week_id": week_test,
    })
    assert notif_exact is None

    # Above 75% must NOT have a warning
    notif_high = notifications_collection.find_one({
        "student_id": s_high,
        "subject_code": "SUB3",
        "week_id": week_test,
    })
    assert notif_high is None

    # Demo record must NEVER produce official warning
    notif_demo = notifications_collection.find_one({
        "student_id": s_demo,
        "week_id": week_test,
    })
    assert notif_demo is None

    # Second run for same week -> Duplicate warnings prevented
    res2 = check_weekly_low_attendance(threshold=75.0, reporting_week=week_test)
    assert res2["duplicates_skipped"] >= 1


# ---------- API Integration Tests: Assistant & Free Time ----------

def test_assistant_unauthenticated_fails(client):
    res = client.post("/assistant/chat", json={"message": "What is my attendance?"})
    assert res.status_code == 401


def test_assistant_unlinked_student(client, accounts):
    student_user = accounts.make("student")
    res = client.post(
        "/assistant/chat",
        headers=student_user["headers"],
        json={"message": "What is my attendance percentage?"},
    )
    assert res.status_code == 200
    data = res.json()
    assert "not linked" in data["reply"].lower()
    assert data["data_summary"]["linked"] is False


def test_assistant_linked_student_queries(client, accounts, make_student, run_id):
    sid = make_student()
    student_user = accounts.make("student", student_id=sid)

    # Seed official attendance records
    attendance_collection.insert_one({
        "student_id": sid,
        "subject_code": "CS801",
        "subject_name": "Artificial Intelligence",
        "total_classes": 10,
        "present_classes": 6,
        "attendance_percentage": 60.0,
        "is_demo": False,
    })

    # Query 1: Attendance percentage
    res1 = client.post(
        "/assistant/chat",
        headers=student_user["headers"],
        json={"message": "What is my attendance percentage?"},
    )
    assert res1.status_code == 200
    d1 = res1.json()
    assert "60.0%" in d1["reply"]
    assert d1["intent"] == "attendance_summary"

    # Query 2: Low attendance
    res2 = client.post(
        "/assistant/chat",
        headers=student_user["headers"],
        json={"message": "Which subjects have low attendance?"},
    )
    assert res2.status_code == 200
    d2 = res2.json()
    assert "Artificial Intelligence" in d2["reply"]
    assert "60.0%" in d2["reply"]
    assert d2["intent"] == "low_attendance"


def test_free_time_api(client, accounts, make_student, run_id):
    sid = make_student()
    student_user = accounts.make("student", student_id=sid)

    # Get student dept and sem from DB
    student_doc = students_collection.find_one({"student_id": sid})
    dept = student_doc["department"]
    sem = student_doc["semester"]
    ins_res = timetable_collection.insert_many([
        {
            "department": dept,
            "semester": sem,
            "day_of_week": "Friday",
            "subject_code": "CS101",
            "subject_name": "Programming",
            "start_time": "09:00",
            "end_time": "10:30",
            "room_number": "R1",
            "is_demo": False,
        },
        {
            "department": dept,
            "semester": sem,
            "day_of_week": "Friday",
            "subject_code": "CS102",
            "subject_name": "Math",
            "start_time": "12:00",
            "end_time": "13:30",
            "room_number": "R2",
            "is_demo": False,
        },
    ])

    try:
        res = client.get("/assistant/free-time?day=Friday", headers=student_user["headers"])
        assert res.status_code == 200
        data = res.json()
        assert data["linked"] is True
        assert data["total_classes"] == 2
        assert len(data["free_slots"]) == 1
        assert data["free_slots"][0]["start_time"] == "10:30"
        assert data["free_slots"][0]["end_time"] == "12:00"
        assert data["free_slots"][0]["duration_minutes"] == 90
    finally:
        timetable_collection.delete_many({"_id": {"$in": ins_res.inserted_ids}})


def test_notifications_api(client, accounts, make_student, run_id):
    sid = make_student()
    student_user = accounts.make("student", student_id=sid)

    # Insert a notification
    ins = notifications_collection.insert_one({
        "student_id": sid,
        "subject_code": "CS701",
        "subject_name": "Compiler Design",
        "attendance_percentage": 65.0,
        "threshold": 75.0,
        "week_id": f"2026-W{run_id[:2]}",
        "warning_type": "low_attendance",
        "title": "Low Attendance Warning",
        "message": "Your attendance in Compiler Design is 65.0%",
        "reporting_date": "2026-10-14",
        "is_read": False,
    })

    # List notifications
    res = client.get("/notifications", headers=student_user["headers"])
    assert res.status_code == 200
    data = res.json()
    assert data["linked"] is True
    assert data["unread_count"] == 1
    assert len(data["notifications"]) == 1
    notif_id = str(ins.inserted_id)

    # Mark as read
    res_read = client.patch(f"/notifications/{notif_id}/read", headers=student_user["headers"])
    assert res_read.status_code == 200

    # Verify unread count is now 0
    res_after = client.get("/notifications", headers=student_user["headers"])
    assert res_after.json()["unread_count"] == 0


def test_assistant_keeps_factual_answers_deterministic_with_llm_keys(monkeypatch):
    from services.assistant_service import process_assistant_query

    monkeypatch.setenv("GEMINI_API_KEY", "ignored-test-key")
    result = process_assistant_query("What is my attendance percentage?", student=None)
    assert result["provider"] == "grounded_rule_engine"
    assert "not linked" in result["reply"].lower()


def test_openai_key_does_not_claim_unimplemented_provider(monkeypatch):
    from services.assistant_service import process_assistant_query

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    result = process_assistant_query("What is my attendance?", student=None)
    assert result["provider"] == "grounded_rule_engine"


def test_attendance_boundary_75_percent(run_id):
    """Verifies strict 75.0% boundary: 74.9% qualifies, exactly 75.0% does not."""
    week = f"2026-WB{run_id[:2]}"
    s_below = f"SBELOW_{run_id}"
    s_exact = f"SBEXACT_{run_id}"

    attendance_collection.insert_many([
        {
            "student_id": s_below,
            "subject_code": "BOUND1",
            "subject_name": "Boundary Test 1",
            "total_classes": 100,
            "present_classes": 74,
            "attendance_percentage": 74.0,
            "is_demo": False,
        },
        {
            "student_id": s_exact,
            "subject_code": "BOUND2",
            "subject_name": "Boundary Test 2",
            "total_classes": 100,
            "present_classes": 75,
            "attendance_percentage": 75.0,
            "is_demo": False,
        },
    ])

    check_weekly_low_attendance(threshold=75.0, reporting_week=week)

    # 74.0% must have a warning
    notif_below = notifications_collection.find_one({
        "student_id": s_below,
        "subject_code": "BOUND1",
        "week_id": week,
    })
    assert notif_below is not None
    assert notif_below["attendance_percentage"] == 74.0

    # Exactly 75.0% must NOT have a warning
    notif_exact = notifications_collection.find_one({
        "student_id": s_exact,
        "subject_code": "BOUND2",
        "week_id": week,
    })
    assert notif_exact is None

