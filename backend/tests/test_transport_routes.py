from copy import deepcopy

from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient

import routes.transport_routes as transport_routes
from dependencies.auth import get_current_user


def _value(document, key):
    value = document
    for part in key.split("."):
        if isinstance(value, list):
            return [item.get(part) for item in value if isinstance(item, dict)]
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


class Cursor:
    def __init__(self, documents):
        self.documents = documents

    def sort(self, field, direction):
        self.documents.sort(key=lambda item: item.get(field), reverse=direction < 0)
        return self

    def to_list(self):
        return self.documents

    def __iter__(self):
        return iter(self.documents)


class Collection:
    def __init__(self, documents=()):
        self.documents = [deepcopy(document) for document in documents]

    def _matches(self, document, query):
        for key, expected in query.items():
            actual = _value(document, key)
            if isinstance(expected, dict) and "$ne" in expected:
                values = actual if isinstance(actual, list) else [actual]
                if expected["$ne"] in values:
                    return False
            elif isinstance(expected, list):
                if actual != expected:
                    return False
            elif isinstance(expected, ObjectId):
                if actual != expected:
                    return False
            elif isinstance(actual, list):
                if expected not in actual:
                    return False
            elif actual != expected:
                return False
        return True

    def find(self, query=None):
        return Cursor([
            document for document in self.documents
            if self._matches(document, query or {})
        ])

    def find_one(self, query, projection=None):
        return next(
            (document for document in self.documents if self._matches(document, query)),
            None,
        )

    def insert_one(self, document):
        if "route_number" in document and any(
            item.get("route_number") == document["route_number"]
            for item in self.documents
        ):
            raise transport_routes.DuplicateKeyError("duplicate route number")
        if "assignments" in document and any(
            assignment["student_id"] == saved.get("student_id")
            for assignment in document["assignments"]
            for route in self.documents
            for saved in route.get("assignments", [])
        ):
            raise transport_routes.DuplicateKeyError("duplicate student assignment")
        saved = deepcopy(document)
        saved["_id"] = ObjectId()
        self.documents.append(saved)
        return type("InsertResult", (), {"inserted_id": saved["_id"]})()

    def update_one(self, query, update):
        document = next(
            (item for item in self.documents if self._matches(item, query)),
            None,
        )
        if document is None:
            return type("UpdateResult", (), {"matched_count": 0})()
        document.update(deepcopy(update.get("$set", {})))
        return type("UpdateResult", (), {"matched_count": 1})()

    def delete_one(self, query):
        document = next(
            (item for item in self.documents if self._matches(item, query)),
            None,
        )
        if document is not None:
            self.documents.remove(document)
        return type(
            "DeleteResult",
            (),
            {"deleted_count": int(document is not None)},
        )()

    def delete_one(self, query):
        document = next(
            (item for item in self.documents if self._matches(item, query)),
            None,
        )
        if document is not None:
            self.documents.remove(document)
        return type("DeleteResult", (), {"deleted_count": int(document is not None)})()


def make_client(monkeypatch, user, routes=(), students=()):
    route_collection = Collection(routes)
    student_collection = Collection(students)
    monkeypatch.setattr(transport_routes, "transport_collection", route_collection)
    monkeypatch.setattr(transport_routes, "students_collection", student_collection)
    app = FastAPI()
    app.include_router(transport_routes.router)
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app), route_collection, student_collection


def route_input(**overrides):
    return {
        "route_number": "R-12",
        "bus_number": "BUS-12",
        "registration_number": "TEST-REG-12",
        "pickup_points": ["North Gate", "Library"],
        "drop_points": ["Campus"],
        "driver": {"name": "Synthetic Driver", "phone": "+1 555 123 4567"},
        "capacity": 2,
        **overrides,
    }


def route_document(**overrides):
    return {
        "_id": ObjectId(),
        **route_input(),
        "assignments": [],
        **overrides,
    }


def test_transport_requires_auth_and_hides_driver_contact_and_roster(monkeypatch):
    route = route_document(assignments=[{
        "student_id": "TEST-STUDENT",
        "pickup_point": "Library",
        "drop_point": "Campus",
    }])
    client, _, _ = make_client(
        monkeypatch,
        {"_id": ObjectId(), "role": "student"},
        [route],
    )
    client.app.dependency_overrides.clear()
    assert client.get("/transport/routes").status_code == 401

    client, _, _ = make_client(
        monkeypatch,
        {"_id": ObjectId(), "role": "student"},
        [route],
    )
    response = client.get("/transport/routes")
    assert response.status_code == 200
    assert response.json()[0]["available_seats"] == 1
    assert response.json()[0]["driver"] == {"name": "Synthetic Driver"}
    assert "assignments" not in response.json()[0]


