from datetime import date, timedelta

import pytest
from fastapi import HTTPException

from routes import academic_intelligence_routes
from services.academic_intelligence import analyze_student, generate_study_plan


def _student():
    return {
        "student_id": "DEMO-ACADEMIC-1",
        "name": "Synthetic Student",
        "department": "MCA",
        "semester": 1,
    }


def test_rule_baseline_explains_high_attendance_risk_and_missing_data():
    report = analyze_student(
        _student(),
        [{
            "subject_code": "MCA101",
            "subject_name": "Foundations",
            "present_classes": 1,
            "total_classes": 4,
        }],
        [{
            "session_date": date.today().isoformat(),
            "start_time": "09:00",
            "subject_code": "MCA101",
            "status": "present",
        }],
    )

    assert report["classification_type"] == "explainable_rule_based_baseline"
    assert report["risk_level"] == "high"
    assert report["attendance"]["overall_percentage"] == 25.0
    assert any("below 60%" in reason for reason in report["risk_reasons"])
    assert report["internal_marks"]["available"] is False
    assert report["attendance_trend"]["direction"] == "insufficient_data"
    assert any("internal exam marks" in item.lower() for item in report["data_limitations"])
    assert any("25.00%" in item for item in report["recommendations"])


def test_rule_baseline_detects_declining_trend_without_claiming_ml():
    start = date.today() - timedelta(days=7)
    entries = [
        {"session_date": (start + timedelta(days=index)).isoformat(),
         "start_time": "09:00",
         "subject_code": "MCA101",
         "status": "present" if index < 2 else "absent"}
        for index in range(4)
    ]

    report = analyze_student(_student(), [], entries)

    assert report["risk_level"] == "medium"
    assert report["attendance_trend"]["direction"] == "declining"


def test_marks_for_subject_without_attendance_are_included_and_validated():
    report = analyze_student(
        _student(),
        [],
        [],
        [
            {"subject_code": "MCA102", "subject_name": "Data", "score": 5, "max_score": 10},
            {"subject_code": "MCA103", "score": 90, "max_score": 0},
        ],
    )

    assert report["risk_level"] == "medium"
    assert report["subjects"] == [{
        "subject_code": "MCA102",
        "subject_name": "Data",
        "attendance_percentage": None,
        "present_classes": 0,
        "total_classes": 0,
        "marks_average": 50.0,
        "marks_available": True,
    }]
    assert report["internal_marks"]["assessment_count"] == 1


def test_invalid_legacy_values_do_not_break_or_inflate_analysis():
    report = analyze_student(
        _student(),
        [{"subject_code": "MCA101", "present_classes": "corrupt", "total_classes": None}],
        [],
        [
            {"subject_code": "MCA101", "score": float("nan"), "max_score": 100},
            {"subject_code": "", "score": 1, "max_score": 2},
        ],
    )

    assert report["risk_level"] == "insufficient_data"
    assert report["attendance"]["overall_percentage"] is None
    assert report["internal_marks"]["available"] is False
    assert report["data_quality"]["invalid_mark_records"] == 2


class _FakeCollection:
    def __init__(self, result):
        self.result = result
        self.query = None

    def find(self, query, projection=None):
        self.query = query
        return self.result

    def find_one(self, query, projection=None):
        return self.result

    def sort(self, *_args, **_kwargs):
        return self


class _SubjectCollection:
    def __init__(self, documents):
        self.documents = documents
        self.query = None

    def find(self, query, projection=None):
        self.query = query
        result = self.documents
        for field, expected in query.items():
            if field.startswith("$"):
                continue
            if isinstance(expected, dict) and "$in" in expected:
                result = [item for item in result if item.get(field) in expected["$in"]]
            elif isinstance(expected, dict) and "$ne" in expected:
                result = [item for item in result if item.get(field) != expected["$ne"]]
            elif expected is not None:
                result = [item for item in result if item.get(field) == expected]
        return result

    def find_one(self, query, projection=None):
        return next(iter(self.find(query, projection)), None)


