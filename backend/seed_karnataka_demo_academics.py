"""Seed a connected synthetic MCA cohort into local smart_campus_test only.

The script preserves existing documents and passwords. It reports a dry run
unless called with --apply. Synthetic account passwords are random, hashed,
and never printed.
"""

import argparse
from datetime import date, datetime, time, timedelta, timezone
import secrets

from pwdlib import PasswordHash
from pymongo.errors import DuplicateKeyError


LOCAL_MONGO_URL = "mongodb://127.0.0.1:27017/"
DATABASE_NAME = "smart_campus_test"
LOCAL_DEMO_SEED_MARKER = "smart-campus-local-demo-v1"
DATASET_MARKER = "smart-campus-karnataka-academics-v1"
COURSE = "MCA"
ACADEMIC_YEAR = "2026-2027"
SECTION = "A"
DEMO_NOTE = "Synthetic Karnataka-style demo data; not real people or official records."
UTC = timezone.utc
SESSION_REFERENCE_DAY = date(2026, 11, 14)
STUDENT_START = 21
STUDENT_COUNT = 20

STUDENT_NAMES = (
    "Arjun Kumar", "Prajwal C", "Rakshitha S", "Darshan H", "Nandini R",
    "Kiran Kumar", "Meghana M", "Abhishek Gowda", "Sneha B", "Sanjay R",
    "Kavya M", "Rohan Shetty", "Ananya Rao", "Vignesh Hegde", "Pooja Patil",
    "Manjunath B", "Deepa N", "Akash Gowda", "Aishwarya R", "Harish Kumar",
)

SUBJECTS = (
    {"subject_code": "MCA101", "subject_name": "Programming in C", "semester": 1,
     "faculty_index": 0, "days": ("Monday", "Wednesday", "Friday"),
     "start_time": "09:00", "room_number": "MCA-Lab-1"},
    {"subject_code": "MCA102", "subject_name": "Mathematical Foundations", "semester": 1,
     "faculty_index": 1, "days": ("Tuesday", "Thursday", "Saturday"),
     "start_time": "10:30", "room_number": "MCA-201"},
    {"subject_code": "MCA103", "subject_name": "Computer Organization", "semester": 1,
     "faculty_index": 2, "days": ("Monday", "Thursday", "Saturday"),
     "start_time": "13:00", "room_number": "MCA-202"},
    {"subject_code": "MCA201", "subject_name": "Data Structures", "semester": 2,
     "faculty_index": 2, "days": ("Monday", "Wednesday", "Friday"),
     "start_time": "13:30", "room_number": "MCA-Lab-2"},
    {"subject_code": "MCA202", "subject_name": "Database Management Systems", "semester": 2,
     "faculty_index": 3, "days": ("Tuesday", "Thursday", "Saturday"),
     "start_time": "15:00", "room_number": "MCA-203"},
    {"subject_code": "MCA203", "subject_name": "Operating Systems", "semester": 2,
     "faculty_index": 4, "days": ("Monday", "Tuesday", "Friday"),
     "start_time": "16:30", "room_number": "MCA-204"},
)

FACULTY_SPECS = (
    {"faculty_id": "DEMO-MCA-FAC-0001", "name": "Demo Faculty",
     "email": "faculty.demo@smartcampus.test", "designation": "Assistant Professor"},
    {"faculty_id": "DEMO-MCA-FAC-0002", "name": "Dr. Nandini Hegde",
     "email": "faculty.mca02@demo.smartcampus.test", "designation": "Associate Professor"},
    {"faculty_id": "DEMO-MCA-FAC-0003", "name": "Prof. Raghavendra Bhat",
     "email": "faculty.mca03@demo.smartcampus.test", "designation": "Assistant Professor"},
    {"faculty_id": "DEMO-MCA-FAC-0004", "name": "Dr. Shilpa Shetty",
     "email": "faculty.mca04@demo.smartcampus.test", "designation": "Assistant Professor"},
    {"faculty_id": "DEMO-MCA-FAC-0005", "name": "Prof. Kiran Kumar",
     "email": "faculty.mca05@demo.smartcampus.test", "designation": "Assistant Professor"},
)

