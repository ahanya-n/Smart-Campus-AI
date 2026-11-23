from datetime import datetime, timezone
from typing import Literal

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from database import (
    attendance_collection,
    attendance_entries_collection,
    database,
    students_collection,
    timetable_collection,
)
from dependencies.auth import assigned_subjects, get_current_user, require_roles, user_role
from dependencies.student import find_linked_student
from services.academic_intelligence import (
    academic_mentor_response,
    analyze_student,
)
from services.data_filters import (
    LOCAL_DEMO_SEED_MARKER,
    is_local_demo_account,
    is_local_demo_student,
    non_synthetic_filter,
    visible_academic_filter,
)


router = APIRouter(prefix="/academic-intelligence", tags=["Academic Intelligence"])
staff_only = require_roles("admin", "faculty")
marks_collection = database["marks"]
interventions_collection = database["academic_interventions"]


class InterventionInput(BaseModel):
    student_id: str = Field(min_length=1, max_length=50)
    note: str = Field(min_length=1, max_length=2000)
    follow_up_status: Literal["pending", "in_progress", "completed"] = "pending"


class InterventionStatusUpdate(BaseModel):
    follow_up_status: Literal["pending", "in_progress", "completed"]


class MentorRequest(BaseModel):
    message: str = Field(min_length=1, max_length=500)


def _faculty_classes(user: dict) -> list[dict]:
    user_id = str(user["_id"])
    subjects = [code.upper() for code in assigned_subjects(user)]
    query = {
        **visible_academic_filter(user),
        "$or": [
            {"faculty_user_id": user_id},
            {
                "$and": [
                    {"$or": [{"faculty_user_id": None}, {"faculty_user_id": {"$exists": False}}]},
                    {"subject_code": {"$in": subjects}},
                ]
            },
        ],
    }
    return list(timetable_collection.find(query, {"_id": 0}))


def _faculty_scope(user: dict) -> dict:
    classes = _faculty_classes(user)
    subject_codes = {
        str(entry.get("subject_code", "")).upper()
        for entry in classes
        if entry.get("subject_code")
    }
    groups = {
        (entry.get("department"), entry.get("semester"))
        for entry in classes
    }
    student_ids = set()
    if subject_codes:
        academic_query = {
            "subject_code": {"$in": sorted(subject_codes)},
            **visible_academic_filter(user),
        }
        for collection in (
            attendance_collection,
            attendance_entries_collection,
            marks_collection,
        ):
            student_ids.update(
                item["student_id"]
                for item in collection.find(academic_query, {"student_id": 1})
                if item.get("student_id")
            )
    return {
        "classes": classes,
        "subject_codes": subject_codes,
        "groups": groups,
        "student_ids": student_ids,
    }


def _authorized_students(
    user: dict,
    department: str | None,
    semester: int | None,
    faculty_scope: dict | None = None,
) -> list[dict]:
    query: dict = {}
    if department:
        query["department"] = department
    if semester is not None:
        query["semester"] = semester

    if user_role(user) == "faculty":
        scope = faculty_scope or _faculty_scope(user)
        groups = {
            group
            for group in scope["groups"]
            if (not department or group[0] == department)
            and (semester is None or group[1] == semester)
        }
        student_ids = scope["student_ids"]
        if not groups or not student_ids:
            return []
        query["student_id"] = {"$in": sorted(student_ids)}
        if is_local_demo_account(user):
            query["local_demo_seed"] = LOCAL_DEMO_SEED_MARKER
        query["$or"] = [
            {"department": group_department, "semester": group_semester}
            for group_department, group_semester in groups
        ]
    return list(students_collection.find(query, {"_id": 0}))


def _student_report(student: dict, subject_codes: set[str] | None = None) -> dict:
    if (
        (student.get("is_demo") is True or student.get("synthetic_demo") is True)
        and not is_local_demo_student(student)
    ):
        return analyze_student(student, [], [], [])
    student_id = student["student_id"]
    academic_query = {
        "student_id": student_id,
        **visible_academic_filter(student),
    }
    if subject_codes is not None:
        academic_query["subject_code"] = {"$in": sorted(subject_codes)}
    attendance = list(attendance_collection.find(
        academic_query,
        {"_id": 0},
    ))
    entries = list(attendance_entries_collection.find(
        academic_query,
        {"_id": 0},
    ))
    marks = list(marks_collection.find(
        academic_query,
        {"_id": 0},
    ))
    return analyze_student(student, attendance, entries, marks)


def _get_authorized_student(
    student_id: str,
    user: dict,
    faculty_scope: dict | None = None,
) -> dict:
    if user_role(user) == "student":
        student = find_linked_student(user)
        if not student or student.get("student_id") != student_id:
            raise HTTPException(status_code=404, detail="Student report not found")
        return student

    student = students_collection.find_one({"student_id": student_id}, {"_id": 0})
    if student is None:
        raise HTTPException(status_code=404, detail="Student report not found")
    if user_role(user) == "faculty":
        scope = faculty_scope or _faculty_scope(user)
        if (
            (student.get("department"), student.get("semester")) not in scope["groups"]
            or student_id not in scope["student_ids"]
        ):
            raise HTTPException(status_code=404, detail="Student report not found")
    return student