def test_faculty_scope_uses_assigned_subject_rosters_and_filters_reports(monkeypatch):
    class_docs = [
        {"department": "MCA", "semester": 1, "subject_code": "MCA101"},
    ]
    attendance = _SubjectCollection([
        {"student_id": "STUDENT-A", "subject_code": "MCA101", "present_classes": 3, "total_classes": 4},
        {"student_id": "STUDENT-B", "subject_code": "MCA202", "present_classes": 0, "total_classes": 4},
    ])
    entries = _SubjectCollection([
        {"student_id": "STUDENT-C", "subject_code": "MCA101", "session_date": "2025-01-01", "status": "present"},
        {"student_id": "STUDENT-B", "subject_code": "MCA202", "session_date": "2025-01-01", "status": "absent"},
    ])
    marks = _SubjectCollection([
        {"student_id": "STUDENT-D", "subject_code": "MCA202", "score": 1, "max_score": 10},
    ])
    monkeypatch.setattr(academic_intelligence_routes, "_faculty_classes", lambda _user: class_docs)
    monkeypatch.setattr(academic_intelligence_routes, "attendance_collection", attendance)
    monkeypatch.setattr(academic_intelligence_routes, "attendance_entries_collection", entries)
    monkeypatch.setattr(academic_intelligence_routes, "marks_collection", marks)

    scope = academic_intelligence_routes._faculty_scope({"_id": "faculty-object-id"})

    assert scope["subject_codes"] == {"MCA101"}
    assert scope["student_ids"] == {"STUDENT-A", "STUDENT-C"}
    assert attendance.query["subject_code"] == {"$in": ["MCA101"]}

    student = {**_student(), "student_id": "STUDENT-A"}
    monkeypatch.setattr(
        academic_intelligence_routes,
        "students_collection",
        _FakeCollection(student),
    )
    report = academic_intelligence_routes._student_report(student, scope["subject_codes"])

    assert [item["subject_code"] for item in report["subjects"]] == ["MCA101"]
    assert attendance.query["synthetic_demo"] == {"$ne": True}


def test_faculty_scope_uses_only_owned_classes_and_unowned_assigned_subjects(monkeypatch):
    classes = [{
        "department": "MCA",
        "semester": 1,
        "subject_code": "MCA101",
        "faculty_user_id": "faculty-object-id",
    }]
    collection = _FakeCollection(classes)
    monkeypatch.setattr(academic_intelligence_routes, "timetable_collection", collection)

    result = academic_intelligence_routes._faculty_classes({
        "_id": "faculty-object-id",
        "assigned_subject_codes": ["MCA101", "MCA102"],
    })

    assert result == classes
    assert collection.query["$or"][0] == {"faculty_user_id": "faculty-object-id"}
    assert collection.query["$or"][1]["$and"][0]["$or"] == [
        {"faculty_user_id": None},
        {"faculty_user_id": {"$exists": False}},
    ]


def test_faculty_cannot_open_another_class_student(monkeypatch):
    student = _student()
    monkeypatch.setattr(
        academic_intelligence_routes,
        "students_collection",
        _FakeCollection(student),
    )
    monkeypatch.setattr(
        academic_intelligence_routes,
        "_faculty_classes",
        lambda _user: [{"department": "MBA", "semester": 1}],
    )

    with pytest.raises(HTTPException) as raised:
        academic_intelligence_routes._get_authorized_student(
            student["student_id"],
            {"_id": "faculty-object-id", "role": "faculty"},
        )

    assert raised.value.status_code == 404


def test_student_report_excludes_demo_and_synthetic_records(monkeypatch):
    student = {**_student(), "student_id": "STUDENT-FILTER"}
    attendance = _SubjectCollection([
        {
            "student_id": student["student_id"], "subject_code": "MCA101",
            "present_classes": 2, "total_classes": 4,
            "is_demo": False, "synthetic_demo": False,
        },
        {
            "student_id": student["student_id"], "subject_code": "MCA101",
            "present_classes": 100, "total_classes": 100,
            "is_demo": True, "synthetic_demo": False,
        },
        {
            "student_id": student["student_id"], "subject_code": "MCA101",
            "present_classes": 100, "total_classes": 100,
            "is_demo": False, "synthetic_demo": True,
        },
    ])
    entries = _SubjectCollection([])
    marks = _SubjectCollection([
        {
            "student_id": student["student_id"], "subject_code": "MCA101",
            "score": 100, "max_score": 100,
            "is_demo": False, "synthetic_demo": True,
        },
    ])
    monkeypatch.setattr(academic_intelligence_routes, "attendance_collection", attendance)
    monkeypatch.setattr(academic_intelligence_routes, "attendance_entries_collection", entries)
    monkeypatch.setattr(academic_intelligence_routes, "marks_collection", marks)

    report = academic_intelligence_routes._student_report(student)

    assert report["attendance"]["overall_percentage"] == 50.0
    assert report["internal_marks"]["available"] is False
    for collection in (attendance, entries, marks):
        assert collection.query["is_demo"] == {"$ne": True}
        assert collection.query["synthetic_demo"] == {"$ne": True}


