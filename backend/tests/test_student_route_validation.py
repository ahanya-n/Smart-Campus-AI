import re
from datetime import date
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pymongo.errors import DuplicateKeyError

from routes import student_routes


def matches_filter(record, query):
    for key, expected in query.items():
        if key == "$and":
            if not all(matches_filter(record, part) for part in expected):
                return False
            continue
        if key == "$or":
            if not any(matches_filter(record, part) for part in expected):
                return False
            continue

        actual = record.get(key)
        if isinstance(expected, dict):
            if "$regex" in expected:
                if not re.match(expected["$regex"], str(actual or "")):
                    return False
            elif "$ne" in expected:
                if actual == expected["$ne"]:
                    return False
            elif "$in" in expected:
                if actual not in expected["$in"]:
                    return False
            elif "$exists" in expected:
                if (key in record) != expected["$exists"]:
                    return False
            else:
                return False
        elif actual != expected:
            return False
    return True


class FakeStudentsCollection:
    def __init__(self, records=None, duplicate_race=False):
        self.records = list(records or [])
        self.duplicate_race = duplicate_race

    def find_one(self, query, _projection=None, collation=None):
        for record in self.records:
            if "student_id" in query and record.get("student_id") == query["student_id"]:
                return {"_id": record.get("_id")}
            if "email" in query and record.get("email", "").casefold() == query["email"].casefold():
                assert collation.document == {"locale": "en", "strength": 2}
                return {"_id": record.get("_id")}
        return None

    def insert_one(self, record):
        if self.duplicate_race:
            raise DuplicateKeyError("duplicate key")
        self.records.append(record)
        return SimpleNamespace(inserted_id="new-student")

    def find(self, query, projection=None):
        records = [
            record for record in self.records
            if matches_filter(record, query)
        ]

        if projection and projection.get("_id") == 0:
            return [
                {key: value for key, value in record.items() if key != "_id"}
                for record in records
            ]
        return records


class FakeStudentIdCounters:
    def __init__(self):
        self.values = {}

    def update_one(self, query, update, upsert):
        key = query["_id"]
        self.values[key] = max(
            self.values.get(key, 0),
            update["$max"]["value"],
        )

    def find_one_and_update(self, query, update, return_document):
        key = query["_id"]
        self.values[key] += update["$inc"]["value"]
        value = self.values[key]
        return {"value": value}

    def find(self, _query, projection=None):
        assert projection == {"_id": 0}
        return [
            {key: value for key, value in record.items() if key != "_id"}
            for record in self.records
            if not _query or record.get("student_id") == _query.get("student_id")
        ]


def _input(**overrides):
    data = {
        "student_id": "MCA901",
        "name": "  Asha Rao  ",
        "email": "ASHA.RAO@example.test",
        "department": "MCA",
        "semester": 1,
    }
    data.update(overrides)
    return data


def test_student_input_normalizes_values_and_keeps_existing_response_contract(monkeypatch):
    collection = FakeStudentsCollection()
    monkeypatch.setattr(student_routes, "students_collection", collection)
    payload = student_routes.StudentInput.model_validate(_input())

    result = student_routes.add_student(payload, {})

    assert collection.records == [{
        "student_id": "MCA901",
        "name": "Asha Rao",
        "email": "asha.rao@example.test",
        "department": "MCA",
        "semester": 1,
    }]
    assert result == {
        "message": "Student added successfully",
        "id": "new-student",
        "student_id": "MCA901",
    }


def test_student_route_generates_next_id_from_existing_sequence(monkeypatch):
    prefix = f"{date.today().year}0MCA"
    collection = FakeStudentsCollection(
        [{"student_id": f"{prefix}0003", "email": "existing@example.test"}]
    )
    counters = FakeStudentIdCounters()
    monkeypatch.setattr(student_routes, "students_collection", collection)
    monkeypatch.setattr(student_routes, "student_id_counters", counters)
    data = _input()
    data.pop("student_id")

    result = student_routes.add_student(
        student_routes.StudentInput.model_validate(data),
        {},
    )
    next_data = _input(email="mina@example.test")
    next_data.pop("student_id")
    next_result = student_routes.add_student(
        student_routes.StudentInput.model_validate(next_data),
        {},
    )

    assert result["student_id"] == f"{prefix}0004"
    assert collection.records[-1]["student_id"] == f"{prefix}0005"
    assert next_result["student_id"] == f"{prefix}0005"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("student_id", "bad id"),
        ("email", "not-an-email"),
        ("department", "Engineering"),
        ("semester", 4),
        ("name", "  "),
    ],
)
def test_student_input_rejects_invalid_schema(field, value):
    with pytest.raises(ValueError):
        student_routes.StudentInput.model_validate(_input(**{field: value}))


