from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from database import attendance_collection, students_collection, timetable_collection
from routes import assistant_routes
from services import assistant_service
from services.academic_intelligence import analyze_student


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("Where is my next class?", "classroom_location"),
        ("When is my next class?", "next_class"),
        ("What classes do I have today?", "today_timetable"),
        ("Today which hour am I free?", "free_hours"),
        ("What is my attendance percentage?", "attendance_summary"),
        ("Show my subject-wise attendance", "subject_attendance"),
        ("Which subject has low attendance?", "low_attendance"),
        ("How many classes did I miss?", "absent_classes"),
        ("Who is teaching my next class?", "faculty_details"),
        ("Who is taking it?", "faculty_details"),
        ("Show my assigned subjects", "assigned_subjects"),
        ("Which subjects am I teaching?", "assigned_subjects"),
        ("How many students are assigned to me?", "assigned_student_count"),
        ("Nanna class alli eshtu students iddare?", "assigned_student_count"),
        ("Show attendance for my assigned classes.", "subject_attendance"),
        ("What is my internal marks average?", "marks_summary"),
        ("Show my marks", "marks_summary"),
        ("What are my marks?", "marks_summary"),
        ("Generate a summary of my class performance", "student_performance"),
        ("Which students need academic attention?", "academic_risk"),
        ("Create a study plan for my free hours", "study_plan"),
        ("nanna next class yavaaga?", "next_class"),
        ("ivattu yava hour free idini?", "free_hours"),
        ("nanna attendance eshtu?", "attendance_summary"),
        ("yaava subject attendance kammi?", "low_attendance"),
        ("ನನ್ನ ಮುಂದಿನ ಕ್ಲಾಸ್ ಎಲ್ಲಿದೆ?", "classroom_location"),
        ("ಇವತ್ತು ಯಾವ ಗಂಟೆ ಫ್ರೀ?", "free_hours"),
        ("ನನ್ನ ಹಾಜರಾತಿ ಎಷ್ಟು?", "attendance_summary"),
        ("ಯಾವ ವಿಷಯದ ಹಾಜರಾತಿ ಕಡಿಮೆ?", "low_attendance"),
    ],
)
def test_conversational_intent_formats(query, expected):
    assert assistant_service.detect_intent(query) == expected


def _student_context(
    monkeypatch,
    timetable,
    attendance=None,
    attendance_entries=None,
    marks=None,
):
    student = {
        "student_id": "CAMPUS-CHAT-STUDENT",
        "name": "Test Student",
        "department": "MCA",
        "semester": 1,
    }
    report = analyze_student(
        student,
        attendance or [],
        attendance_entries or [],
        marks or [],
    )
    monkeypatch.setattr(
        assistant_service,
        "_read_student_context",
        lambda *_args, **_kwargs: {
            "linked": True,
            "role": "student",
            "student": student,
            "academic_report": report,
            "data_limitations": [],
            "timetable_entries": timetable,
        },
    )
    return student


def _class(subject, start, end, **extra):
    return {
        "day_of_week": "Monday",
        "subject_code": subject,
        "subject_name": subject,
        "start_time": start,
        "end_time": end,
        **extra,
    }


