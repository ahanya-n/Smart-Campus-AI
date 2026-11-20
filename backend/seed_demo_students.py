"""Safely add demo students to the isolated local smart_campus_test database.

The default is a dry run. Pass --apply to insert only the students needed to
reach 900 total (300 each for MCA, MBA, and B.Tech). No accounts are created.
"""

import argparse
import os
from collections import Counter
from collections.abc import Iterable
from typing import Any

LOCAL_MONGO_URL = "mongodb://127.0.0.1:27017/"
TEST_DATABASE_NAME = "smart_campus_test"
TARGET_TOTAL = 900
TARGET_DEPARTMENTS = {"MCA": 300, "MBA": 300, "B.Tech": 300}
STUDENT_FIELDS = {"student_id", "name", "email", "department", "semester"}

FIRST_NAMES = (
    "Aarav", "Aditi", "Aishwarya", "Akash", "Amrita", "Ananya", "Anil", "Arjun",
    "Bhavana", "Bharath", "Chaitanya", "Deepa", "Devika", "Divya", "Ekta", "Farhan",
    "Fathima", "Gaurav", "Gayathri", "Harish", "Hemanth", "Ishita", "Janani",
    "Karthik", "Kavya", "Kiran", "Komal", "Lakshmi", "Meera", "Nandini", "Nikhil",
    "Pallavi", "Pranav", "Priya", "Rahul", "Rashmi", "Riya", "Rohan", "Rohit",
    "Sagar", "Sanjay", "Sneha", "Swati", "Tanvi", "Uday", "Vaishnavi", "Varun",
    "Vikram", "Yamini", "Zoya", "Abhishek", "Aditya", "Amit", "Anushka", "Arnav",
    "Bina", "Chetan", "Disha", "Eshan", "Geetha", "Hitesh", "Indu", "Jayanth",
)

SURNAMES = (
    "Agarwal", "Ahmed", "Banerjee", "Bansal", "Bhat", "Bhatia", "Bose", "Chatterjee",
    "Choudhary", "Das", "Desai", "Deshmukh", "D'Souza", "Fernandes", "Gowda",
    "Hegde", "Iyer", "Jain", "Joshi", "Kaur", "Kapoor", "Khan", "Kulkarni",
    "Kumar", "Krishnan", "Malhotra", "Mathew", "Mehta", "Menon", "Mohan", "Mukherjee",
    "Naidu", "Nair", "Nambiar", "Nayak", "Pai", "Patil", "Pillai", "Prasad", "Rao",
    "Reddy", "Shah", "Sharma", "Shetty", "Sinha", "Singh", "Subramanian", "Tiwari",
    "Verma", "Yadav",
)