@router.get("/me")
def my_academic_report(user: dict = Depends(require_roles("student"))):
    student = find_linked_student(user)
    if student is None or (
        (student.get("is_demo") is True or student.get("synthetic_demo") is True)
        and not is_local_demo_student(student)
    ):
        message = (
            "Your account is linked to a synthetic/demo student profile. "
            "Official academic records are unavailable; ask a college administrator "
            "to verify and relink your account."
            if student is not None
            else "Link your student record to view your academic report."
        )
        reason = (
            "The linked student profile is synthetic/demo data; official academic data is unavailable."
            if student is not None
            else "Student record is not linked; academic data is unavailable."
        )
        return {
            "linked": False,
            "message": message,
            "classification_type": "explainable_rule_based_baseline",
            "risk_level": "insufficient_data",
            "risk_reasons": [reason],
        }
    return {
        "linked": True,
        "is_demo": is_local_demo_student(student),
        **_student_report(student),
    }


def _mentor_answer(message: str, report: dict) -> dict:
    return academic_mentor_response(message, report)


@router.post("/mentor")
def academic_mentor(
    data: MentorRequest,
    user: dict = Depends(require_roles("student")),
):
    if not data.message.strip():
        raise HTTPException(status_code=422, detail="message cannot be blank")
    student = find_linked_student(user)
    if student is None:
        return {
            "linked": False,
            "reply": "Link your student record to receive personalized academic guidance. No academic data was used.",
            "intent": "unlinked",
            "risk_level": "insufficient_data",
            "study_plan": [],
            "recommendations": [],
            "data_limitations": ["Student record is not linked."],
            "report": None,
            "disclaimer": "Educational guidance only; recommendations are not guaranteed predictions.",
        }
    report = _student_report(student)
    sem = student.get("semester")
    try:
        sem_value = int(sem)
    except (TypeError, ValueError):
        sem_value = str(sem)
    timetable_filter = (
        visible_academic_filter(student)
        if is_local_demo_student(student)
        else non_synthetic_filter()
    )
    timetable_entries = list(timetable_collection.find(
            {
                "department": student.get("department"),
                "semester": sem_value,
                **timetable_filter,
            },
            {"_id": 0},
        ))
    response = academic_mentor_response(
        data.message.strip(),
        report,
        timetable_entries,
    )
    if not timetable_entries:
        response["data_limitations"] = list(dict.fromkeys([
            *response["data_limitations"],
            "Timetable data is unavailable for scheduling study blocks.",
        ]))
    return {
        "linked": True,
        "is_demo": is_local_demo_student(student),
        **response,
    }