def test_student_route_rejects_duplicate_student_id(monkeypatch):
    collection = FakeStudentsCollection([{"student_id": "MCA901", "email": "other@example.test"}])
    monkeypatch.setattr(student_routes, "students_collection", collection)

    with pytest.raises(HTTPException) as raised:
        student_routes.add_student(student_routes.StudentInput.model_validate(_input()), {})

    assert raised.value.status_code == 409
    assert raised.value.detail == "Student ID already exists"


def test_student_route_rejects_case_insensitive_duplicate_email(monkeypatch):
    collection = FakeStudentsCollection([{"student_id": "MCA900", "email": "Asha.Rao@Example.Test"}])
    monkeypatch.setattr(student_routes, "students_collection", collection)

    with pytest.raises(HTTPException) as raised:
        student_routes.add_student(student_routes.StudentInput.model_validate(_input()), {})

    assert raised.value.status_code == 409
    assert raised.value.detail == "Student email already exists"


def test_student_route_handles_duplicate_key_race(monkeypatch):
    collection = FakeStudentsCollection(duplicate_race=True)
    monkeypatch.setattr(student_routes, "students_collection", collection)

    with pytest.raises(HTTPException) as raised:
        student_routes.add_student(student_routes.StudentInput.model_validate(_input()), {})

    assert raised.value.status_code == 409
    assert raised.value.detail == "Student ID or email already exists"


def test_authorized_student_directory_returns_all_900_records(monkeypatch):
    collection = FakeStudentsCollection([
        {
            "_id": f"oid-{index}",
            "student_id": f"SC{index:04d}",
            "name": f"Student {index}",
            "email": f"student{index}@example.test",
            "department": ("MCA", "MBA", "B.Tech")[index // 300],
            "semester": index % 3 + 1,
        }
        for index in range(900)
    ])
    monkeypatch.setattr(student_routes, "students_collection", collection)
    app = FastAPI()
    app.include_router(student_routes.router)
    app.dependency_overrides[student_routes.get_current_user] = lambda: {"role": "admin"}

    response = TestClient(app).get("/students")

    assert response.status_code == 200
    assert len(response.json()) == 900
    assert "_id" not in response.json()[0]


@pytest.mark.parametrize(
    ("user", "expected_ids"),
    [
        ({"role": "student", "student_id": "MCA901"}, ["MCA901"]),
        ({"role": "student"}, []),
    ],
)
def test_student_directory_scopes_students_and_preserves_staff_access(
    monkeypatch,
    user,
    expected_ids,
):
    collection = FakeStudentsCollection([
        {
            "_id": "oid-1",
            "student_id": "MCA901",
            "name": "Asha Rao",
            "email": "asha@example.test",
            "department": "MCA",
            "semester": 1,
        },
        {
            "_id": "oid-2",
            "student_id": "MCA902",
            "name": "Rahul Das",
            "email": "rahul@example.test",
            "department": "MCA",
            "semester": 2,
        },
    ])
    monkeypatch.setattr(student_routes, "students_collection", collection)
    app = FastAPI()
    app.include_router(student_routes.router)
    app.dependency_overrides[student_routes.get_current_user] = lambda: user

    response = TestClient(app).get("/students")

    assert response.status_code == 200
    assert [row["student_id"] for row in response.json()] == expected_ids


def test_faculty_directory_is_limited_to_assigned_class_groups(monkeypatch):
    students = FakeStudentsCollection([
        {
            "_id": "oid-1",
            "student_id": "MCA901",
            "name": "Asha Rao",
            "email": "asha@example.test",
            "department": "MCA",
            "semester": 1,
        },
        {
            "_id": "oid-2",
            "student_id": "MBA901",
            "name": "Rahul Das",
            "email": "rahul@example.test",
            "department": "MBA",
            "semester": 1,
        },
        {
            "_id": "oid-3",
            "student_id": "MCA902",
            "name": "Synthetic Student",
            "email": "synthetic@example.test",
            "department": "MCA",
            "semester": 1,
            "synthetic_demo": True,
        },
    ])
    timetable = SimpleNamespace(
        find=lambda query, _projection: [
            {"department": "MCA", "semester": 1},
            {"department": "MBA", "semester": 1},
        ]
    )
    monkeypatch.setattr(student_routes, "students_collection", students)
    monkeypatch.setattr(student_routes, "timetable_collection", timetable)
    app = FastAPI()
    app.include_router(student_routes.router)
    app.dependency_overrides[student_routes.get_current_user] = lambda: {
        "role": "faculty",
        "_id": "faculty-1",
        "assigned_subject_codes": ["MCA101"],
    }

    response = TestClient(app).get("/students")

    assert response.status_code == 200
    assert [row["student_id"] for row in response.json()] == ["MCA901", "MBA901"]