def test_my_academic_report_does_not_label_synthetic_profile_as_official(monkeypatch):
    monkeypatch.setattr(
        academic_intelligence_routes,
        "find_linked_student",
        lambda _user: {"student_id": "STUDENT-SYNTHETIC", "synthetic_demo": True},
    )

    report = academic_intelligence_routes.my_academic_report(
        user={"role": "student"},
    )

    assert report["linked"] is False
    assert "synthetic/demo" in report["message"]
    assert "synthetic/demo" in report["risk_reasons"][0]


def test_invalid_attendance_counts_and_invalid_session_dates_are_excluded():
    report = analyze_student(
        _student(),
        [
            {"subject_code": "MCA101", "present_classes": 2, "total_classes": 3},
            {"subject_code": "MCA102", "present_classes": 2.5, "total_classes": 3},
            {"subject_code": "MCA103", "present_classes": 4, "total_classes": 3},
        ],
        [
            {"subject_code": "MCA101", "session_date": "not-a-date", "start_time": "09:00", "status": "present"},
            {"subject_code": "MCA101", "session_date": (date.today() + timedelta(days=1)).isoformat(), "start_time": "99:99", "status": "present"},
        ],
    )

    assert report["attendance"]["overall_percentage"] == 66.67
    assert report["data_quality"]["invalid_attendance_records"] == 2
    assert report["attendance_trend"]["direction"] == "insufficient_data"
    assert report["attendance_trend"]["sessions_analyzed"] == 0
    assert report["data_quality"]["invalid_attendance_sessions"] == 2


def test_study_plan_uses_actual_subject_signals_and_timetable_gaps():
    report = analyze_student(
        _student(),
        [{
            "subject_code": "MCA101",
            "subject_name": "Foundations",
            "present_classes": 1,
            "total_classes": 4,
        }],
        [],
        [{"subject_code": "MCA101", "subject_name": "Foundations", "score": 4, "max_score": 10}],
    )
    scheduled_day = (date.today() + timedelta(days=1)).strftime("%A")
    timetable = [
        {"day_of_week": scheduled_day, "start_time": "09:00", "end_time": "10:00"},
        {"day_of_week": scheduled_day, "start_time": "11:00", "end_time": "12:00"},
    ]

    plan = generate_study_plan(report, timetable)

    assert len(plan) == 7
    assert plan[0]["subject"] == "Foundations"
    assert "25.00%" in plan[0]["activity"]
    assert "40.00%" in plan[0]["activity"]
    assert plan[1]["day"] == scheduled_day
    assert plan[1]["time_window"] == "10:00 - 11:00"
    assert generate_study_plan(analyze_student(_student(), [], [], []), timetable) == []


def test_assistant_uses_verified_marks_and_excludes_synthetic_records(monkeypatch):
    from services import assistant_service

    class Collection:
        def __init__(self, documents):
            self.documents = documents
            self.query = None

        def find(self, query, _projection=None):
            self.query = query
            return [
                item for item in self.documents
                if item.get("student_id") == query.get("student_id")
                and item.get("is_demo") is not True
                and item.get("synthetic_demo") is not True
            ]

    attendance = Collection([
        {
            "student_id": "STUDENT-A", "subject_code": "MCA101",
            "subject_name": "Foundations", "present_classes": 2,
            "total_classes": 4, "is_demo": False, "synthetic_demo": False,
        },
        {
            "student_id": "STUDENT-A", "subject_code": "MCA101",
            "subject_name": "Foundations", "present_classes": 4,
            "total_classes": 4, "is_demo": False, "synthetic_demo": True,
        },
    ])
    entries = Collection([])
    marks = Collection([
        {
            "student_id": "STUDENT-A", "subject_code": "MCA101",
            "subject_name": "Foundations", "score": 5, "max_score": 10,
            "is_demo": False, "synthetic_demo": False,
        },
        {
            "student_id": "STUDENT-A", "subject_code": "MCA101",
            "subject_name": "Foundations", "score": 10, "max_score": 10,
            "is_demo": False, "synthetic_demo": True,
        },
    ])
    timetable = Collection([])

    class Database:
        def __getitem__(self, name):
            assert name == "marks"
            return marks

    monkeypatch.setattr(assistant_service, "attendance_collection", attendance)
    monkeypatch.setattr(assistant_service, "attendance_entries_collection", entries)
    monkeypatch.setattr(assistant_service, "timetable_collection", timetable)
    monkeypatch.setattr(assistant_service, "database", Database())

    response = assistant_service.process_assistant_query(
        "What are my internal marks?",
        {
            "student_id": "STUDENT-A",
            "name": "Synthetic Student",
            "department": "MCA",
            "semester": 1,
        },
    )

    assert response["provider"] == "grounded_rule_engine"
    assert response["intent"] == "marks_summary"
    assert "50.0%" in response["reply"]
    assert response["data_summary"]["overall_attendance"] == 50.0
    for collection in (attendance, entries, marks, timetable):
        assert collection.query["is_demo"] == {"$ne": True}
        assert collection.query["synthetic_demo"] == {"$ne": True}


