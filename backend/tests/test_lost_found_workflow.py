from copy import deepcopy
from datetime import datetime, timezone

from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient

import routes.lost_found_routes as lost_found_routes
import routes.notification_routes as notification_routes
import services.attendance_warning_service as attendance_warning_service
from dependencies.auth import get_current_user
from dependencies import student as student_dependencies
from routes import lost_found_workflow


def _matches(document, query):
    for key, expected in query.items():
        if key == "$or":
            if not any(_matches(document, branch) for branch in expected):
                return False
            continue
        if key == "$or":
            if not any(_matches(document, branch) for branch in expected):
                return False
            continue
        actual = document.get(key)
        if isinstance(expected, dict):
            if "$ne" in expected and actual == expected["$ne"]:
                return False
            if "$in" in expected and actual not in expected["$in"]:
                return False
        elif actual != expected:
            return False
    return True


class _Cursor:
    def __init__(self, documents):
        self.documents = documents

    def sort(self, field, direction):
        self.documents.sort(
            key=lambda item: item.get(field) or datetime.min.replace(tzinfo=timezone.utc),
            reverse=direction < 0,
        )
        return self

    def limit(self, amount):
        self.documents = self.documents[:amount]
        return self

    def __iter__(self):
        return iter(self.documents)


class _Collection:
    def __init__(self):
        self.documents = []

    def find(self, query=None):
        return _Cursor(
            [item for item in self.documents if _matches(item, query or {})]
        )

    def find_one(self, query, projection=None):
        return next(
            (item for item in self.documents if _matches(item, query)),
            None,
        )

    def insert_one(self, document):
        saved = deepcopy(document)
        saved["_id"] = ObjectId()
        self.documents.append(saved)
        return type("InsertResult", (), {"inserted_id": saved["_id"]})()

    def update_one(self, query, update):
        document = self.find_one(query)
        if document is None:
            return type(
                "UpdateResult",
                (),
                {"matched_count": 0, "modified_count": 0},
            )()
        document.update(deepcopy(update.get("$set", {})))
        return type(
            "UpdateResult",
            (),
            {"matched_count": 1, "modified_count": 1},
        )()


def _client(monkeypatch, tmp_path):
    collections = {
        "items": _Collection(),
        "matches": _Collection(),
        "claims": _Collection(),
        "notifications": _Collection(),
        "users": _Collection(),
    }
    monkeypatch.setattr(
        lost_found_workflow, "lost_found_items_collection", collections["items"]
    )
    monkeypatch.setattr(
        lost_found_workflow, "lost_found_matches_collection", collections["matches"]
    )
    monkeypatch.setattr(
        lost_found_workflow, "lost_found_claims_collection", collections["claims"]
    )
    monkeypatch.setattr(
        lost_found_workflow,
        "notifications_collection",
        collections["notifications"],
    )
    monkeypatch.setattr(
        lost_found_workflow, "users_collection", collections["users"]
    )
    monkeypatch.setattr(
        attendance_warning_service,
        "notifications_collection",
        collections["notifications"],
    )
    monkeypatch.setattr(
        student_dependencies, "find_linked_student", lambda _user: None
    )
    monkeypatch.setenv("LOST_FOUND_UPLOAD_DIR", str(tmp_path))
    monkeypatch.setattr(
        lost_found_workflow,
        "analyze_lost_found_image",
        lambda _data, _mime: {
            "predicted_category": "Bag",
            "predicted_item": "Backpack",
            "predicted_colour": "Blue",
            "visual_features": [],
            "analysis_status": "available",
            "model": "test",
            "confidence": 0.8,
            "limitations": [],
            "embedding": [1.0, 0.0],
        },
    )
    identity = {
        "user": {
            "_id": ObjectId(),
            "role": "student",
            "name": "Report owner",
            "student_id": "TEST-OWNER",
        }
    }
    app = FastAPI()
    app.include_router(lost_found_routes.router)
    app.include_router(notification_routes.router)
    app.dependency_overrides[get_current_user] = lambda: identity["user"]
    return TestClient(app), identity, collections


def _report(report_type, **overrides):
    return {
        "report_type": report_type,
        "item_name": "Blue backpack",
        "brand": "Campus",
        "description": "Blue backpack with a distinctive side pocket.",
        "category": "Bag",
        "colour": "Blue",
        "event_date": "2026-03-01",
        "event_time": "12:30",
        "location": "Library entrance",
        "additional_details": "Small green tag inside.",
        **overrides,
    }


