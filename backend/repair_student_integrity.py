"""Apply the approved student-name and uniqueness-index plan locally.

Dry-run is the default. This utility is pinned to localhost smart_campus_test
and never edits student IDs, emails, accounts, or other collections.
"""

import argparse
import os
import random
import re
from collections import Counter, defaultdict
from collections.abc import Iterable
from typing import Any

from pymongo import ASCENDING
from pymongo.collation import Collation

LOCAL_MONGO_URL = "mongodb://127.0.0.1:27017/"
TEST_DATABASE_NAME = "smart_campus_test"
EXPECTED_DEPARTMENTS = {"MCA": 300, "MBA": 300, "B.Tech": 300}
APPROVED_RENAME_COUNT = 80
EMAIL_COLLATION = Collation(locale="en", strength=2)
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
STUDENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,50}$")

FIRST_NAMES = (
    "Aarohi", "Aarav", "Aditi", "Advait", "Akash", "Amrita", "Ananya", "Arjun",
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


def build_approved_name_mapping(
    students: Iterable[dict[str, Any]],
) -> list[tuple[Any, str, str, str]]:
    """Keep the first ID for each repeated name and plan unique replacements."""
    records = list(students)
    if len(records) != 900:
        raise ValueError(f"Expected 900 students, found {len(records)}")
    departments = Counter(student.get("department") for student in records)
    if departments != Counter(EXPECTED_DEPARTMENTS):
        raise ValueError(f"Unexpected department distribution: {departments}")

    grouped_names: dict[str, list[dict[str, Any]]] = defaultdict(list)
    existing_names = set()
    ids = set()
    emails = set()
    for student in records:
        for field in ("_id", "student_id", "name", "email"):
            if field not in student or student[field] is None:
                raise ValueError(f"Student record is missing {field}")
        if student["student_id"] in ids:
            raise ValueError(f"Duplicate student_id: {student['student_id']}")
        normalized_email = student["email"].strip().casefold()
        if normalized_email in emails:
            raise ValueError(f"Duplicate student email: {student['email']}")
        ids.add(student["student_id"])
        emails.add(normalized_email)
        normalized_name = student["name"].strip().casefold()
        grouped_names[normalized_name].append(student)
        existing_names.add(normalized_name)

    duplicates = []
    for normalized_name, group in sorted(grouped_names.items()):
        ordered_group = sorted(group, key=lambda student: student["student_id"])
        duplicates.extend(
            (student["_id"], student["student_id"], student["name"])
            for student in ordered_group[1:]
        )
    duplicates.sort(key=lambda item: (item[1], item[2]))
    if not duplicates:
        return []
    if len(duplicates) != APPROVED_RENAME_COUNT:
        raise ValueError(
            f"Expected {APPROVED_RENAME_COUNT} approved name changes, found {len(duplicates)}"
        )

    candidates = [
        f"{first} {surname}"
        for first in FIRST_NAMES
        for surname in SURNAMES
        if f"{first} {surname}".casefold() not in existing_names
    ]
    random.Random(20261027).shuffle(candidates)
    replacements = candidates[:len(duplicates)]
    if len(replacements) != len(duplicates):
        raise ValueError("Not enough unique replacement names")

    mapping = [
        (document_id, student_id, current_name, proposed_name)
        for (document_id, student_id, current_name), proposed_name
        in zip(duplicates, replacements)
    ]
    if len({name.casefold() for name in replacements}) != len(replacements):
        raise ValueError("Replacement names are not unique")
    return mapping


def validate_student_records(students: list[dict[str, Any]]) -> None:
    if len(students) != 900:
        raise ValueError(f"Expected 900 students, found {len(students)}")
    for student in students:
        for field in ("student_id", "name", "email", "department", "semester"):
            if field not in student or student[field] is None:
                raise ValueError(f"Student record is missing {field}")
        if not isinstance(student["student_id"], str) or not STUDENT_ID_PATTERN.fullmatch(
            student["student_id"]
        ):
            raise ValueError("Student record has an invalid student_id")
        if (
            not isinstance(student["email"], str)
            or not EMAIL_PATTERN.fullmatch(student["email"].strip())
        ):
            raise ValueError("Student record has an invalid email")
        if not isinstance(student["name"], str) or not student["name"].strip():
            raise ValueError("Student record has an invalid name")
        if student["department"] not in EXPECTED_DEPARTMENTS:
            raise ValueError("Student record has an invalid department")
        if (
            not isinstance(student["semester"], int)
            or isinstance(student["semester"], bool)
            or student["semester"] not in (1, 2, 3)
        ):
            raise ValueError("Student record has an invalid semester")

    ids = [student.get("student_id") for student in students]
    emails = [
        student.get("email", "").strip().casefold()
        for student in students
        if isinstance(student.get("email"), str)
    ]
    if len(set(ids)) != 900:
        raise ValueError("Student IDs are not unique")
    if len(emails) != 900 or len(set(emails)) != 900:
        raise ValueError("Student emails are missing or not unique")
    if Counter(student.get("department") for student in students) != Counter(EXPECTED_DEPARTMENTS):
        raise ValueError("Department distribution does not match the approved target")


def main(argv: list[str] | None = None, database_module=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="apply the approved plan")
    args = parser.parse_args(argv)

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
    students = list(collection.find({}))
    validate_student_records(students)
    mapping = build_approved_name_mapping(students)
    print(f"Target: localhost:27017/{TEST_DATABASE_NAME}.students")
    print(f"Student records preserved: {len(students)}")
    print(f"Approved name updates planned: {len(mapping)}")
    print("Approved index additions: unique student_id; unique case-insensitive email")
    if not args.apply:
        print("Dry run only. No database changes were made.")
        return 0

    indexes = collection.index_information()
    id_index = indexes.get("student_id_unique")
    if id_index and (
        id_index.get("key") != [("student_id", ASCENDING)]
        or not id_index.get("unique")
    ):
        raise RuntimeError("Existing student_id_unique index has an unexpected definition")
    if not id_index:
        collection.create_index(
            [("student_id", ASCENDING)],
            name="student_id_unique",
            unique=True,
        )
    email_index = indexes.get("student_email_unique_ci")
    email_collation = email_index.get("collation", {}) if email_index else {}
    if email_index and (
        email_index.get("key") != [("email", ASCENDING)]
        or not email_index.get("unique")
        or email_collation.get("locale") != "en"
        or email_collation.get("strength") != 2
    ):
        raise RuntimeError("Existing student_email_unique_ci index has an unexpected definition")
    if not email_index:
        collection.create_index(
            [("email", ASCENDING)],
            name="student_email_unique_ci",
            unique=True,
            collation=EMAIL_COLLATION,
        )

    renamed = 0
    for document_id, student_id, current_name, proposed_name in mapping:
        result = collection.update_one(
            {
                "_id": document_id,
                "student_id": student_id,
                "name": current_name,
            },
            {"$set": {"name": proposed_name}},
        )
        if result.matched_count != 1:
            raise RuntimeError(f"Student changed since planning: {student_id}")
        renamed += result.modified_count

    final_students = list(collection.find({}))
    validate_student_records(final_students)
    if len({student.get("name", "").strip().casefold() for student in final_students}) != 900:
        raise RuntimeError("Final student names are not unique")
    if renamed != APPROVED_RENAME_COUNT:
        raise RuntimeError(f"Expected to rename 80 students, renamed {renamed}")
    print(f"Applied {renamed} name updates and verified both unique indexes.")
    return renamed


if __name__ == "__main__":
    main()
