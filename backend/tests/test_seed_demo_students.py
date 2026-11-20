from collections import Counter
from types import SimpleNamespace

import pytest

from seed_demo_students import (
    LOCAL_MONGO_URL,
    TARGET_DEPARTMENTS,
    TARGET_TOTAL,
    TEST_DATABASE_NAME,
    build_student_inserts,
    main,
    verify_final_students,
)


def _existing_students(count=92):
    return [
        {
            "student_id": f"S{index:08x}A",
            "name": ("Rahul Kumar", "Priya Sharma", "Arjun Reddy")[index % 3],
            "email": f"existing{index}@test.local",
            "department": "MCA",
            "semester": index % 3 + 1,
        }
        for index in range(count)
    ]


def test_plan_adds_only_missing_records_with_target_distribution_and_schema():
    existing = _existing_students()
    existing_before = [student.copy() for student in existing]

    inserts = build_student_inserts(existing)

    assert len(existing) == 92
    assert existing == existing_before
    assert len(inserts) == 808
    assert Counter(student["department"] for student in inserts) == {
        "MCA": 208,
        "MBA": 300,
        "B.Tech": 300,
    }
    final_departments = Counter(student["department"] for student in existing + inserts)
    assert final_departments == Counter(TARGET_DEPARTMENTS)
    assert len(existing) + len(inserts) == TARGET_TOTAL

    existing_ids = {student["student_id"] for student in existing}
    existing_emails = {student["email"].casefold() for student in existing}
    new_ids = [student["student_id"] for student in inserts]
    new_emails = [student["email"].casefold() for student in inserts]
    existing_names = {student["name"].casefold() for student in existing}
    new_names = [student["name"].casefold() for student in inserts]
    assert not existing_ids.intersection(new_ids)
    assert not existing_emails.intersection(new_emails)
    assert len(set(new_ids)) == len(inserts)
    assert len(set(new_emails)) == len(inserts)
    assert len(set(new_names)) == len(inserts)
    assert not existing_names.intersection(new_names)
    assert all(set(student) == {
        "student_id", "name", "email", "department", "semester"
    } for student in inserts)
    assert all(student["semester"] in (1, 2, 3) for student in inserts)


def test_plan_is_repeatable_without_duplicate_records():
    existing = _existing_students()
    first_plan = build_student_inserts(existing)

    second_plan = build_student_inserts(existing + first_plan)

    assert second_plan == []


def test_final_verification_checks_900_records_and_distribution():
    planned = _existing_students() + build_student_inserts(_existing_students())

    assert verify_final_students(planned) == Counter(TARGET_DEPARTMENTS)


def test_default_main_is_dry_run_and_reports_distribution(capsys):
    class FakeCollection:
        def find(self, *_args):
            return _existing_students()

        def update_one(self, *_args, **_kwargs):
            pytest.fail("dry-run must not write student records")

    fake_database = SimpleNamespace(
        MONGO_URL=LOCAL_MONGO_URL,
        MONGO_DB_NAME=TEST_DATABASE_NAME,
        students_collection=FakeCollection(),
    )

    assert main(argv=[], database_module=fake_database) == 0
    output = capsys.readouterr().out
    assert "Target database: smart_campus_test" in output
    assert "Target host: localhost:27017" in output
    assert "Current student count: 92" in output
    assert "New records to insert: 808" in output
    assert "Final student count: 900" in output
    assert "MCA: 300" in output
    assert "MBA: 300" in output
    assert "B.Tech: 300" in output
    assert "Duplicate ID check: PASS" in output
    assert "Duplicate email check: PASS" in output
    assert "Dry run only" in output


def test_plan_rejects_duplicate_student_ids():
    existing = _existing_students()
    existing[1]["student_id"] = existing[0]["student_id"]

    with pytest.raises(ValueError, match="Duplicate student_id"):
        build_student_inserts(existing)


def test_plan_rejects_duplicate_emails_case_insensitively():
    existing = _existing_students()
    existing[1]["email"] = existing[0]["email"].upper()

    with pytest.raises(ValueError, match="Duplicate email"):
        build_student_inserts(existing)


def test_plan_rejects_invalid_existing_schema():
    existing = _existing_students()
    existing[0]["semester"] = True

    with pytest.raises(ValueError, match="integer 'semester'"):
        build_student_inserts(existing)


def test_plan_rejects_existing_records_above_department_target():
    existing = _existing_students(301)

    with pytest.raises(ValueError, match="MCA already has 301"):
        build_student_inserts(existing)


def test_main_refuses_non_test_database():
    fake_database = SimpleNamespace(
        MONGO_URL="mongodb://prod.example/",
        MONGO_DB_NAME="smart_campus",
        students_collection=None,
    )

    with pytest.raises(RuntimeError, match="Refusing to run"):
        main(argv=[], database_module=fake_database)
