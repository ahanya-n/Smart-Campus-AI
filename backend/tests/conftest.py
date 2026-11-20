"""Test setup. All tests run against a SEPARATE database (smart_campus_test) so
the real smart_campus data is never read or written. Every run uses unique
names, so nothing ever needs to be deleted."""

import os
import sys
import uuid
from pathlib import Path

os.environ["MONGO_DB_NAME"] = "smart_campus_test"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402

assert database.database.name == "smart_campus_test", "Tests must never use the real database"

from main import app  # noqa: E402
from services.user_service import create_user, set_assigned_subjects, link_student  # noqa: E402

PASSWORD = "Test-pass-123"


@pytest.fixture(scope="session")
def run_id() -> str:
    return uuid.uuid4().hex[:8]


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as test_client:  # runs the startup hook (indexes)
        yield test_client


class Accounts:
    """Creates users through the service layer and signs them in through the API."""

    def __init__(self, client: TestClient, run_id: str):
        self.client = client
        self.run_id = run_id
        self._n = 0

    def make(self, role: str, subjects: list[str] | None = None, student_id: str | None = None) -> dict:
        self._n += 1
        email = f"{role}{self._n}.{self.run_id}@test.local"
        user = create_user(f"Test {role.title()} {self._n}", email, PASSWORD, role)
        if subjects is not None:
            user = set_assigned_subjects(user["id"], subjects)
        if student_id is not None:
            user = link_student(user["id"], student_id)
        response = self.client.post("/login", json={"email": email, "password": PASSWORD})
        assert response.status_code == 200, response.text
        user["headers"] = {"Authorization": f"Bearer {response.json()['access_token']}"}
        return user


@pytest.fixture(scope="session")
def accounts(client, run_id) -> Accounts:
    return Accounts(client, run_id)


@pytest.fixture(scope="session")
def admin(accounts):
    return accounts.make("admin")


@pytest.fixture(scope="session")
def test_students(client, admin, run_id) -> dict:
    """Two student records in a valid department with unique test IDs."""
    department = "MCA"
    ids = [f"S{run_id}A", f"S{run_id}B"]
    for i, sid in enumerate(ids):
        response = client.post(
            "/students",
            headers=admin["headers"],
            json={"student_id": sid, "name": f"Student {'AB'[i]} {run_id}",
                  "email": f"{sid.lower()}@test.local", "department": department, "semester": 2},
        )
        assert response.status_code == 200, response.text
    return {"ids": ids, "department": department, "semester": 2,
            "subject": f"T{run_id[:6]}".upper(), "subject2": f"U{run_id[:6]}".upper()}


@pytest.fixture(scope="session")
def make_student(client, admin, run_id):
    count = 0

    def _maker():
        nonlocal count
        count += 1
        sid = f"STU{run_id[:4]}{count}"
        res = client.post(
            "/students",
            headers=admin["headers"],
            json={
                "student_id": sid,
                "name": f"Student {count}",
                "email": f"{sid.lower()}@test.local",
                "department": "MCA",
                "semester": 1,
            },
        )
        assert res.status_code == 200, res.text
        return sid

    return _maker