ASSESSMENTS = (
    ("IA-1", "Internal Assessment 1", 30, 35),
    ("IA-2", "Internal Assessment 2", 30, 21),
    ("ASSIGNMENT-1", "Programming Assignment", 20, 7),
)


def _demo_fields() -> dict:
    return {
        "is_demo": True,
        "synthetic_demo": True,
        "local_demo_seed": LOCAL_DEMO_SEED_MARKER,
        "demo_seed_key": DATASET_MARKER,
        "demo_note": DEMO_NOTE,
    }


def _student_rows() -> list[dict]:
    result = []
    for offset, name in enumerate(STUDENT_NAMES):
        sequence = STUDENT_START + offset
        student_id = f"20260MCA{sequence:04d}"
        semester = 1 if offset < STUDENT_COUNT // 2 else 2
        result.append({
            "student_id": student_id,
            "registration_number": student_id,
            "name": name,
            "email": f"student.{student_id.lower()}@demo.smartcampus.test",
            "department": COURSE,
            "course": COURSE,
            "semester": semester,
            "section": SECTION,
            "academic_year": ACADEMIC_YEAR,
            "class_id": _class_id(semester),
            "user_email": f"student.{student_id.lower()}@demo.smartcampus.test",
        })
    return result


def _class_id(semester: int) -> str:
    return f"DEMO-KA-MCA-S{semester}-A"


def _session_dates(days: tuple[str, ...], today: date) -> list[date]:
    day_numbers = {name: index for index, name in enumerate(
        ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
    )}
    dates = set()
    for day in days:
        target_weekday = day_numbers[day]
        most_recent = today - timedelta(days=(today.weekday() - target_weekday) % 7)
        if most_recent >= today:
            most_recent -= timedelta(days=7)
        dates.update(most_recent - timedelta(weeks=week) for week in range(6))
    return sorted(dates)


def _insert_if_missing(collection, key: dict, document: dict) -> bool:
    existing = collection.find_one(key, {"demo_seed_key": 1})
    if existing is not None and existing.get("demo_seed_key") != DATASET_MARKER:
        raise RuntimeError(
            f"Refusing to overwrite an existing {collection.name} record."
        )
    result = collection.update_one(
        key,
        {"$setOnInsert": {name: value for name, value in document.items() if name not in key}},
        upsert=True,
    )
    return result.upserted_id is not None


def _verify_existing_seed_record(collection, key: dict) -> dict | None:
    existing = collection.find_one(key)
    if existing is not None and (
        existing.get("demo_seed_key") != DATASET_MARKER
        or existing.get("is_demo") is not True
    ):
        raise RuntimeError(f"Refusing to use an existing unmarked {collection.name} record.")
    return existing


