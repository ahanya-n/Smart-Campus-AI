from datetime import datetime, timedelta, timezone

import jwt

from database import database, users_collection
from dependencies.auth import JWT_ALGORITHM, JWT_SECRET
from services import assistant_service
from services.assistant_service import KOLKATA
from seed_karnataka_demo_academics import (
    DATASET_MARKER,
    FACULTY_SPECS,
    STUDENT_COUNT,
    _student_rows,
    seed_academics,
    verify_seed,
)


def _headers_for(user: dict) -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": str(user["_id"]),
            "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
        },
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


def test_karnataka_cohort_seed_is_idempotent_and_role_scoped(client, admin, monkeypatch):
    assert database.name == "smart_campus_test"
    monkeypatch.setattr(
        assistant_service,
        "_now_kolkata",
        lambda _now=None: datetime(2026, 11, 16, 8, 0, tzinfo=KOLKATA),
    )
    seed_academics(database, apply=True)
    verified = verify_seed(database)
    second_apply = seed_academics(database, apply=True)

    assert verified["students"] == STUDENT_COUNT
    assert verified["subjects"] == 6
    assert verified["classes"] == 2
    assert verified["enrollments"] == 60
    assert verified["attendance"] == 60
    assert verified["attendance_entries"] == 1080
    assert verified["marks"] == 180
    assert all(count == 0 for count in second_apply.values())

    student_rows = _student_rows()
    student = users_collection.find_one(
        {"email": student_rows[1]["user_email"]}, {"password": 0}
    )
    faculty = users_collection.find_one(
        {"email": FACULTY_SPECS[1]["email"]}, {"password": 0}
    )
    assert student is not None
    assert faculty is not None

    student_headers = _headers_for(student)
    faculty_headers = _headers_for(faculty)

    def ask(headers: dict[str, str], message: str, day: str = "Monday") -> dict:
        response = client.post(
            "/assistant/chat",
            headers=headers,
            json={"message": message, "day": day},
        )
        assert response.status_code == 200, response.text
        return response.json()

    student_directory = client.get("/students", headers=student_headers)
    attendance = client.get("/attendance/me", headers=student_headers)
    report = client.get("/academic-intelligence/me", headers=student_headers)
    timetable = client.get("/timetable?day=Monday", headers=student_headers)
    marks_answer = client.post(
        "/assistant/chat",
        headers=student_headers,
        json={"message": "Show my marks", "day": "Monday"},
    )
    faculty_roster = client.get("/students", headers=faculty_headers)
    faculty_overview = client.get(
        "/academic-intelligence/overview?department=MCA&semester=1",
        headers=faculty_headers,
    )
    faculty_count = client.post(
        "/assistant/chat",
        headers=faculty_headers,
        json={"message": "How many students are assigned to me?", "day": "Monday"},
    )
    forbidden_student = client.get(
        "/academic-intelligence/students/20260MCA0031",
        headers=faculty_headers,
    )
    admin_stats = client.get("/admin/stats", headers=admin["headers"])
    student_attendance_answer = ask(student_headers, "What is my attendance percentage?")
    subject_attendance_answer = ask(student_headers, "Show my subject-wise attendance")
    missed_classes_answer = ask(student_headers, "How many classes have I missed?")
    next_class_answer = ask(student_headers, "What is my next class?")
    next_faculty_answer = ask(student_headers, "Which faculty teaches my next subject?")
    today_timetable_answer = ask(student_headers, "What is my timetable today?")
    low_attendance_answer = ask(student_headers, "Which subjects have low attendance?")
    free_hours_answer = ask(student_headers, "How many free hours do I have today?")
    faculty_attendance_answer = ask(faculty_headers, "What is my attendance percentage?")
    faculty_low_subjects_answer = ask(faculty_headers, "Which subjects have low attendance?")
    faculty_next_class_answer = ask(faculty_headers, "What is my next class?", "Tuesday")
    faculty_today_answer = ask(faculty_headers, "Which classes do I have today?", "Tuesday")
    faculty_low_students_answer = ask(faculty_headers, "Which students have low attendance?")

    assert student_directory.status_code == 200
    assert [row["student_id"] for row in student_directory.json()] == [
        student_rows[1]["student_id"]
    ]
    assert student_directory.json()[0]["registration_number"] == student_rows[1]["student_id"]
    assert attendance.status_code == 200
    attendance_body = attendance.json()
    assert attendance_body["is_demo"] is True
    assert attendance_body["summary"]["subject_count"] == 3
    assert attendance_body["summary"]["total_classes"] == 54
    assert attendance_body["summary"]["attendance_percentage"] == round(
        attendance_body["summary"]["present_classes"] / 54 * 100, 2
    )
    assert {row["subject_code"] for row in attendance_body["records"]} == {
        "MCA101", "MCA102", "MCA103",
    }
    assert report.status_code == 200
    assert len(report.json()["subjects"]) == 3
    assert report.json()["internal_marks"]["assessment_count"] == 9
    assert timetable.status_code == 200
    assert timetable.json()["is_demo"] is True
    assert timetable.json()["entries"]
    assert {row["faculty_name"] for row in timetable.json()["entries"]} & {
        spec["name"] for spec in FACULTY_SPECS
    }
    assert marks_answer.status_code == 200
    assert marks_answer.json()["intent"] == "marks_summary"
    assert "9 recorded assessments" in marks_answer.json()["reply"]
    assert student_attendance_answer["data_summary"]["overall_attendance"] == (
        attendance_body["summary"]["attendance_percentage"]
    )
    assert subject_attendance_answer["intent"] == "subject_attendance"
    assert "Mathematical Foundations" in subject_attendance_answer["reply"]
    assert missed_classes_answer["intent"] == "absent_classes"
    assert str(attendance_body["summary"]["absent_classes"]) in missed_classes_answer["reply"]
    assert next_class_answer["intent"] == "next_class"
    assert next_faculty_answer["intent"] == "faculty_details"
    assert any(spec["name"] in next_faculty_answer["reply"] for spec in FACULTY_SPECS)
    assert today_timetable_answer["intent"] == "today_timetable"
    assert "Programming in C" in today_timetable_answer["reply"] or "Computer Organization" in today_timetable_answer["reply"]
    assert low_attendance_answer["intent"] == "low_attendance"
    assert "Mathematical Foundations" in low_attendance_answer["reply"]
    assert free_hours_answer["intent"] == "free_hours"

    assert faculty_roster.status_code == 200
    assert len(faculty_roster.json()) == 10
    assert all(row["semester"] == 1 for row in faculty_roster.json())
    assert faculty_overview.status_code == 200
    assert faculty_overview.json()["total_students_analyzed"] == 10
    assert faculty_count.status_code == 200
    assert "10 student(s)" in faculty_count.json()["reply"]
    assert faculty_attendance_answer["intent"] == "attendance_summary"
    assert "%" in faculty_attendance_answer["reply"]
    assert faculty_low_subjects_answer["intent"] == "low_attendance"
    assert "Mathematical Foundations" in faculty_low_subjects_answer["reply"]
    assert faculty_next_class_answer["intent"] == "next_class"
    assert faculty_today_answer["intent"] == "today_timetable"
    assert faculty_low_students_answer["intent"] == "low_attendance"
    assert forbidden_student.status_code == 404

    assert admin_stats.status_code == 200
    assert admin_stats.json()["total_subjects"] >= 6
    assert admin_stats.json()["total_classes"] >= 2

    assert database["students"].count_documents({
        "demo_seed_key": DATASET_MARKER,
        "is_demo": True,
    }) == STUDENT_COUNT