def test_academic_overview_and_interventions_enforce_roles_and_validation(client, accounts, test_students):
    student = accounts.make("student")
    admin = accounts.make("admin")

    unauthenticated = client.get("/academic-intelligence/overview")
    forbidden = client.get("/academic-intelligence/overview", headers=student["headers"])
    denied_intervention = client.post(
        "/academic-intelligence/interventions",
        headers=student["headers"],
        json={"student_id": test_students["ids"][0], "note": "Should not be recorded"},
    )
    blank_intervention = client.post(
        "/academic-intelligence/interventions",
        headers=admin["headers"],
        json={"student_id": test_students["ids"][0], "note": "   "},
    )
    blank_mentor = client.post(
        "/academic-intelligence/mentor",
        headers=student["headers"],
        json={"message": "   "},
    )
    overview = client.get(
        f"/academic-intelligence/overview?search={test_students['ids'][0]}",
        headers=admin["headers"],
    )

    assert unauthenticated.status_code == 401
    assert forbidden.status_code == 403
    assert denied_intervention.status_code == 403
    assert blank_intervention.status_code == 422
    assert blank_mentor.status_code == 422
    assert overview.status_code == 200
    assert overview.json()["total_students_analyzed"] == 1
    assert overview.json()["students"][0]["student"]["student_id"] == test_students["ids"][0]
    assert overview.json()["model_evaluation"]["status"] == "not_evaluated"


def test_assistant_allows_faculty_and_ignores_client_student_ids(
    client, accounts, test_students, make_student
):
    from database import students_collection

    faculty = accounts.make("faculty")
    admin = accounts.make("admin")
    own_id = make_student()
    student = accounts.make("student", student_id=own_id)

    faculty_response = client.post(
        "/assistant/chat",
        headers=faculty["headers"],
        json={"message": "What is my attendance?"},
    )
    admin_response = client.post(
        "/assistant/chat",
        headers=admin["headers"],
        json={"message": "What is my attendance?"},
    )
    student_response = client.post(
        "/assistant/chat?demo=true",
        headers=student["headers"],
        json={
            "message": "What is my academic performance?",
            "student_id": test_students["ids"][1],
        },
    )

    assert faculty_response.status_code == 200
    assert faculty_response.json()["intent"] == "attendance_summary"
    assert admin_response.status_code == 403
    assert student_response.status_code == 200
    own_name = students_collection.find_one({"student_id": own_id})["name"]
    assert student_response.json()["data_summary"]["student_name"] == own_name


def test_student_report_and_mentor_use_only_the_linked_student(client, accounts, make_student):
    own_id, other_id = make_student(), make_student()
    student = accounts.make("student", student_id=own_id)

    own_report = client.get("/academic-intelligence/me", headers=student["headers"])
    other_report = client.get(
        f"/academic-intelligence/students/{other_id}",
        headers=student["headers"],
    )
    mentor = client.post(
        "/academic-intelligence/mentor",
        headers=student["headers"],
        json={"message": "Create a 7-day study plan"},
    )
    exam_guidance = client.post(
        "/academic-intelligence/mentor",
        headers=student["headers"],
        json={"message": "What should I focus on before exams?"},
    )

    assert own_report.status_code == 200
    assert own_report.json()["student"]["student_id"] == own_id
    assert other_report.status_code == 404
    assert mentor.status_code == 200
    assert mentor.json()["report"]["student"]["student_id"] == own_id
    assert mentor.json()["study_plan"] == []
    assert any("internal exam marks" in item.lower() for item in mentor.json()["data_limitations"])
    assert exam_guidance.status_code == 200
    assert exam_guidance.json()["intent"] == "exam_preparation"
    assert "Insufficient data" in exam_guidance.json()["reply"]
