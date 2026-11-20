"""Seed the existing local demo Faculty and Student with connected synthetic data.

The script is pinned to localhost:27017/smart_campus_test. It never creates or
changes account passwords and uses set-on-insert for all academic records.

Run with --apply to insert the records:
    .venv\\Scripts\\python.exe seed_connected_demo_academics.py --apply
"""

import argparse
from datetime import date, datetime, time, timedelta, timezone
import os

LOCAL_MONGO_URL = "mongodb://127.0.0.1:27017/"
DATABASE_NAME = "smart_campus_test"
SEED_MARKER = "smart-campus-local-demo-v1"
DATASET_MARKER = "smart-campus-connected-academics-v1"
FACULTY_EMAIL = "faculty.demo@smartcampus.test"
STUDENT_EMAIL = "student.demo@smartcampus.test"
STUDENT_ID = "DEMO-LOCAL-2026-001"
DEPARTMENT = "DEMO"
SEMESTER = 1
SECTION = "A"
DEMO_NOTE = "Synthetic demo data; illustrative only, not official academic records."
UTC = timezone.utc

SUBJECTS = (
    {
        "subject_code": "DEMO101",
        "subject_name": "Programming Fundamentals",
        "room_number": "C-101",
        "start_time": "09:00",
    },
    {
        "subject_code": "DEMO102",
        "subject_name": "Database Systems",
        "room_number": "Lab-2",
        "start_time": "10:30",
    },
    {
        "subject_code": "DEMO103",
        "subject_name": "Data Structures",
        "room_number": "C-203",
        "start_time": "13:30",
    },
)
TIMETABLE_DAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
ATTENDANCE_TOTALS = {
    "DEMO101": 21,
    "DEMO102": 15,
    "DEMO103": 18,
}
MARKS = (
    ("DEMO101", "Internal Assessment 1", "DEMO101-IA1", 78),
    ("DEMO101", "Internal Assessment 2", "DEMO101-IA2", 84),
    ("DEMO102", "Internal Assessment 1", "DEMO102-IA1", 58),
    ("DEMO102", "Internal Assessment 2", "DEMO102-IA2", 66),
    ("DEMO103", "Internal Assessment 1", "DEMO103-IA1", 72),
    ("DEMO103", "Internal Assessment 2", "DEMO103-IA2", 80),
)


def _insert_if_missing(collection, key: dict, document: dict) -> bool:
    existing = collection.find_one(key, {"demo_seed_key": 1})
    if existing is not None and existing.get("demo_seed_key") != DATASET_MARKER:
        raise RuntimeError(
            f"Refusing to overwrite an existing unmarked {collection.name} record."
        )
    result = collection.update_one(
        key,
        {"$setOnInsert": {key_name: value for key_name, value in document.items()
                          if key_name not in key}},
        upsert=True,
    )
    return result.upserted_id is not None


def _demo_fields() -> dict:
    return {
        "is_demo": True,
        "synthetic_demo": True,
        "demo_seed_key": DATASET_MARKER,
        "demo_note": DEMO_NOTE,
    }


def _attendance_dates() -> list[date]:
    start = date(2026, 10, 19)
    end = date(2026, 11, 14)
    return [
        start + timedelta(days=offset)
        for offset in range((end - start).days + 1)
        if (start + timedelta(days=offset)).weekday() < 6
    ]


def _attendance_document(
    student_id: str,
    subject: dict,
    session_date: date,
    index: int,
    faculty: dict,
) -> dict:
    code = subject["subject_code"]
    total = len(_attendance_dates())
    present_target = ATTENDANCE_TOTALS[code]
    present = index < present_target
    start_hour, start_minute = map(int, subject["start_time"].split(":"))
    end_minutes = start_hour * 60 + start_minute + 60
    end_hour, end_minute = divmod(end_minutes, 60)
    return {
        "student_id": student_id,
        "subject_code": code,
        "subject_name": subject["subject_name"],
        "session_date": session_date.isoformat(),
        "start_time": subject["start_time"],
        "status": "present" if present else "absent",
        "recorded_by": str(faculty["_id"]),
        "recorded_by_name": faculty.get("name", ""),
        "created_at": datetime.combine(
            session_date, time(start_hour, start_minute), tzinfo=UTC
        ),
        "updated_at": datetime.combine(
            session_date, time(end_hour, end_minute), tzinfo=UTC
        ),
        **_demo_fields(),
    }