@router.get("/overview")
def academic_overview(
    department: str | None = Query(None, max_length=50),
    semester: int | None = Query(None, ge=1, le=12),
    section: str | None = Query(None, max_length=30),
    search: str | None = Query(None, max_length=100),
    user: dict = Depends(staff_only),
):
    faculty_scope = _faculty_scope(user) if user_role(user) == "faculty" else None
    students = _authorized_students(user, department, semester, faculty_scope)
    section_supported = any(student.get("section") for student in students)
    if section:
        students = [student for student in students if student.get("section") == section]
    if search:
        normalized = search.casefold().strip()
        students = [
            student for student in students
            if normalized in str(student.get("student_id", "")).casefold()
            or normalized in str(student.get("name", "")).casefold()
            or normalized in str(student.get("email", "")).casefold()
        ]

    subject_codes = faculty_scope["subject_codes"] if faculty_scope else None
    reports = [_student_report(student, subject_codes) for student in students]
    counts = {
        risk: sum(report["risk_level"] == risk for report in reports)
        for risk in ("high", "medium", "low", "insufficient_data")
    }
    subject_values: dict[str, dict] = {}
    for report in reports:
        for subject in report["subjects"]:
            code = subject["subject_code"]
            aggregate = subject_values.setdefault(
                code,
                {
                    "subject_code": code,
                    "subject_name": subject["subject_name"],
                    "attendance_percentages": [],
                    "marks_percentages": [],
                },
            )
            if subject["attendance_percentage"] is not None:
                aggregate["attendance_percentages"].append(subject["attendance_percentage"])
            if subject["marks_average"] is not None:
                aggregate["marks_percentages"].append(subject["marks_average"])

    subject_overview = [
        {
            "subject_code": code,
            "subject_name": row["subject_name"],
            "students_with_attendance": len(row["attendance_percentages"]),
            "average_attendance": (
                round(sum(row["attendance_percentages"]) / len(row["attendance_percentages"]), 2)
                if row["attendance_percentages"] else None
            ),
            "students_with_marks": len(row["marks_percentages"]),
            "average_marks": (
                round(sum(row["marks_percentages"]) / len(row["marks_percentages"]), 2)
                if row["marks_percentages"] else None
            ),
        }
        for code, row in sorted(subject_values.items())
    ]

    interventions = {}
    for item in interventions_collection.find(
        {"student_id": {"$in": [report["student"]["student_id"] for report in reports]}},
        {"_id": 0},
    ).sort("updated_at", -1):
        interventions.setdefault(item["student_id"], item)
    for report in reports:
        report["latest_intervention"] = interventions.get(report["student"]["student_id"])

    risk_order = {"high": 0, "medium": 1, "low": 2, "insufficient_data": 3}
    reports.sort(key=lambda report: (risk_order[report["risk_level"]], report["student"]["name"].casefold()))
    return {
        "is_demo": is_local_demo_account(user),
        "classification_type": "explainable_rule_based_baseline",
        "model_evaluation": {
            "status": "not_evaluated",
            "reason": "No labelled outcome dataset is available; rule classifications are not trained predictions.",
            "train_test_split": None,
            "metrics": None,
        },
        "filters": {
            "department": department,
            "semester": semester,
            "section": section,
            "section_filter_supported": section_supported,
        },
        "total_students_analyzed": len(reports),
        "risk_counts": counts,
        "attendance_risk_distribution": {
            "below_75_percent": sum(
                report["attendance"]["overall_percentage"] is not None
                and report["attendance"]["overall_percentage"] < 75
                for report in reports
            ),
            "below_60_percent": sum(
                report["attendance"]["overall_percentage"] is not None
                and report["attendance"]["overall_percentage"] < 60
                for report in reports
            ),
            "no_attendance_data": sum(
                report["attendance"]["overall_percentage"] is None
                for report in reports
            ),
        },
        "subject_performance_overview": subject_overview,
        "academic_trends": {
            direction: sum(report["attendance_trend"]["direction"] == direction for report in reports)
            for direction in ("improving", "stable", "declining", "insufficient_data")
        },
        "students_requiring_intervention": [
            report for report in reports if report["risk_level"] in ("high", "medium")
        ],
        "students": reports,
    }


@router.get("/students/{student_id}")
def student_academic_report(
    student_id: str,
    user: dict = Depends(get_current_user),
):
    faculty_scope = _faculty_scope(user) if user_role(user) == "faculty" else None
    student = _get_authorized_student(student_id, user, faculty_scope)
    subject_codes = faculty_scope["subject_codes"] if faculty_scope else None
    return _student_report(student, subject_codes)


def _assert_can_manage_student(student_id: str, user: dict) -> dict:
    if user_role(user) not in ("admin", "faculty"):
        raise HTTPException(status_code=403, detail="This action requires the faculty or admin role.")
    faculty_scope = _faculty_scope(user) if user_role(user) == "faculty" else None
    student = _get_authorized_student(student_id, user, faculty_scope)
    return student


@router.get("/interventions")
def list_interventions(user: dict = Depends(staff_only)):
    if user_role(user) == "admin":
        query = {}
    else:
        ids = [student["student_id"] for student in _authorized_students(user, None, None)]
        query = {"student_id": {"$in": ids}}
    records = list(interventions_collection.find(query, {"_id": 0}).sort("updated_at", -1))
    return records


@router.post("/interventions", status_code=201)
def create_intervention(data: InterventionInput, user: dict = Depends(staff_only)):
    if not data.note.strip():
        raise HTTPException(status_code=422, detail="note cannot be blank")
    student = _assert_can_manage_student(data.student_id, user)
    now = datetime.now(timezone.utc)
    document = {
        "student_id": data.student_id,
        "student_name": student.get("name", ""),
        "note": data.note.strip(),
        "follow_up_status": data.follow_up_status,
        "created_by": str(user["_id"]),
        "created_by_name": user.get("name", ""),
        "created_at": now,
        "updated_at": now,
    }
    result = interventions_collection.insert_one(document)
    document["id"] = str(result.inserted_id)
    document.pop("_id", None)
    return document


@router.patch("/interventions/{intervention_id}")
def update_intervention(
    intervention_id: str,
    data: InterventionStatusUpdate,
    user: dict = Depends(staff_only),
):
    try:
        object_id = ObjectId(intervention_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail="Intervention not found")
    record = interventions_collection.find_one({"_id": object_id})
    if record is None:
        raise HTTPException(status_code=404, detail="Intervention not found")
    _assert_can_manage_student(record["student_id"], user)
    interventions_collection.update_one(
        {"_id": object_id},
        {"$set": {"follow_up_status": data.follow_up_status, "updated_at": datetime.now(timezone.utc)}},
    )
    record["follow_up_status"] = data.follow_up_status
    record["id"] = str(record.pop("_id"))
    return record
