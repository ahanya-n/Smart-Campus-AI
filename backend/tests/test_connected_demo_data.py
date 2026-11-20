from datetime import datetime, timezone
import uuid

from bson import ObjectId
from database import (
    attendance_collection,
    attendance_entries_collection,
    database,
    students_collection,
    timetable_collection,
    users_collection,
)
from services.assistant_service import KOLKATA
from services.data_filters import LOCAL_DEMO_SEED_MARKER


def test_seeded_demo_records_flow_through_role_scoped_apis(
    client, accounts, run_id, request,
):
    assert database.name == "smart_campus_test"
    suffix = f"{run_id}-{uuid.uuid4().hex[:6]}"
    student_id = f"DEMO-{suffix}"
    other_student_id = f"OTHER-{suffix}"
    department = f"D{suffix[:8].upper()}"
    subject_code = f"D{suffix[:6].upper()}"
    second_subject_code = f"E{suffix[2:8].upper()}"
    marker = f"connected-demo-test-{suffix}"
    seed_key = f"{marker}-records"
    created_user_ids = []

    def cleanup():
        attendance_collection.delete_many({"demo_seed_key": seed_key})
        attendance_entries_collection.delete_many({"demo_seed_key": seed_key})
        timetable_collection.delete_many({"demo_seed_key": seed_key})
        database["marks"].delete_many({"demo_seed_key": seed_key})
        for user_id in created_user_ids:
            users_collection.delete_one({"_id": user_id})
        students_collection.delete_one({"student_id": student_id})
        students_collection.delete_one({"student_id": other_student_id})

    request.addfinalizer(cleanup)
    day = datetime.now(KOLKATA).strftime("%A")
    other_day = "Saturday" if day != "Saturday" else "Friday"
    now = datetime.now(KOLKATA)
    first_start = f"{min(now.hour + 1, 21):02d}:00"
    first_end = f"{min(now.hour + 2, 22):02d}:00"
    second_start = f"{min(now.hour + 3, 22):02d}:00"
    second_end = f"{min(now.hour + 4, 23):02d}:00"

    students_collection.insert_one({
        "student_id": student_id,
        "name": f"Demo Student {suffix}",
        "email": f"{student_id.lower()}@test.local",
        "department": department,
        "semester": 2,
        "is_demo": True,
        "synthetic_demo": True,
        "local_demo_seed": LOCAL_DEMO_SEED_MARKER,
    })
    students_collection.insert_one({
        "student_id": other_student_id,
        "name": f"Other Demo Student {suffix}",
        "email": f"{other_student_id.lower()}@test.local",
        "department": department,
        "semester": 2,
        "is_demo": True,
        "synthetic_demo": True,
        "local_demo_seed": LOCAL_DEMO_SEED_MARKER,
    })
    student = accounts.make("student", student_id=student_id)
    created_user_ids.append(ObjectId(student["id"]))
    faculty = accounts.make("faculty", subjects=[subject_code, second_subject_code])
    created_user_ids.append(ObjectId(faculty["id"]))
    unrelated_faculty = accounts.make("faculty")
    created_user_ids.append(ObjectId(unrelated_faculty["id"]))
    users_collection.update_one(
        {"_id": ObjectId(student["id"])},
        {"$set": {
            "is_demo": True,
            "synthetic_demo": True,
            "local_demo_seed": LOCAL_DEMO_SEED_MARKER,
        }},
    )
    users_collection.update_one(
        {"_id": ObjectId(faculty["id"])},
        {"$set": {
            "is_demo": True,
            "synthetic_demo": True,
            "local_demo_seed": LOCAL_DEMO_SEED_MARKER,
        }},
    )

    attendance_collection.insert_many([
        {
            "student_id": student_id,
            "subject_code": subject_code,
            "subject_name": "Integration Demo Programming",
            "total_classes": 4,
            "present_classes": 3,
            "absent_classes": 1,
            "attendance_percentage": 75.0,
            "is_demo": True,
            "synthetic_demo": True,
            "demo_seed_key": seed_key,
        },
        {
            "student_id": student_id,
            "subject_code": second_subject_code,
            "subject_name": "Integration Demo Databases",
            "total_classes": 4,
            "present_classes": 2,
            "absent_classes": 2,
            "attendance_percentage": 50.0,
            "is_demo": True,
            "synthetic_demo": True,
            "demo_seed_key": seed_key,
        },
    ])
    timetable_collection.insert_many([
        {
            "department": department,
            "semester": 2,
            "day_of_week": day,
            "subject_code": subject_code,
            "subject_name": "Integration Demo Programming",
            "start_time": first_start,
            "end_time": first_end,
            "faculty_name": faculty["name"],
            "faculty_user_id": faculty["id"],
            "room_number": "TEST-LAB-1",
            "is_demo": True,
            "synthetic_demo": True,
            "demo_seed_key": seed_key,
        },
        {
            "department": department,
            "semester": 2,
            "day_of_week": day,
            "subject_code": second_subject_code,
            "subject_name": "Integration Demo Databases",
            "start_time": second_start,
            "end_time": second_end,
            "faculty_name": faculty["name"],
            "faculty_user_id": faculty["id"],
            "room_number": "TEST-LAB-2",
            "is_demo": True,
            "synthetic_demo": True,
            "demo_seed_key": seed_key,
        },
        {
            "department": department,
            "semester": 2,
            "day_of_week": other_day,
            "subject_code": subject_code,
            "subject_name": "Integration Demo Programming",
            "start_time": "09:00",
            "end_time": "10:00",
            "faculty_name": faculty["name"],
            "faculty_user_id": faculty["id"],
            "room_number": "TEST-LAB-1",
            "is_demo": True,
            "synthetic_demo": True,
            "demo_seed_key": seed_key,
        },
    ])
    attendance_entries_collection.insert_many([
        {
            "student_id": student_id,
            "subject_code": subject_code,
            "subject_name": "Integration Demo Programming",
            "session_date": "2026-11-02",
            "start_time": first_start,
            "status": "present",
            "is_demo": True,
            "synthetic_demo": True,
            "demo_seed_key": seed_key,
        },
    ])
    database["marks"].insert_one({
        "student_id": student_id,
        "subject_code": subject_code,
        "subject_name": "Integration Demo Programming",
        "assessment_id": f"{subject_code}-IA1",
        "assessment_name": "Internal Assessment 1",
        "assessment_date": "2026-11-03",
        "score": 72,
        "max_score": 100,
        "is_demo": True,
        "synthetic_demo": True,
        "demo_seed_key": seed_key,
    })
    try:
        student_headers = student["headers"]
        faculty_headers = faculty["headers"]
        unrelated_headers = unrelated_faculty["headers"]

        attendance = client.get("/attendance/me", headers=student_headers)
        report = client.get("/academic-intelligence/me", headers=student_headers)
        timetable = client.get(f"/timetable?day={day}", headers=student_headers)
        assistant = client.post(
            "/assistant/chat",
            headers=student_headers,
            json={"message": "Show my subject-wise attendance", "day": day},
        )
        student_marks = client.post(
            "/assistant/chat",
            headers=student_headers,
            json={"message": "Show my marks", "day": day},
        )
        roster = client.get("/students", headers=faculty_headers)
        faculty_attendance = client.get("/attendance/records", headers=faculty_headers)
        faculty_report = client.get("/academic-intelligence/overview", headers=faculty_headers)
        faculty_assistant = client.post(
            "/assistant/chat",
            headers=faculty_headers,
            json={"message": "Which students have attendance below 75%?", "day": day},
        )
        faculty_student_count = client.post(
            "/assistant/chat",
            headers=faculty_headers,
            json={"message": "How many students are assigned to me?", "day": day},
        )
        unauthorized_student = client.get(
            f"/academic-intelligence/students/{student_id}",
            headers=unrelated_headers,
        )
        cross_student = client.get(
            f"/academic-intelligence/students/{other_student_id}",
            headers=student_headers,
        )

        assert attendance.status_code == 200, attendance.text
        assert attendance.json()["is_demo"] is True
        assert attendance.json()["summary"]["attendance_percentage"] == 62.5
        assert {row["subject_code"] for row in attendance.json()["records"]} == {
            subject_code,
            second_subject_code,
        }
        assert report.status_code == 200, report.text
        assert report.json()["is_demo"] is True
        assert report.json()["attendance"]["overall_percentage"] == 62.5
        assert report.json()["internal_marks"]["average_percentage"] == 72.0
        assert timetable.status_code == 200, timetable.text
        assert timetable.json()["is_demo"] is True
        assert len(timetable.json()["entries"]) == 2
        assert assistant.status_code == 200, assistant.text
        assert "Integration Demo Databases" in assistant.json()["reply"]
        assert assistant.json()["data_summary"]["is_demo"] is True
        assert student_marks.status_code == 200, student_marks.text
        assert student_marks.json()["intent"] == "marks_summary"
        assert "72.0%" in student_marks.json()["reply"]
        assert roster.status_code == 200, roster.text
        assert {row["student_id"] for row in roster.json()} == {
            student_id,
            other_student_id,
        }
        assert faculty_attendance.status_code == 200, faculty_attendance.text
        assert {row["subject_code"] for row in faculty_attendance.json()} == {
            subject_code,
            second_subject_code,
        }
        assert faculty_report.status_code == 200, faculty_report.text
        assert faculty_report.json()["is_demo"] is True
        assert faculty_report.json()["total_students_analyzed"] == 1
        assert faculty_assistant.status_code == 200, faculty_assistant.text
        assert f"Demo Student {suffix}" in faculty_assistant.json()["reply"]
        assert faculty_student_count.status_code == 200, faculty_student_count.text
        assert faculty_student_count.json()["intent"] == "assigned_student_count"
        assert "1 student(s)" in faculty_student_count.json()["reply"]
        assert unauthorized_student.status_code == 404
        assert cross_student.status_code == 404
    finally:
        attendance_collection.delete_many({"demo_seed_key": seed_key})
        attendance_entries_collection.delete_many({"demo_seed_key": seed_key})
        timetable_collection.delete_many({"demo_seed_key": seed_key})
        database["marks"].delete_many({"demo_seed_key": seed_key})
        users_collection.delete_one({"_id": ObjectId(student["id"])})
        users_collection.delete_one({"_id": ObjectId(faculty["id"])})
        users_collection.delete_one({"_id": ObjectId(unrelated_faculty["id"])})
        students_collection.delete_one({"student_id": student_id})