def _prepare_accounts(db, *, apply: bool) -> tuple[dict[str, dict], dict[str, dict]]:
    users = db["users"]
    faculty_by_id = {}
    faculty_by_subject = {}
    hash_password = PasswordHash.recommended().hash
    subject_codes_by_faculty = {
        spec["faculty_id"]: [
            subject["subject_code"] for subject in SUBJECTS
            if FACULTY_SPECS[subject["faculty_index"]]["faculty_id"] == spec["faculty_id"]
        ]
        for spec in FACULTY_SPECS
    }

    for spec in FACULTY_SPECS:
        existing = users.find_one({"email": spec["email"]}, {"password": 0})
        is_existing_demo_account = spec["email"] == "faculty.demo@smartcampus.test"
        if existing:
            if existing.get("role") != "faculty":
                raise RuntimeError(f"Refusing to reuse a non-faculty account for {spec['email']}.")
            if is_existing_demo_account:
                if existing.get("local_demo_seed") != LOCAL_DEMO_SEED_MARKER:
                    raise RuntimeError("The existing demo Faculty account is not seed-owned.")
            elif existing.get("demo_seed_key") != DATASET_MARKER:
                raise RuntimeError(f"Refusing to modify existing account {spec['email']}.")
            faculty = existing
        elif apply:
            document = {
                **spec,
                "role": "faculty",
                "password": hash_password(secrets.token_urlsafe(40)),
                "assigned_subject_codes": [],
                "assigned_class_ids": [],
                "department": COURSE,
                **_demo_fields(),
            }
            try:
                users.insert_one(document)
            except DuplicateKeyError:
                raced = users.find_one({"email": spec["email"]}, {"password": 0})
                if not raced or raced.get("demo_seed_key") != DATASET_MARKER:
                    raise RuntimeError(f"Account creation raced with an existing user: {spec['email']}")
            faculty = users.find_one({"email": spec["email"]}, {"password": 0})
        else:
            faculty = {"_id": f"planned-{spec['faculty_id']}", **spec}

        faculty_by_id[spec["faculty_id"]] = faculty
        for code in subject_codes_by_faculty[spec["faculty_id"]]:
            faculty_by_subject[code] = faculty

    if not apply:
        return faculty_by_id, faculty_by_subject

    for spec in FACULTY_SPECS:
        faculty = faculty_by_id[spec["faculty_id"]]
        class_ids = sorted({
            _class_id(subject["semester"])
            for subject in SUBJECTS
            if FACULTY_SPECS[subject["faculty_index"]]["faculty_id"] == spec["faculty_id"]
        })
        codes = subject_codes_by_faculty[spec["faculty_id"]]
        users.update_one(
            {"_id": faculty["_id"], "role": "faculty"},
            {
                "$set": {
                    "faculty_id": spec["faculty_id"],
                    "department": COURSE,
                    "designation": spec["designation"],
                    "is_demo": True,
                    "synthetic_demo": True,
                    "local_demo_seed": LOCAL_DEMO_SEED_MARKER,
                    "demo_seed_key": DATASET_MARKER,
                },
                "$addToSet": {
                    "assigned_subject_codes": {"$each": codes},
                    "assigned_class_ids": {"$each": class_ids},
                },
            },
        )
        faculty_by_id[spec["faculty_id"]] = users.find_one(
            {"_id": faculty["_id"]}, {"password": 0}
        )

    students_collection = db["students"]
    for student in _student_rows():
        existing_student = _verify_existing_seed_record(
            students_collection, {"student_id": student["student_id"]}
        )
        existing_user = users.find_one({"email": student["user_email"]}, {"password": 0})
        if existing_user:
            if (
                existing_user.get("role") != "student"
                or existing_user.get("student_id") != student["student_id"]
                or existing_user.get("demo_seed_key") != DATASET_MARKER
            ):
                raise RuntimeError(f"Refusing to modify existing account {student['user_email']}.")
        else:
            linked = users.find_one(
                {"student_id": student["student_id"]}, {"_id": 1, "email": 1}
            )
            if linked is not None:
                raise RuntimeError(f"Student {student['student_id']} is linked to another account.")
            user_document = {
                "name": student["name"],
                "email": student["user_email"],
                "role": "student",
                "student_id": student["student_id"],
                "registration_number": student["registration_number"],
                "password": hash_password(secrets.token_urlsafe(40)),
                **_demo_fields(),
            }
            try:
                users.insert_one(user_document)
            except DuplicateKeyError:
                raced = users.find_one(
                    {"email": student["user_email"]}, {"password": 0}
                )
                if not raced or raced.get("demo_seed_key") != DATASET_MARKER:
                    raise RuntimeError(f"Account creation raced with an existing user: {student['user_email']}")
            existing_user = users.find_one(
                {"email": student["user_email"]}, {"password": 0}
            )
        user_id = str(existing_user["_id"])
        if existing_student is None:
            student_document = {
                key: value for key, value in student.items()
                if key != "user_email"
            }
            student_document["user_id"] = user_id
            students_collection.insert_one({**student_document, **_demo_fields()})
        elif existing_student.get("user_id") != user_id:
            raise RuntimeError(f"Seeded student {student['student_id']} is linked inconsistently.")

    return faculty_by_id, faculty_by_subject