def test_student_intent_answers_use_synthetic_academic_and_timetable_records(monkeypatch):
    schedule = [
        _class("DBMS", "09:00", "10:00", subject_name="Database", room_number="Lab 2", faculty_name="Dr. Rao"),
        _class("ML", "11:00", "12:00", subject_name="Machine Learning", room_number="204", faculty_name="Prof. Iyer"),
    ]
    student = _student_context(
        monkeypatch,
        schedule,
        attendance=[{
            "subject_code": "DBMS",
            "subject_name": "Database",
            "present_classes": 5,
            "total_classes": 10,
        }],
        marks=[{
            "subject_code": "DBMS",
            "subject_name": "Database",
            "score": 6,
            "max_score": 10,
        }],
    )
    now = datetime(2026, 1, 5, 8, 0, tzinfo=assistant_service.KOLKATA)
    cases = [
        ("When is my next class?", "next_class", "Your next class is"),
        ("Where is my next class?", "classroom_location", "Lab 2"),
        ("What classes do I have today?", "today_timetable", "official timetable"),
        ("Which hour am I free today?", "free_hours", "10:00 AM–11:00 AM"),
        ("What is my attendance percentage?", "attendance_summary", "50.0%"),
        ("Show my subject-wise attendance", "subject_attendance", "Database"),
        ("Which subject has low attendance?", "low_attendance", "Database"),
        ("How many classes did I miss?", "absent_classes", "5 recorded missed"),
        ("Who is teaching my next class?", "faculty_details", "Dr. Rao"),
        ("What are my internal marks?", "marks_summary", "60.0%"),
        ("Show my marks", "marks_summary", "60.0%"),
        ("What is my academic performance?", "student_performance", "status is"),
        ("Explain my academic risk", "academic_risk", "status is"),
        ("Create a study plan", "study_plan", "study plan"),
    ]

    for query, expected_intent, expected_text in cases:
        response = assistant_service.process_assistant_query(
            query,
            student,
            now=now,
        )
        assert response["intent"] == expected_intent
        assert expected_text.casefold() in response["reply"].casefold()
        if expected_intent == "study_plan":
            assert response["study_plan"]


def test_faculty_intent_answers_use_authorized_class_context(monkeypatch):
    student = {
        "student_id": "AUTHORIZED-SYNTHETIC-STUDENT",
        "name": "Authorized Synthetic Student",
        "department": "MCA",
        "semester": 1,
    }
    report = analyze_student(
        student,
        [{
            "subject_code": "DBMS",
            "subject_name": "Database",
            "present_classes": 5,
            "total_classes": 10,
        }],
        [],
        [{"subject_code": "DBMS", "subject_name": "Database", "score": 6, "max_score": 10}],
    )
    schedule = [
        _class("DBMS", "09:00", "10:00", subject_name="Database", room_number="Lab 2", faculty_name="Dr. Rao"),
        _class("ML", "11:00", "12:00", subject_name="Machine Learning", room_number="204", faculty_name="Dr. Rao"),
    ]
    context = {
        "linked": True,
        "role": "faculty",
        "student": {"name": "Dr. Rao"},
        "assigned_subject_codes": ["DBMS", "ML"],
        "subject_codes": ["DBMS", "ML"],
        "students": [student],
        "student_reports": [report],
        "data_limitations": [],
        "timetable_entries": schedule,
    }
    monkeypatch.setattr(assistant_service, "_faculty_context", lambda _user: context)
    now = datetime(2026, 1, 5, 8, 0, tzinfo=assistant_service.KOLKATA)
    cases = [
        ("Where is my next classroom?", "classroom_location", "Lab 2"),
        ("What is my timetable today?", "today_timetable", "Authorized timetable"),
        ("Which hours am I free today?", "free_hours", "10:00 AM–11:00 AM"),
        ("Show my assigned subjects", "assigned_subjects", "DBMS"),
        ("Which subjects am I teaching?", "assigned_subjects", "DBMS"),
        ("How many students are assigned to me?", "assigned_student_count", "1 student(s)"),
        ("Nanna class alli eshtu students iddare?", "assigned_student_count", "1 student(s)"),
        ("Show attendance for my assigned classes", "subject_attendance", "Authorized Synthetic Student"),
        ("Show attendance for my assigned subject", "subject_attendance", "Authorized Synthetic Student"),
        ("Which students have attendance below 75%?", "low_attendance", "Authorized Synthetic Student"),
        ("Which students need academic attention?", "academic_risk", "Authorized Synthetic Student"),
        ("Generate a summary of my class performance", "student_performance", "Authorized class summary"),
    ]

    for query, expected_intent, expected_text in cases:
        response = assistant_service.process_assistant_query(
            query,
            user={"_id": "faculty-test-id", "role": "faculty", "name": "Dr. Rao"},
            now=now,
        )
        assert response["intent"] == expected_intent
        assert expected_text.casefold() in response["reply"].casefold()

    unauthorized = assistant_service.process_assistant_query(
        "Show attendance for subject MCA101",
        user={"_id": "faculty-test-id", "role": "faculty", "name": "Dr. Rao"},
        now=now,
    )
    assert unauthorized["intent"] == "subject_attendance"
    assert "not in your authorized subject scope" in unauthorized["reply"]
    assert "Authorized Synthetic Student" not in unauthorized["reply"]


