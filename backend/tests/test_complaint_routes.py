import re
from copy import deepcopy
from datetime import datetime, timezone

from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient

import routes.complaint_routes as complaint_routes
from dependencies.auth import get_current_user


def _value(document, key):
    value = document
    for part in key.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def _matches(document, query):
    for key, expected in query.items():
        if key == "$or":
            if not any(_matches(document, condition) for condition in expected):
                return False
            continue
        actual = _value(document, key)
        if isinstance(expected, dict):
            if "$in" in expected and actual not in expected["$in"]:
                return False
            if "$regex" in expected:
                options = re.IGNORECASE if expected.get("$options") == "i" else 0
                if not re.search(expected["$regex"], str(actual or ""), options):
                    return False
        elif actual != expected:
            return False
    return True


class Cursor:
    def __init__(self, documents):
        self.documents = documents

    def sort(self, field, direction):
        self.documents.sort(
            key=lambda item: item.get(field) or item.get("created_at"),
            reverse=direction < 0,
        )
        return self

    def skip(self, amount):
        self.documents = self.documents[amount:]
        return self

    def limit(self, amount):
        self.documents = self.documents[:amount]
        return self

    def __iter__(self):
        return iter(self.documents)


class Collection:
    def __init__(self, documents=()):
        self.documents = [deepcopy(item) for item in documents]

    def find(self, query=None):
        return Cursor([
            item for item in self.documents if _matches(item, query or {})
        ])

    def find_one(self, query, projection=None):
        return next(
            (item for item in self.documents if _matches(item, query)),
            None,
        )

    def count_documents(self, query):
        return sum(_matches(item, query) for item in self.documents)

    def insert_one(self, document):
        saved = deepcopy(document)
        saved["_id"] = ObjectId()
        self.documents.append(saved)
        return type("InsertResult", (), {"inserted_id": saved["_id"]})()

    def update_one(self, query, update):
        item = self.find_one(query)
        if item is None:
            return type("UpdateResult", (), {"matched_count": 0})()
        item.update(deepcopy(update.get("$set", {})))
        for field, value in update.get("$push", {}).items():
            item.setdefault(field, []).append(deepcopy(value))
        return type("UpdateResult", (), {"matched_count": 1})()


def _complaint(user, **overrides):
    now = datetime.now(timezone.utc)
    return {
        "_id": ObjectId(),
        "user_id": user["_id"],
        "student_id": user.get("student_id"),
        "student_name": user.get("name", ""),
        "student_email": user.get("email", ""),
        "category": "facilities",
        "title": "Broken classroom projector",
        "description": "The projector in room A101 does not turn on.",
        "status": "pending",
        "assigned_to": None,
        "assigned_staff_name": None,
        "resolution_notes": None,
        "responses": [],
        "created_at": now,
        "updated_at": now,
        **overrides,
    }


def _client(monkeypatch, user, complaints=(), users=()):
    complaint_collection = Collection(complaints)
    user_collection = Collection(users)
    monkeypatch.setattr(complaint_routes, "complaints_collection", complaint_collection)
    monkeypatch.setattr(complaint_routes, "users_collection", user_collection)
    app = FastAPI()
    app.include_router(complaint_routes.router)
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app), complaint_collection, user_collection


def _input(**overrides):
    return {
        "category": "facilities",
        "title": "Broken classroom projector",
        "description": "The projector in room A101 does not turn on.",
        **overrides,
    }


def test_student_creates_and_lists_only_own_complaints(monkeypatch):
    student = {
        "_id": ObjectId(),
        "role": "student",
        "student_id": "SYN-001",
        "name": "Synthetic Student",
        "email": "student@test.local",
    }
    other = {**student, "_id": ObjectId(), "student_id": "SYN-002"}
    client, complaints, _ = _client(
        monkeypatch, student, [_complaint(other, title="Another student's issue")]
    )

    created = client.post("/complaints", json=_input())
    assert created.status_code == 201
    assert created.json()["status"] == "pending"
    assert created.json()["student_id"] == "SYN-001"
    assert len(complaints.documents) == 2
    listed = client.get("/complaints")
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["id"] == created.json()["id"]


def test_admin_filters_assigns_updates_and_responds(monkeypatch):
    admin = {"_id": ObjectId(), "role": "admin", "name": "Test Admin"}
    student = {
        "_id": ObjectId(),
        "role": "student",
        "name": "Synthetic Student",
        "email": "student@test.local",
    }
    faculty = {"_id": ObjectId(), "role": "faculty", "name": "Synthetic Faculty"}
    complaint = _complaint(student)
    client, complaints, _ = _client(monkeypatch, admin, [complaint], [faculty])
    complaint_id = str(complaint["_id"])

    filtered = client.get("/complaints?search=PROJECTOR&category=facilities")
    assert filtered.status_code == 200
    assert filtered.json()["total"] == 1
    assert client.get("/complaints/stats").json() == {
        "total": 1, "pending": 1, "in_progress": 0, "resolved": 0, "rejected": 0,
    }

    assigned = client.patch(
        f"/complaints/{complaint_id}",
        json={"assigned_to": str(faculty["_id"]), "status": "in_progress"},
    )
    assert assigned.status_code == 200
    assert assigned.json()["assigned_staff_name"] == "Synthetic Faculty"
    assert assigned.json()["status"] == "in_progress"

    response = client.post(
        f"/complaints/{complaint_id}/responses",
        json={"message": "A technician has been notified.", "resolution_notes": "Replacement approved."},
    )
    assert response.status_code == 201
    updated = client.get(f"/complaints/{complaint_id}")
    assert updated.json()["responses"][0]["message"] == "A technician has been notified."
    assert updated.json()["resolution_notes"] == "Replacement approved."
    assert complaints.documents[0]["status"] == "in_progress"


def test_complaint_permissions_and_validation(monkeypatch):
    student = {
        "_id": ObjectId(),
        "role": "student",
        "name": "Synthetic Student",
        "email": "student@test.local",
    }
    other = {"_id": ObjectId(), "role": "student"}
    faculty = {"_id": ObjectId(), "role": "faculty"}
    complaint = _complaint(other)
    client, _, _ = _client(monkeypatch, student, [complaint])

    assert client.post("/complaints", json=_input(title="  ")).status_code == 422
    assert client.post("/complaints", json=_input(category="unknown")).status_code == 422
    assert client.get(f"/complaints/{complaint['_id']}").status_code == 404
    assert client.patch(f"/complaints/{complaint['_id']}", json={"status": "resolved"}).status_code == 403
    assert client.post(
        f"/complaints/{complaint['_id']}/responses",
        json={"message": "We will review this."},
    ).status_code == 403

    faculty_client, _, _ = _client(monkeypatch, faculty, [complaint])
    assert faculty_client.get("/complaints").status_code == 403
    assert faculty_client.post("/complaints", json=_input()).status_code == 403

    admin = {"_id": ObjectId(), "role": "admin"}
    admin_client, _, _ = _client(monkeypatch, admin, [complaint])
    assert admin_client.patch(
        f"/complaints/{complaint['_id']}", json={"status": "invalid"}
    ).status_code == 422
    assert admin_client.patch(
        f"/complaints/{complaint['_id']}", json={"assigned_to": "not-an-id"}
    ).status_code == 422