def _academic_documents(db, faculty_by_id: dict[str, dict]) -> dict[str, list[dict]]:
    students = _student_rows()
    student_users = {
        user["student_id"]: user
        for user in db["users"].find(
            {"student_id": {"$in": [student["student_id"] for student in students]}},
            {"password": 0},
        )
    }
    faculty_ids = {
        spec["faculty_id"]: str(faculty_by_id[spec["faculty_id"]]["_id"])
        for spec in FACULTY_SPECS
    }
    faculty_names = {spec["faculty_id"]: spec["name"] for spec in FACULTY_SPECS}
    docs: dict[str, list[dict]] = {
        name: [] for name in (
            "subjects", "classes", "faculty_subject_assignments", "enrollments",
            "timetable", "attendance", "attendance_entries", "marks",
        )
    }

    for subject in SUBJECTS:
        faculty_spec = FACULTY_SPECS[subject["faculty_index"]]
        docs["subjects"].append({
            **subject,
            "department": COURSE,
            "course": COURSE,
            "credits": 3,
            "academic_year": ACADEMIC_YEAR,
            **_demo_fields(),
        })

    for semester in (1, 2):
        class_students = [
            row for offset, row in enumerate(students)
            if (1 if offset < STUDENT_COUNT // 2 else 2) == semester
        ]
        class_subjects = [subject for subject in SUBJECTS if subject["semester"] == semester]
        class_faculty_ids = sorted({
            faculty_ids[FACULTY_SPECS[subject["faculty_index"]]["faculty_id"]]
            for subject in class_subjects
        })
        docs["classes"].append({
            "class_id": _class_id(semester),
            "department": COURSE,
            "course": COURSE,
            "semester": semester,
            "section": SECTION,
            "academic_year": ACADEMIC_YEAR,
            "student_ids": [row["student_id"] for row in class_students],
            "subject_codes": [subject["subject_code"] for subject in class_subjects],
            "faculty_user_ids": class_faculty_ids,
            "faculty_user_id": class_faculty_ids[0],
            "faculty_name": next(
                faculty_names[spec["faculty_id"]]
                for spec in FACULTY_SPECS
                if faculty_ids[spec["faculty_id"]] == class_faculty_ids[0]
            ),
            **_demo_fields(),
        })

    for subject in SUBJECTS:
        faculty_spec = FACULTY_SPECS[subject["faculty_index"]]
        faculty_user_id = faculty_ids[faculty_spec["faculty_id"]]
        class_id = _class_id(subject["semester"])
        docs["faculty_subject_assignments"].append({
            "faculty_user_id": faculty_user_id,
            "faculty_id": faculty_spec["faculty_id"],
            "faculty_name": faculty_names[faculty_spec["faculty_id"]],
            "subject_code": subject["subject_code"],
            "subject_name": subject["subject_name"],
            "class_id": class_id,
            "department": COURSE,
            "course": COURSE,
            "semester": subject["semester"],
            **_demo_fields(),
        })

        for day in subject["days"]:
            start_hour, start_minute = map(int, subject["start_time"].split(":"))
            end_minutes = start_hour * 60 + start_minute + 60
            end_hour, end_minute = divmod(end_minutes, 60)
            docs["timetable"].append({
                "department": COURSE,
                "course": COURSE,
                "semester": subject["semester"],
                "section": SECTION,
                "academic_year": ACADEMIC_YEAR,
                "class_id": class_id,
                "day_of_week": day,
                "subject_code": subject["subject_code"],
                "subject_name": subject["subject_name"],
                "start_time": subject["start_time"],
                "end_time": f"{end_hour:02d}:{end_minute:02d}",
                "faculty_user_id": faculty_user_id,
                "faculty_name": faculty_names[faculty_spec["faculty_id"]],
                "faculty_id": faculty_spec["faculty_id"],
                "room_number": subject["room_number"],
                "updated_at": datetime.now(UTC),
                **_demo_fields(),
            })

        dates = _session_dates(subject["days"], SESSION_REFERENCE_DAY)
        class_students = [
            student for student in students
            if student["semester"] == subject["semester"]
        ]
        start_hour, start_minute = map(int, subject["start_time"].split(":"))
        end_minutes = start_hour * 60 + start_minute + 60
        end_hour, end_minute = divmod(end_minutes, 60)
        for student_index, student in enumerate(class_students):
            user = student_users.get(student["student_id"])
            if user is None:
                raise RuntimeError(f"Missing linked Student account for {student['student_id']}.")
            attendance_index = (student_index + int(subject["subject_code"][-1]) * 2) % 6
            absent_count = attendance_index
            absent_indices = {
                (student_index + slot * 5) % len(dates)
                for slot in range(absent_count)
            } if absent_count else set()
            present_count = len(dates) - len(absent_indices)
            for session_index, session_date in enumerate(dates):
                docs["attendance_entries"].append({
                    "student_id": student["student_id"],
                    "student_name": student["name"],
                    "subject_code": subject["subject_code"],
                    "subject_name": subject["subject_name"],
                    "class_id": class_id,
                    "session_date": session_date.isoformat(),
                    "start_time": subject["start_time"],
                    "status": "absent" if session_index in absent_indices else "present",
                    "recorded_by": faculty_user_id,
                    "recorded_by_name": faculty_names[faculty_spec["faculty_id"]],
                    "created_at": datetime.combine(
                        session_date, time(start_hour, start_minute), tzinfo=UTC
                    ),
                    "updated_at": datetime.combine(
                        session_date, time(end_hour, end_minute), tzinfo=UTC
                    ),
                    **_demo_fields(),
                })
            docs["attendance"].append({
                "student_id": student["student_id"],
                "student_name": student["name"],
                "subject_code": subject["subject_code"],
                "subject_name": subject["subject_name"],
                "class_id": class_id,
                "total_classes": len(dates),
                "present_classes": present_count,
                "absent_classes": len(dates) - present_count,
                "attendance_percentage": round(present_count / len(dates) * 100, 2),
                "updated_at": datetime.now(UTC),
                **_demo_fields(),
            })

            for assessment_index, (assessment_id, assessment_name, maximum, days_ago) in enumerate(ASSESSMENTS):
                score = min(maximum, max(0, maximum - ((student_index * 3 + assessment_index * 5 + subject["semester"]) % (maximum // 2 + 1))))
                docs["marks"].append({
                    "student_id": student["student_id"],
                    "student_name": student["name"],
                    "subject_code": subject["subject_code"],
                    "subject_name": subject["subject_name"],
                    "class_id": class_id,
                    "assessment_id": f"{subject['subject_code']}-{assessment_id}",
                    "assessment_name": assessment_name,
                    "assessment_date": (SESSION_REFERENCE_DAY - timedelta(days=days_ago)).isoformat(),
                    "score": score,
                    "max_score": maximum,
                    "recorded_by": faculty_user_id,
                    "created_at": datetime.now(UTC),
                    "updated_at": datetime.now(UTC),
                    **_demo_fields(),
                })

        for student in class_students:
            docs["enrollments"].append({
                "student_id": student["student_id"],
                "registration_number": student["registration_number"],
                "student_name": student["name"],
                "user_id": str(student_users[student["student_id"]]["_id"]),
                "subject_code": subject["subject_code"],
                "subject_name": subject["subject_name"],
                "class_id": class_id,
                "department": COURSE,
                "course": COURSE,
                "semester": subject["semester"],
                "section": SECTION,
                "academic_year": ACADEMIC_YEAR,
                **_demo_fields(),
            })

    return docs


def _document_key(collection_name: str, document: dict) -> dict:
    if collection_name == "subjects":
        return {"subject_code": document["subject_code"]}
    if collection_name == "classes":
        return {"class_id": document["class_id"]}
    if collection_name == "faculty_subject_assignments":
        return {
            "faculty_user_id": document["faculty_user_id"],
            "subject_code": document["subject_code"],
            "is_demo": True,
        }
    if collection_name == "enrollments":
        return {
            "student_id": document["student_id"],
            "subject_code": document["subject_code"],
            "is_demo": True,
        }
    if collection_name == "timetable":
        return {
            "department": COURSE,
            "semester": document["semester"],
            "day_of_week": document["day_of_week"],
            "start_time": document["start_time"],
            "is_demo": True,
        }
    if collection_name == "attendance":
        return {
            "student_id": document["student_id"],
            "subject_code": document["subject_code"],
            "is_demo": True,
        }
    if collection_name == "attendance_entries":
        return {
            "student_id": document["student_id"],
            "subject_code": document["subject_code"],
            "session_date": document["session_date"],
            "start_time": document["start_time"],
        }
    if collection_name == "marks":
        return {
            "student_id": document["student_id"],
            "subject_code": document["subject_code"],
            "assessment_id": document["assessment_id"],
            "is_demo": True,
        }
    raise ValueError(f"Unsupported seed collection: {collection_name}")


def _preflight_academic_keys(db) -> dict[str, int]:
    missing = {
        name: 0 for name in (
            "subjects", "classes", "faculty_subject_assignments", "enrollments",
            "timetable", "attendance", "attendance_entries", "marks",
        )
    }

    def check(collection_name: str, collection, key: dict) -> dict | None:
        existing = _verify_existing_seed_record(collection, key)
        if existing is None:
            missing[collection_name] += 1
        return existing

    for subject in SUBJECTS:
        check(
            "subjects", db["subjects"], {"subject_code": subject["subject_code"]}
        )
        faculty_spec = FACULTY_SPECS[subject["faculty_index"]]
        existing_assignment = check(
            "faculty_subject_assignments",
            db["faculty_subject_assignments"],
            {"subject_code": subject["subject_code"], "is_demo": True},
        )
        if existing_assignment and (
            existing_assignment.get("demo_seed_key") != DATASET_MARKER
            or existing_assignment.get("faculty_id") != faculty_spec["faculty_id"]
            or existing_assignment.get("class_id") != _class_id(subject["semester"])
        ):
            raise RuntimeError(
                f"Refusing to reuse an existing faculty assignment for {subject['subject_code']}."
            )
        for day in subject["days"]:
            check("timetable", db["timetable"], {
                "department": COURSE,
                "semester": subject["semester"],
                "day_of_week": day,
                "start_time": subject["start_time"],
                "is_demo": True,
            })
        dates = _session_dates(subject["days"], SESSION_REFERENCE_DAY)
        class_students = [
            student for student in _student_rows()
            if student["semester"] == subject["semester"]
        ]
        for student in class_students:
            check("enrollments", db["enrollments"], {
                "student_id": student["student_id"],
                "subject_code": subject["subject_code"],
                "is_demo": True,
            })
            check("attendance", db["attendance"], {
                "student_id": student["student_id"],
                "subject_code": subject["subject_code"],
                "is_demo": True,
            })
            for session_date in dates:
                check("attendance_entries", db["attendance_entries"], {
                    "student_id": student["student_id"],
                    "subject_code": subject["subject_code"],
                    "session_date": session_date.isoformat(),
                    "start_time": subject["start_time"],
                })
            for assessment_id, _, _, _ in ASSESSMENTS:
                check("marks", db["marks"], {
                    "student_id": student["student_id"],
                    "subject_code": subject["subject_code"],
                    "assessment_id": f"{subject['subject_code']}-{assessment_id}",
                    "is_demo": True,
                })
    for semester in (1, 2):
        check("classes", db["classes"], {"class_id": _class_id(semester)})
    return missing


def seed_academics(db, *, apply: bool) -> dict[str, int]:
    if getattr(db, "name", None) != DATABASE_NAME:
        raise RuntimeError("Refusing to use a database other than smart_campus_test.")

    student_rows = _student_rows()
    student_ids = [student["student_id"] for student in student_rows]
    student_emails = [student["user_email"] for student in student_rows]
    faculty_emails = [spec["email"] for spec in FACULTY_SPECS]
    existing_student_profiles = db["students"].count_documents({
        "student_id": {"$in": student_ids},
    })
    existing_student_accounts = db["users"].count_documents({
        "email": {"$in": student_emails},
    })
    existing_faculty_accounts = db["users"].count_documents({
        "email": {"$in": faculty_emails},
    })

    for spec in FACULTY_SPECS:
        faculty = db["users"].find_one(
            {"email": spec["email"]}, {"password": 0}
        )
        if faculty:
            if faculty.get("role") != "faculty":
                raise RuntimeError(f"Refusing to reuse a non-faculty account for {spec['email']}.")
            is_existing_demo_account = spec["email"] == "faculty.demo@smartcampus.test"
            is_owned = (
                faculty.get("local_demo_seed") == LOCAL_DEMO_SEED_MARKER
                if is_existing_demo_account
                else faculty.get("demo_seed_key") == DATASET_MARKER
            )
            if not is_owned:
                raise RuntimeError(f"Refusing to modify existing account {spec['email']}.")

    for student in student_rows:
        existing = db["students"].find_one({"student_id": student["student_id"]})
        if existing and (
            existing.get("demo_seed_key") != DATASET_MARKER
            or existing.get("is_demo") is not True
        ):
            raise RuntimeError(f"Student ID collision: {student['student_id']}. Existing data was preserved.")
        account = db["users"].find_one(
            {"email": student["user_email"]}, {"password": 0}
        )
        if account and (
            account.get("demo_seed_key") != DATASET_MARKER
            or account.get("student_id") != student["student_id"]
            or account.get("role") != "student"
            or account.get("is_demo") is not True
        ):
            raise RuntimeError(f"Refusing to modify existing account {student['user_email']}.")
        linked_account = db["users"].find_one(
            {"student_id": student["student_id"]}, {"_id": 1, "email": 1}
        )
        if linked_account and linked_account.get("email") != student["user_email"]:
            raise RuntimeError(f"Student {student['student_id']} is linked to another account.")

    planned_academic_inserts = _preflight_academic_keys(db)

    if not apply:
        return {
            "student_profiles": STUDENT_COUNT - existing_student_profiles,
            "student_accounts": STUDENT_COUNT - existing_student_accounts,
            "faculty_accounts": len(FACULTY_SPECS) - existing_faculty_accounts,
            **planned_academic_inserts,
        }

    faculty_by_id, _ = _prepare_accounts(db, apply=True)
    for student in _student_rows():
        existing_user = db["users"].find_one({"email": student["user_email"]})
        if existing_user is None:
            raise RuntimeError(f"Missing account for {student['student_id']}.")
        existing_profile = db["students"].find_one({"student_id": student["student_id"]})
        if existing_profile is None:
            profile = {key: value for key, value in student.items() if key != "user_email"}
            profile["user_id"] = str(existing_user["_id"])
            db["students"].insert_one({**profile, **_demo_fields()})

    documents = _academic_documents(db, faculty_by_id)
    counts = {}
    for collection_name, records in documents.items():
        inserted = 0
        for document in records:
            key = _document_key(collection_name, document)
            inserted += int(_insert_if_missing(db[collection_name], key, document))
        counts[collection_name] = inserted

    verify_seed(db)
    counts.update({
        "student_profiles": db["students"].count_documents({
            "student_id": {"$in": student_ids},
        }) - existing_student_profiles,
        "student_accounts": db["users"].count_documents({
            "email": {"$in": student_emails},
        }) - existing_student_accounts,
        "faculty_accounts": db["users"].count_documents({
            "email": {"$in": faculty_emails},
        }) - existing_faculty_accounts,
    })
    return counts


def verify_seed(db) -> dict[str, int]:
    if getattr(db, "name", None) != DATABASE_NAME:
        raise RuntimeError("Refusing to verify a database other than smart_campus_test.")
    if db["users"].count_documents({
        "role": "student",
        "demo_seed_key": DATASET_MARKER,
        "is_demo": True,
    }) != STUDENT_COUNT:
        raise RuntimeError("Verification failed for demo Student accounts.")
    if db["users"].count_documents({
        "role": "faculty",
        "demo_seed_key": DATASET_MARKER,
        "is_demo": True,
    }) != len(FACULTY_SPECS):
        raise RuntimeError("Verification failed for demo Faculty accounts.")
    expected = {
        "students": STUDENT_COUNT,
        "subjects": len(SUBJECTS),
        "classes": 2,
        "faculty_subject_assignments": len(SUBJECTS),
        "enrollments": STUDENT_COUNT * (len(SUBJECTS) // 2),
        "timetable": sum(len(subject["days"]) for subject in SUBJECTS),
        "attendance": STUDENT_COUNT * (len(SUBJECTS) // 2),
        "attendance_entries": (STUDENT_COUNT // 2) * sum(
            len(_session_dates(subject["days"], SESSION_REFERENCE_DAY)) for subject in SUBJECTS
        ),
        "marks": STUDENT_COUNT * (len(SUBJECTS) // 2) * len(ASSESSMENTS),
    }
    verified = {}
    for collection_name, count in expected.items():
        query = {"demo_seed_key": DATASET_MARKER, "is_demo": True}
        actual = db[collection_name].count_documents(query)
        if actual != count:
            raise RuntimeError(
                f"Verification failed for {collection_name}: expected {count}, found {actual}."
            )
        verified[collection_name] = actual

    for student in db["students"].find({"demo_seed_key": DATASET_MARKER}):
        linked_user = db["users"].find_one(
            {"student_id": student["student_id"], "role": "student", "demo_seed_key": DATASET_MARKER},
            {"password": 0},
        )
        if not linked_user or str(linked_user["_id"]) != student.get("user_id"):
            raise RuntimeError(f"Student account relationship is invalid for {student['student_id']}.")
        if student["registration_number"] != student["student_id"]:
            raise RuntimeError(f"Registration number mismatch for {student['student_id']}.")
        if student["semester"] != (1 if int(student["student_id"][-4:]) <= 30 else 2):
            raise RuntimeError(f"Semester assignment is invalid for {student['student_id']}.")

    subject_semesters = {
        subject["subject_code"]: subject["semester"] for subject in SUBJECTS
    }
    for enrollment in db["enrollments"].find({"demo_seed_key": DATASET_MARKER}):
        student = db["students"].find_one({"student_id": enrollment["student_id"]})
        if (
            student is None
            or enrollment["semester"] != student["semester"]
            or subject_semesters.get(enrollment["subject_code"]) != student["semester"]
            or enrollment["class_id"] != student["class_id"]
        ):
            raise RuntimeError(f"Enrollment relationship is invalid for {enrollment['student_id']}.")
    for spec in FACULTY_SPECS:
        faculty = db["users"].find_one({
            "email": spec["email"],
            "role": "faculty",
            "demo_seed_key": DATASET_MARKER,
        }, {"password": 0})
        expected_codes = sorted(
            subject["subject_code"] for subject in SUBJECTS
            if FACULTY_SPECS[subject["faculty_index"]]["faculty_id"] == spec["faculty_id"]
        )
        expected_classes = sorted({
            _class_id(subject["semester"]) for subject in SUBJECTS
            if FACULTY_SPECS[subject["faculty_index"]]["faculty_id"] == spec["faculty_id"]
        })
        if (
            faculty is None
            or faculty.get("faculty_id") != spec["faculty_id"]
            or not set(expected_codes).issubset(faculty.get("assigned_subject_codes", []))
            or not set(expected_classes).issubset(faculty.get("assigned_class_ids", []))
        ):
            raise RuntimeError(f"Faculty assignment is invalid for {spec['faculty_id']}.")
    for mark in db["marks"].find({"demo_seed_key": DATASET_MARKER}):
        if not (0 <= mark["score"] <= mark["max_score"] and mark["max_score"] > 0):
            raise RuntimeError(f"Invalid assessment score for {mark['student_id']}.")
        if date.fromisoformat(mark["assessment_date"]) > date.today():
            raise RuntimeError(f"Future assessment mark found for {mark['student_id']}.")
    for entry in db["attendance_entries"].find({"demo_seed_key": DATASET_MARKER}):
        if date.fromisoformat(entry["session_date"]) > date.today():
            raise RuntimeError(f"Future attendance session found for {entry['student_id']}.")
    return verified


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="insert records; default is a dry run")
    args = parser.parse_args(argv)
    from pymongo import MongoClient

    client = MongoClient(LOCAL_MONGO_URL, serverSelectionTimeoutMS=5000)
    try:
        db = client[DATABASE_NAME]
        if db.name != DATABASE_NAME:
            raise RuntimeError("Refusing to use a database other than smart_campus_test.")
        result = seed_academics(db, apply=args.apply)
        print(f"Database: localhost/{DATABASE_NAME}")
        print("Mode: apply" if args.apply else "Mode: dry run")
        for name, count in sorted(result.items()):
            print(f"{name}: {count} new demo records")
        if args.apply:
            print("Verification: passed. Existing passwords were not read or modified.")
        else:
            print("No records changed. Re-run with --apply to seed this dataset.")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