def test_lost_found_reports_matches_and_claims_preserve_privacy(
    monkeypatch, tmp_path
):
    client, identity, collections = _client(monkeypatch, tmp_path)
    claimant = identity["user"]
    found_owner = {
        "_id": ObjectId(),
        "role": "student",
        "name": "Found item owner",
        "student_id": "TEST-FOUND",
    }
    collections["users"].documents.extend([claimant, found_owner])

    identity["user"] = found_owner
    found_response = client.post("/lost-found/", json=_report("found"))
    assert found_response.status_code == 201
    found_id = found_response.json()["id"]

    identity["user"] = claimant
    lost_response = client.post("/lost-found/", json=_report("lost"))
    assert lost_response.status_code == 201
    lost_id = lost_response.json()["id"]
    assert client.get("/lost-found/my-reports").json()["total"] == 1

    matches = client.get(f"/lost-found/{lost_id}/matches")
    assert matches.status_code == 200
    result = matches.json()
    assert result["items"][0]["similarity_score"] == 100
    assert result["items"][0]["approximate_location"] == (
        "Sensitive exact location withheld"
    )
    assert "location" not in result["items"][0]
    assert "description" not in result["items"][0]

    match_id = result["items"][0]["id"]
    claim_response = client.post(f"/lost-found/matches/{match_id}/request")
    assert claim_response.status_code == 201
    assert claim_response.json()["private_details_revealed"] is False
    assert collections["notifications"].documents[0]["action_type"] == (
        "lost_found_claim"
    )
    identity["user"] = found_owner
    notifications = client.get("/notifications")
    assert notifications.status_code == 200
    assert notifications.json()["notifications"][0]["action_type"] == (
        "lost_found_claim"
    )

    incoming = client.get("/lost-found/claims/incoming")
    assert incoming.status_code == 200
    request_report = incoming.json()["items"][0]["requesting_report"]
    assert request_report["item_name"] == "Blue backpack"
    assert "description" not in request_report
    assert "location" not in request_report

    reviewed = client.patch(
        f"/lost-found/matches/{match_id}/claims/{claim_response.json()['id']}/review",
        json={"decision": "approved"},
    )
    assert reviewed.status_code == 200
    assert reviewed.json()["private_details_revealed"] is False
    assert client.get(f"/lost-found/{found_id}").status_code == 200
    notification_id = str(collections["notifications"].documents[0]["_id"])
    assert client.patch(f"/notifications/{notification_id}/read").status_code == 200


def test_lost_found_rejects_invalid_images_without_inserting_reports(
    monkeypatch, tmp_path
):
    client, identity, collections = _client(monkeypatch, tmp_path)
    invalid = _report(
        "lost",
        image={"name": "fake.png", "type": "image/png", "size": 3, "data": "YWJj"},
    )

    response = client.post("/lost-found/", json=invalid)

    assert response.status_code == 422
    assert collections["items"].documents == []


def test_lost_found_accepts_supported_image_payload_without_exposing_embedding(
    monkeypatch, tmp_path
):
    client, _identity, collections = _client(monkeypatch, tmp_path)
    # The test double validates the format signature; no real image model runs.
    png = "iVBORw0KGgo="
    payload = _report(
        "lost",
        image={
            "name": "item.png",
            "type": "image/png",
            "size": 8,
            "data": png,
        },
    )

    response = client.post("/lost-found/", json=payload)

    assert response.status_code == 201
    report = response.json()
    assert report["image_url"].startswith("/lost-found/images/")
    assert report["ai_analysis"]["analysis_status"] == "available"
    assert "embedding" not in report["ai_analysis"]
    assert collections["items"].documents[0]["image_embedding"] == [1.0, 0.0]


def test_closing_a_report_invalidates_its_pending_matches_and_claims(
    monkeypatch, tmp_path
):
    client, identity, collections = _client(monkeypatch, tmp_path)
    claimant = identity["user"]
    found_owner = {"_id": ObjectId(), "role": "student", "student_id": "FOUND"}

    identity["user"] = found_owner
    client.post("/lost-found/", json=_report("found"))
    identity["user"] = claimant
    lost = client.post("/lost-found/", json=_report("lost")).json()
    match = client.get(f"/lost-found/{lost['id']}/matches").json()["items"][0]
    client.post(f"/lost-found/matches/{match['id']}/request")

    closed = client.patch(f"/lost-found/{lost['id']}/close")

    assert closed.status_code == 200
    assert collections["matches"].documents[0]["match_status"] == "invalidated"
    assert (
        collections["claims"].documents[0]["verification_status"] == "invalidated"
    )
    identity["user"] = found_owner
    assert client.get("/lost-found/claims/incoming").json()["items"] == []