def test_admin_route_management_validates_and_preserves_assignments(monkeypatch):
    denied, _, _ = make_client(
        monkeypatch,
        {"_id": ObjectId(), "role": "faculty"},
    )
    assert denied.post("/transport/routes", json=route_input()).status_code == 403

    client, routes, _ = make_client(
        monkeypatch,
        {"_id": ObjectId(), "role": "admin"},
    )
    invalid = client.post("/transport/routes", json=route_input(capacity=0))
    assert invalid.status_code == 422

    created = client.post("/transport/routes", json=route_input())
    assert created.status_code == 201
    assert created.json()["available_seats"] == 2
    assert created.json()["driver"]["phone"] == "+1 555 123 4567"
    route_id = created.json()["id"]
    assert len(routes.documents) == 1
    assert client.post("/transport/routes", json=route_input()).status_code == 409

    updated = client.patch(
        f"/transport/routes/{route_id}",
        json=route_input(bus_number="BUS-UPDATED"),
    )
    assert updated.status_code == 200
    assert updated.json()["bus_number"] == "BUS-UPDATED"
    assert client.patch(
        f"/transport/routes/{route_id}",
        json=route_input(capacity=0),
    ).status_code == 422


def test_route_update_preserves_assignments_when_stop_case_changes(monkeypatch):
    route = route_document(assignments=[{
        "student_id": "TEST-STUDENT",
        "pickup_point": "Library",
        "drop_point": "Campus",
    }])
    client, routes, _ = make_client(
        monkeypatch,
        {"_id": ObjectId(), "role": "admin"},
        routes=[route],
    )

    updated = client.patch(
        f"/transport/routes/{route['_id']}",
        json=route_input(pickup_points=["NORTH GATE", "LIBRARY"], drop_points=["CAMPUS"]),
    )

    assert updated.status_code == 200
    assert routes.documents[0]["assignments"][0]["pickup_point"] == "LIBRARY"
    assert routes.documents[0]["assignments"][0]["drop_point"] == "CAMPUS"


def test_assignment_capacity_and_student_specific_transport(monkeypatch):
    admin = {"_id": ObjectId(), "role": "admin"}
    student_id = "TEST-STUDENT-1"
    route = route_document()
    client, routes, students = make_client(
        monkeypatch,
        admin,
        [route],
        [{"student_id": student_id}],
    )
    assignment = {
        "student_id": student_id,
        "pickup_point": "Library",
        "drop_point": "Campus",
    }
    assigned = client.post(
        f"/transport/routes/{route['_id']}/assignments",
        json=assignment,
    )
    assert assigned.status_code == 201
    assert len(students.documents) == 1
    assert routes.documents[0]["assignments"][0]["student_id"] == student_id
    assert client.post(
        f"/transport/routes/{route['_id']}/assignments",
        json=assignment,
    ).status_code == 409
    assert client.get("/transport/routes").json()[0]["assigned_seats"] == 1

    student_client, _, _ = make_client(
        monkeypatch,
        {"_id": ObjectId(), "role": "student", "student_id": student_id},
        [routes.documents[0]],
        [{"student_id": student_id}],
    )
    own = student_client.get("/transport/me")
    assert own.status_code == 200
    assert own.json()["assigned"] is True
    assert own.json()["assignment"]["pickup_point"] == "Library"
    assert "phone" not in own.json()["route"]["driver"]

    assert client.patch(
        f"/transport/routes/{route['_id']}",
        json=route_input(capacity=0),
    ).status_code == 422
    assert client.patch(
        f"/transport/routes/{route['_id']}",
        json=route_input(capacity=1, pickup_points=["North Gate"]),
    ).status_code == 409


def test_assignment_requires_existing_student_and_valid_points(monkeypatch):
    route = route_document()
    client, _, students = make_client(
        monkeypatch,
        {"_id": ObjectId(), "role": "admin"},
        [route],
    )
    body = {
        "student_id": "UNKNOWN",
        "pickup_point": "Unknown stop",
        "drop_point": "Campus",
    }
    assert client.post(
        f"/transport/routes/{route['_id']}/assignments",
        json=body,
    ).status_code == 404
    students.documents.append({"student_id": "KNOWN"})
    body["student_id"] = "KNOWN"
    assert client.post(
        f"/transport/routes/{route['_id']}/assignments",
        json=body,
    ).status_code == 422


def test_unassigned_student_and_admin_roster_operations(monkeypatch):
    route = route_document()
    student_client, _, _ = make_client(
        monkeypatch,
        {"_id": ObjectId(), "role": "student"},
        [route],
    )
    assert student_client.get("/transport/me").json() == {
        "assigned": False,
        "route": None,
        "assignment": None,
    }
    admin_client, routes, _ = make_client(
        monkeypatch,
        {"_id": ObjectId(), "role": "admin"},
        [route],
        [{"student_id": "TEST-STUDENT-2"}],
    )
    assert admin_client.delete(f"/transport/routes/{route['_id']}").status_code == 204
    assert routes.documents == []