def build_student_inserts(
    students: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Create missing records while preserving all current records unchanged."""
    existing = list(students)
    if len(existing) > TARGET_TOTAL:
        raise ValueError(f"Found {len(existing)} students; target is {TARGET_TOTAL}")

    student_ids: set[str] = set()
    emails: set[str] = set()
    occupied_names: set[str] = set()
    department_counts: Counter[str] = Counter()
    for student in existing:
        for field in STUDENT_FIELDS - {"semester"}:
            if not isinstance(student.get(field), str) or not student[field]:
                raise ValueError(f"Student record must have a non-empty string {field!r}")
        if not isinstance(student.get("semester"), int) or isinstance(student["semester"], bool):
            raise ValueError("Student record must have an integer 'semester'")
        if student["semester"] not in (1, 2, 3):
            raise ValueError("Student semester must be 1, 2, or 3")
        student_id = student["student_id"]
        email = student["email"].casefold()
        if student_id in student_ids:
            raise ValueError(f"Duplicate student_id: {student_id}")
        if email in emails:
            raise ValueError(f"Duplicate email: {student['email']}")
        if student["department"] not in TARGET_DEPARTMENTS:
            raise ValueError(f"Unsupported department: {student['department']}")
        student_ids.add(student_id)
        emails.add(email)
        occupied_names.add(student["name"].casefold())
        department_counts[student["department"]] += 1

    for department, target_count in TARGET_DEPARTMENTS.items():
        if department_counts[department] > target_count:
            raise ValueError(
                f"{department} already has {department_counts[department]} students; "
                f"target is {target_count}"
            )

    needed_total = TARGET_TOTAL - len(existing)
    if needed_total == 0:
        if department_counts != Counter(TARGET_DEPARTMENTS):
            raise ValueError("900 existing students do not match the target distribution")
        return []

    name_candidates = (
        f"{first} {surname}"
        for first in FIRST_NAMES
        for surname in SURNAMES
    )
    names = []
    for candidate in name_candidates:
        normalized = candidate.casefold()
        if normalized not in occupied_names:
            names.append(candidate)
            occupied_names.add(normalized)
            if len(names) == needed_total:
                break
    if len(names) != needed_total:
        raise ValueError("Not enough unique demo names available")

    department_needs = {
        department: target_count - department_counts[department]
        for department, target_count in TARGET_DEPARTMENTS.items()
    }
    inserts = []
    name_index = 0
    id_suffix = 1
    for department, needed in department_needs.items():
        for _ in range(needed):
            while True:
                student_id = f"S{id_suffix:08d}"
                email = f"student{id_suffix:06d}@demo.smartcampus.test"
                id_suffix += 1
                if student_id not in student_ids and email.casefold() not in emails:
                    break
            student_ids.add(student_id)
            emails.add(email.casefold())
            inserts.append({
                "student_id": student_id,
                "name": names[name_index],
                "email": email,
                "department": department,
                "semester": name_index % 3 + 1,
            })
            name_index += 1

    final_departments = department_counts + Counter(
        student["department"] for student in inserts
    )
    if len(existing) + len(inserts) != TARGET_TOTAL:
        raise ValueError("Planned student count does not equal 900")
    if final_departments != Counter(TARGET_DEPARTMENTS):
        raise ValueError("Planned department distribution does not match target")
    if len(student_ids) != len(existing) + len(inserts) or len(emails) != len(existing) + len(inserts):
        raise ValueError("Planned student IDs or emails are not unique")
    return inserts


def _print_report(students: list[dict[str, Any]], inserts: list[dict[str, Any]]) -> None:
    current_departments = Counter(student["department"] for student in students)
    planned_departments = current_departments + Counter(
        student["department"] for student in inserts
    )
    all_ids = [student["student_id"] for student in students]
    all_emails = [student["email"].casefold() for student in students]
    planned_ids = all_ids + [student["student_id"] for student in inserts]
    planned_emails = all_emails + [student["email"].casefold() for student in inserts]
    print(f"Target database: {TEST_DATABASE_NAME}")
    print("Target host: localhost:27017")
    print(f"Current student count: {len(students)}")
    print(f"New records to insert: {len(inserts)}")
    print(f"Final student count: {len(students) + len(inserts)}")
    print("Final department totals:")
    for department in TARGET_DEPARTMENTS:
        print(f"  {department}: {planned_departments[department]}")
    print(f"Duplicate ID check: {'PASS' if len(set(planned_ids)) == len(planned_ids) else 'FAIL'}")
    print(f"Duplicate email check: {'PASS' if len(set(planned_emails)) == len(planned_emails) else 'FAIL'}")


def verify_final_students(
    students: list[dict[str, Any]],
) -> Counter[str]:
    if len(students) != TARGET_TOTAL:
        raise RuntimeError(f"Expected {TARGET_TOTAL} students, found {len(students)}")
    student_ids = [student.get("student_id") for student in students]
    emails = [
        student.get("email", "").casefold()
        for student in students
        if isinstance(student.get("email"), str)
    ]
    if len(set(student_ids)) != TARGET_TOTAL:
        raise RuntimeError("Final student IDs are not unique")
    if len(emails) != TARGET_TOTAL or len(set(emails)) != TARGET_TOTAL:
        raise RuntimeError("Final student emails are missing or not unique")
    if any(
        not isinstance(student.get("semester"), int)
        or isinstance(student.get("semester"), bool)
        or student["semester"] not in (1, 2, 3)
        for student in students
    ):
        raise RuntimeError("Final records contain an invalid semester")

    departments = Counter(student.get("department") for student in students)
    if departments != Counter(TARGET_DEPARTMENTS):
        raise RuntimeError(f"Final department distribution is incorrect: {departments}")
    return departments


def main(argv: list[str] | None = None, database_module=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="insert planned student records (default: report only)",
    )
    args = parser.parse_args(argv)

    # Pin this utility to the isolated local database regardless of .env settings.
    os.environ["MONGO_URL"] = LOCAL_MONGO_URL
    os.environ["MONGO_DB_NAME"] = TEST_DATABASE_NAME
    if database_module is None:
        import database as database_module

    if (
        database_module.MONGO_URL != LOCAL_MONGO_URL
        or database_module.MONGO_DB_NAME != TEST_DATABASE_NAME
    ):
        raise RuntimeError("Refusing to run outside localhost smart_campus_test")

    collection = database_module.students_collection
    students = list(collection.find({}, {"_id": 0}))
    inserts = build_student_inserts(students)
    _print_report(students, inserts)
    if not args.apply:
        print("Dry run only. Re-run with --apply after reviewing the plan.")
        return 0

    inserted_count = 0
    for student in inserts:
        result = collection.update_one(
            {"student_id": student["student_id"]},
            {"$setOnInsert": student},
            upsert=True,
        )
        inserted_count += int(result.upserted_id is not None)

    final_students = list(collection.find({}, {"_id": 0}))
    verify_final_students(final_students)
    final_by_id = {student["student_id"]: student for student in final_students}
    for student in inserts:
        if final_by_id.get(student["student_id"]) != student:
            raise RuntimeError(f"Inserted record verification failed: {student['student_id']}")
    for student in students:
        if final_by_id.get(student["student_id"]) != student:
            raise RuntimeError(f"Existing student changed: {student['student_id']}")
    print(
        f"Inserted {inserted_count} students; verified final count: "
        f"{len(final_students)} and department totals."
    )
    return inserted_count


if __name__ == "__main__":
    main()