def test_next_class_location_and_follow_up_are_based_on_current_schedule(monkeypatch):
    schedule = [
        _class("DBMS", "09:00", "10:00", room_number="Lab 2", faculty_name="Dr. Rao"),
        _class("ML", "11:00", "12:00", room_number="204", faculty_name="Prof. Iyer"),
    ]
    student = _student_context(monkeypatch, schedule)
    now = datetime(2026, 1, 5, 8, 30, tzinfo=assistant_service.KOLKATA)

    next_class = assistant_service.process_assistant_query(
        "Where is my next class?", student, now=now,
    )
    assert next_class["intent"] == "classroom_location"
    assert "DBMS" in next_class["reply"]
    assert "9:00 AM–10:00 AM" in next_class["reply"]
    assert "Lab 2" in next_class["reply"]

    history = [{
        "role": "assistant",
        "content": next_class["reply"],
        "intent": next_class["intent"],
    }]
    faculty = assistant_service.process_assistant_query(
        "Who is taking it?", student, history=history, now=now,
    )
    assert faculty["intent"] == "faculty_details"
    assert "Dr. Rao" in faculty["reply"]

    follow_up = assistant_service.process_assistant_query(
        "Am I free after that?", student,
        history=[{**history[0], "intent": "next_class"}],
        now=now,
    )
    assert follow_up["intent"] == "free_hours"
    assert "After that class" in follow_up["reply"]
    assert "10:00 AM–11:00 AM" in follow_up["reply"]


def test_schedule_handles_ongoing_completed_missing_and_overlapping_classes(monkeypatch):
    schedule = [
        _class("A", "09:00", "11:00", room_number="Room 1"),
        _class("B", "10:30", "12:00", room_number="Room 2"),
        _class("C", "13:00", "14:00", room_number="Room 3"),
    ]
    student = _student_context(monkeypatch, schedule)
    ongoing = assistant_service.process_assistant_query(
        "When is my next class?", student,
        now=datetime(2026, 1, 5, 10, 45, tzinfo=assistant_service.KOLKATA),
    )
    assert "current class is in progress" in ongoing["reply"]
    assert "next scheduled class" in ongoing["reply"]

    free = assistant_service.process_assistant_query(
        "Today which hour am I free?", student,
        now=datetime(2026, 1, 5, 9, 0, tzinfo=assistant_service.KOLKATA),
    )
    assert "12:00 PM–1:00 PM" in free["reply"]
    assert "11:00 AM–10:30 AM" not in free["reply"]

    missing_location = assistant_service.process_assistant_query(
        "Where is my next class?",
        _student_context(monkeypatch, [_class("NoRoom", "09:00", "10:00")]),
        now=datetime(2026, 1, 5, 8, 0, tzinfo=assistant_service.KOLKATA),
    )
    assert "classroom information is unavailable" in missing_location["reply"]
    assert "Faculty: information is unavailable" in missing_location["reply"]

    completed = assistant_service.process_assistant_query(
        "When is my next class?",
        _student_context(monkeypatch, [_class("Done", "09:00", "10:00")]),
        now=datetime(2026, 1, 5, 10, 30, tzinfo=assistant_service.KOLKATA),
    )
    assert "No upcoming classes remain" in completed["reply"]


def test_timetable_day_uses_kolkata_local_date(monkeypatch):
    student = _student_context(monkeypatch, [])
    utc_time = datetime(2026, 1, 4, 19, 0, tzinfo=timezone.utc)

    response = assistant_service.process_assistant_query(
        "What classes do I have today?", student, now=utc_time,
    )

    assert response["day"] == "Monday"
    assert response["intent"] == "today_timetable"


