from collections import Counter

import pytest

from repair_student_integrity import (
    EXPECTED_DEPARTMENTS,
    build_approved_name_mapping,
    validate_student_records,
)


def _records():
    duplicate_names = (
        "Rahul Kumar",
        "Priya Sharma",
        "Arjun Reddy",
        "Sneha Patil",
        "Kiran Kumar",
        "Ananya Rao",
        "Rohit Verma",
        "Pooja Nair",
        "Sanjay Gowda",
        "Divya Shetty",
        "Akash Singh",
        "Neha Kulkarni",
    )
    records = []
    for index in range(900):
        department = ("MCA", "MBA", "B.Tech")[index // 300]
        records.append({
            "_id": f"oid-{index}",
            "student_id": f"SC{index:04d}",
            "name": duplicate_names[index % len(duplicate_names)] if index < 92
            else f"Unique Person {index}",
            "email": f"student{index}@example.test",
            "department": department,
            "semester": index % 3 + 1,
        })
    return records


def test_approved_mapping_only_changes_duplicate_names_and_is_unique():
    records = _records()

    mapping = build_approved_name_mapping(records)

    assert len(mapping) == 80
    current_names = {record["name"].casefold() for record in records}
    proposed_names = [entry[3].casefold() for entry in mapping]
    assert len(set(proposed_names)) == 80
    assert not set(proposed_names).intersection(current_names)
    assert all(
        (document_id, student_id, old_name)
        == (record["_id"], record["student_id"], record["name"])
        for (document_id, student_id, old_name, _), record
        in zip(mapping, sorted(
            [record for record in records if record["name"] in {
                "Rahul Kumar", "Priya Sharma", "Arjun Reddy", "Sneha Patil",
                "Kiran Kumar", "Ananya Rao", "Rohit Verma", "Pooja Nair",
                "Sanjay Gowda", "Divya Shetty", "Akash Singh", "Neha Kulkarni",
            }],
            key=lambda item: (item["student_id"], item["name"]),
        )[12:])
    )


def test_approved_mapping_is_a_no_op_after_it_has_been_applied():
    records = _records()
    mapping = build_approved_name_mapping(records)
    records_by_id = {record["_id"]: record for record in records}
    for document_id, _student_id, _old_name, new_name in mapping:
        records_by_id[document_id]["name"] = new_name

    assert build_approved_name_mapping(records) == []


def test_student_integrity_check_accepts_target_distribution():
    records = _records()

    validate_student_records(records)

    assert Counter(record["department"] for record in records) == Counter(EXPECTED_DEPARTMENTS)


def test_student_integrity_check_rejects_duplicate_ids():
    records = _records()
    records[1]["student_id"] = records[0]["student_id"]

    with pytest.raises(ValueError, match="Duplicate student_id"):
        build_approved_name_mapping(records)


def test_student_integrity_check_rejects_duplicate_emails_case_insensitively():
    records = _records()
    records[1]["email"] = records[0]["email"].upper()

    with pytest.raises(ValueError, match="Duplicate student email"):
        build_approved_name_mapping(records)


def test_student_integrity_check_rejects_wrong_department_distribution():
    records = _records()
    records[0]["department"] = "MBA"

    with pytest.raises(ValueError, match="Unexpected department distribution"):
        build_approved_name_mapping(records)


def test_student_integrity_check_rejects_wrong_total():
    with pytest.raises(ValueError, match="Expected 900"):
        validate_student_records(_records()[:-1])


def test_student_integrity_check_rejects_invalid_semester():
    records = _records()
    records[0]["semester"] = 4

    with pytest.raises(ValueError, match="invalid semester"):
        validate_student_records(records)


def test_student_integrity_check_rejects_invalid_email():
    records = _records()
    records[0]["email"] = "not-an-email"

    with pytest.raises(ValueError, match="invalid email"):
        validate_student_records(records)