def _verify_demo_accounts(db):
    faculty = db["users"].find_one({"email": FACULTY_EMAIL})
    student_user = db["users"].find_one({"email": STUDENT_EMAIL})
    student = db["students"].find_one({"student_id": STUDENT_ID})
    for record, role, email in (
        (faculty, "faculty", FACULTY_EMAIL),
        (student_user, "student", STUDENT_EMAIL),
    ):
        if not record or record.get("role") != role or record.get("email") != email:
            raise RuntimeError(f"Existing marked demo {role} account is required.")
        if record.get("local_demo_seed") != SEED_MARKER:
            raise RuntimeError(f"Refusing to modify unmarked account {email}.")
    if (
        not student
        or student.get("student_id") != STUDENT_ID
        or student.get("local_demo_seed") != SEED_MARKER
        or student_user.get("student_id") != STUDENT_ID
    ):
        raise RuntimeError("The existing marked demo Student profile is not linked correctly.")
    return faculty, student_user, student


def seed_academics(db, *, apply: bool) -> dict[str, int]:
    if getattr(db, "name", None) != DATABASE_NAME:
        raise RuntimeError("Refusing to use a database other than smart_campus_test.")
    faculty, student_user, student = _verify_demo_accounts(db)
    student_id = student["student_id"]
    faculty_id = str(faculty["_id"])

    insert_counts: dict[str, int] = {}
    if not apply:
        insert_counts.update({
            "subjects": len(SUBJECTS),
            "classes": 1,
            "faculty_subject_assignments": len(SUBJECTS),
            "enrollments": len(SUBJECTS),
            "timetable": len(TIMETABLE_DAYS) * len(SUBJECTS),
            "attendance_entries": len(_attendance_dates()) * len(SUBJECTS),
            "attendance": len(SUBJECTS),
            "marks": len(MARKS),
        })
        return insert_counts

    users = db["users"]
    students = db["students"]
    faculty_update = users.update_one(
        {
            "_id": faculty["_id"],
            "role": "faculty",
            "local_demo_seed": SEED_MARKER,
        },
        {
            "$set": {"is_demo": True, "synthetic_demo": True},
            "$addToSet": {"assigned_subject_codes": {"$each": [
                subject["subject_code"] for subject in SUBJECTS
            ]}},
        },
    )
    student_user_update = users.update_one(
        {
            "_id": student_user["_id"],
            "role": "student",
            "student_id": STUDENT_ID,
            "local_demo_seed": SEED_MARKER,
        },
        {"$set": {"is_demo": True, "synthetic_demo": True}},
    )
    student_update = students.update_one(
        {
            "_id": student["_id"],
            "student_id": STUDENT_ID,
            "local_demo_seed": SEED_MARKER,
        },
        {"$set": {"is_demo": True}},
    )
    if not all(
        result.matched_count == 1
        for result in (faculty_update, student_user_update, student_update)
    ):
        raise RuntimeError("Demo account ownership changed during seeding.")

    faculty = users.find_one({"_id": faculty["_id"]})
    student_name = student.get("name", "")
    subject_codes = [subject["subject_code"] for subject in SUBJECTS]
    current_time = datetime.now(UTC)

    def put(collection_name: str, key: dict, document: dict) -> None:
        insert_counts[collection_name] = insert_counts.get(collection_name, 0) + int(
            _insert_if_missing(db[collection_name], key, document)
        )

    for subject in SUBJECTS:
        subject_doc = {
            **subject,
            "department": DEPARTMENT,
            "semester": SEMESTER,
            "credits": 3,
            **_demo_fields(),
        }
        put("subjects", {"subject_code": subject["subject_code"]}, subject_doc)

    class_doc = {
        "class_id": "DEMO-MCA-S1-A",
        "department": DEPARTMENT,
        "semester": SEMESTER,
        "section": SECTION,
        "student_ids": [student_id],
        "subject_codes": subject_codes,
        "faculty_user_id": faculty_id,
        "faculty_name": faculty.get("name", ""),
        **_demo_fields(),
    }
    put("classes", {"class_id": class_doc["class_id"]}, class_doc)

    for subject in SUBJECTS:
        code = subject["subject_code"]
        assignment = {
            "faculty_user_id": faculty_id,
            "faculty_name": faculty.get("name", ""),
            "subject_code": code,
            "subject_name": subject["subject_name"],
            "department": DEPARTMENT,
            "semester": SEMESTER,
            **_demo_fields(),
        }
        put(
            "faculty_subject_assignments",
            {"faculty_user_id": faculty_id, "subject_code": code, "is_demo": True},
            assignment,
        )
        enrollment = {
            "student_id": student_id,
            "student_name": student_name,
            "subject_code": code,
            "subject_name": subject["subject_name"],
            "class_id": class_doc["class_id"],
            "department": DEPARTMENT,
            "semester": SEMESTER,
            **_demo_fields(),
        }
        put(
            "enrollments",
            {"student_id": student_id, "subject_code": code, "is_demo": True},
            enrollment,
        )

    for day_index, day in enumerate(TIMETABLE_DAYS):
        rotation = day_index % len(SUBJECTS)
        ordered_subjects = SUBJECTS[rotation:] + SUBJECTS[:rotation]
        for index, subject in enumerate(ordered_subjects):
            start_hour, start_minute = map(int, subject["start_time"].split(":"))
            start_minutes = start_hour * 60 + start_minute
            end_minutes = start_minutes + 60
            end_hour, end_minute = divmod(end_minutes, 60)
            timetable_doc = {
                "department": DEPARTMENT,
                "semester": SEMESTER,
                "section": SECTION,
                "class_id": class_doc["class_id"],
                "day_of_week": day,
                "subject_code": subject["subject_code"],
                "subject_name": subject["subject_name"],
                "start_time": subject["start_time"],
                "end_time": f"{end_hour:02d}:{end_minute:02d}",
                "faculty_name": faculty.get("name", ""),
                "faculty_user_id": faculty_id,
                "room_number": subject["room_number"],
                "updated_at": current_time,
                **_demo_fields(),
            }
            put(
                "timetable",
                {
                    "department": DEPARTMENT,
                    "semester": SEMESTER,
                    "day_of_week": day,
                    "start_time": subject["start_time"],
                    "is_demo": True,
                },
                timetable_doc,
            )

    sessions = _attendance_dates()
    for subject in SUBJECTS:
        code = subject["subject_code"]
        present_count = ATTENDANCE_TOTALS[code]
        aggregate = {
            "student_id": student_id,
            "subject_code": code,
            "subject_name": subject["subject_name"],
            "total_classes": len(sessions),
            "present_classes": present_count,
            "absent_classes": len(sessions) - present_count,
            "attendance_percentage": round(present_count / len(sessions) * 100, 2),
            "updated_at": current_time,
            **_demo_fields(),
        }
        put(
            "attendance",
            {"student_id": student_id, "subject_code": code, "is_demo": True},
            aggregate,
        )
        for index, session_date in enumerate(sessions):
            entry = _attendance_document(student_id, subject, session_date, index, faculty)
            put(
                "attendance_entries",
                {
                    "student_id": student_id,
                    "subject_code": code,
                    "session_date": session_date.isoformat(),
                    "start_time": subject["start_time"],
                    "is_demo": True,
                },
                entry,
            )

    for code, name, assessment_id, score in MARKS:
        subject = next(item for item in SUBJECTS if item["subject_code"] == code)
        mark = {
            "student_id": student_id,
            "subject_code": code,
            "subject_name": subject["subject_name"],
            "assessment_id": assessment_id,
            "assessment_name": name,
            "assessment_date": "2026-11-14",
            "score": score,
            "max_score": 100,
            "recorded_by": faculty_id,
            "created_at": current_time,
            "updated_at": current_time,
            **_demo_fields(),
        }
        put(
            "marks",
            {
                "student_id": student_id,
                "subject_code": code,
                "assessment_id": assessment_id,
                "is_demo": True,
            },
            mark,
        )

    return insert_counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="insert records; default is a dry run")
    args = parser.parse_args(argv)
    os.environ["MONGO_URL"] = LOCAL_MONGO_URL
    os.environ["MONGO_DB_NAME"] = DATABASE_NAME

    from pymongo import MongoClient

    client = MongoClient(LOCAL_MONGO_URL, serverSelectionTimeoutMS=5000)
    try:
        db = client[DATABASE_NAME]
        if db.name != DATABASE_NAME:
            raise RuntimeError("Refusing to access a database other than smart_campus_test.")
        result = seed_academics(db, apply=args.apply)
        print(f"Database: localhost/{DATABASE_NAME}")
        print("Mode: apply" if args.apply else "Mode: dry run")
        for collection_name, count in sorted(result.items()):
            print(f"{collection_name}: {count} new synthetic records")
        if not args.apply:
            print("No records were changed. Re-run with --apply to seed this dataset.")
        else:
            print("Existing passwords were not read or modified.")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