def test_free_time_default_day_uses_kolkata_timezone(monkeypatch):
    class FixedClock:
        @staticmethod
        def now(tz=None):
            assert tz == assistant_service.KOLKATA
            return datetime(2026, 1, 4, 19, 0, tzinfo=timezone.utc).astimezone(tz)

    monkeypatch.setattr(assistant_routes, "datetime", FixedClock)
    response = assistant_routes.get_free_time(
        day=None,
        user={"role": "student"},
    )

    assert response.day == "Monday"


def test_free_time_ignores_demo_query_and_requires_linked_student(
    client, accounts, monkeypatch
):
    student_user = accounts.make("student")
    monkeypatch.setattr(assistant_routes, "find_linked_student", lambda _user: None)

    response = client.get(
        "/assistant/free-time?demo=true",
        headers=student_user["headers"],
    )

    assert response.status_code == 200
    assert response.json()["linked"] is False
    assert "not linked" in response.json()["message"].lower()


def test_faculty_chat_only_reports_assigned_class_students(
    client, accounts, make_student, test_students
):
    assigned_code = test_students["subject"]
    unrelated_code = test_students["subject2"]
    faculty = accounts.make("faculty", subjects=[assigned_code])
    in_scope_id, out_of_scope_id = make_student(), make_student()
    day = "Sunday"
    schedule = timetable_collection.insert_one({
        "department": "MCA",
        "semester": 1,
        "day_of_week": day,
        "subject_code": assigned_code,
        "subject_name": "Assigned Test Subject",
        "start_time": "23:15",
        "end_time": "23:45",
        "room_number": "Test Lab",
        "is_demo": False,
    })
    attendance = attendance_collection.insert_many([
        {
            "student_id": in_scope_id,
            "subject_code": assigned_code,
            "subject_name": "Assigned Test Subject",
            "present_classes": 5,
            "total_classes": 10,
            "is_demo": False,
            "synthetic_demo": False,
        },
        {
            "student_id": in_scope_id,
            "subject_code": unrelated_code,
            "subject_name": "Unassigned Test Subject",
            "present_classes": 0,
            "total_classes": 10,
            "is_demo": False,
            "synthetic_demo": False,
        },
        {
            "student_id": out_of_scope_id,
            "subject_code": unrelated_code,
            "subject_name": "Unassigned Test Subject",
            "present_classes": 0,
            "total_classes": 10,
            "is_demo": False,
            "synthetic_demo": False,
        },
    ])
    try:
        response = client.post(
            "/assistant/chat",
            headers=faculty["headers"],
            json={"message": "Which students have attendance below 75%?"},
        )
        assigned = client.post(
            "/assistant/chat",
            headers=faculty["headers"],
            json={"message": "Show attendance for my assigned subject"},
        )
        assert response.status_code == 200
        assert "Assigned Test Subject" in response.json()["reply"]
        assert "Unassigned Test Subject" not in response.json()["reply"]
        assert assigned.status_code == 200
        assert "Assigned Test Subject" in assigned.json()["reply"]
        assert "Unassigned Test Subject" not in assigned.json()["reply"]

        admin = accounts.make("admin")
        denied = client.post(
            "/assistant/chat",
            headers=admin["headers"],
            json={"message": "What is my next class?"},
        )
        assert denied.status_code == 403
    finally:
        attendance_collection.delete_many({"_id": {"$in": attendance.inserted_ids}})
        timetable_collection.delete_one({"_id": schedule.inserted_id})


def test_assistant_rejects_oversized_history(client, accounts):
    student = accounts.make("student")
    response = client.post(
        "/assistant/chat",
        headers=student["headers"],
        json={
            "message": "What is my next class?",
            "history": [
                {"role": "assistant", "content": "previous", "intent": "next_class"}
                for _ in range(9)
            ],
        },
    )
    assert response.status_code == 422
