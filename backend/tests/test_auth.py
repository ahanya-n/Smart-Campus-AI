import re

import jwt
import pytest
from fastapi import HTTPException

from auth_config import get_jwt_config
from services.user_service import password_hash, verify_password

PASSWORD = "Test-pass-123"


def test_jwt_configuration_fails_closed_on_missing_or_invalid_values():
    with pytest.raises(HTTPException) as missing:
        get_jwt_config({"JWT_SECRET": "", "JWT_ALGORITHM": "HS256", "TOKEN_EXPIRE_MINUTES": "60"})
    assert missing.value.status_code == 500
    assert missing.value.detail == "JWT_SECRET is not configured"

    with pytest.raises(HTTPException) as algorithm:
        get_jwt_config({"JWT_SECRET": "test-only", "JWT_ALGORITHM": "none", "TOKEN_EXPIRE_MINUTES": "60"})
    assert algorithm.value.status_code == 500
    assert algorithm.value.detail == "JWT_ALGORITHM must be HS256"

    with pytest.raises(HTTPException) as expiry:
        get_jwt_config({"JWT_SECRET": "test-only", "JWT_ALGORITHM": "HS256", "TOKEN_EXPIRE_MINUTES": "0"})
    assert expiry.value.status_code == 500
    assert expiry.value.detail == "TOKEN_EXPIRE_MINUTES must be a positive integer"


def test_password_verification_accepts_express_argon2_parameter_order():
    python_hash = password_hash.hash(PASSWORD)
    node_hash = re.sub(
        r"m=(\d+),t=(\d+),p=(\d+)",
        r"m=\1,p=\3,t=\2",
        python_hash,
    )

    assert verify_password(PASSWORD, node_hash) is True
    assert verify_password("incorrect-password", node_hash) is False
    assert verify_password(PASSWORD, "unsupported-hash-format") is False


def test_successful_login(client, accounts):
    user = accounts.make("student")
    response = client.post(
        "/login",
        json={"email": user["email"], "password": PASSWORD},
    )
    assert response.status_code == 200
    body = response.json()
    assert "access_token" in body
    assert body["token_type"].lower() == "bearer"
    assert len(body["access_token"]) > 20
    config = get_jwt_config()
    payload = jwt.decode(
        body["access_token"],
        config["secret"],
        algorithms=[config["algorithm"]],
    )
    assert payload["sub"] == user["id"]
    assert payload["role"] == "student"
    assert isinstance(payload["iat"], (int, float))
    assert isinstance(payload["exp"], (int, float))


def test_wrong_password_returns_401(client, accounts):
    user = accounts.make("student")
    response = client.post(
        "/login",
        json={"email": user["email"], "password": "definitely-wrong-password"},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "Incorrect email or password"


def test_nonexistent_email_login_returns_401(client):
    response = client.post(
        "/login",
        json={"email": "nobody_exists@test.local", "password": PASSWORD},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "Incorrect email or password"


def test_user_registration_success(client, run_id):
    email = f"newstudent.{run_id}@test.local"
    response = client.post(
        "/register",
        json={"name": "New Student", "email": email, "password": "StrongPassword123"},
    )
    assert response.status_code == 200
    assert response.json()["message"] == "User registered successfully"

    # Verify user can immediately log in
    login_res = client.post("/login", json={"email": email, "password": "StrongPassword123"})
    assert login_res.status_code == 200
    assert "access_token" in login_res.json()


def test_registration_duplicate_email(client, accounts):
    existing = accounts.make("student")
    response = client.post(
        "/register",
        json={"name": "Duplicate", "email": existing["email"], "password": "StrongPassword123"},
    )
    assert response.status_code == 400
    assert "already registered" in response.json()["detail"]


def test_registration_validation(client, run_id):
    # Short password (< 8 chars)
    res1 = client.post(
        "/register",
        json={"name": "A", "email": f"short.{run_id}@test.local", "password": "123"},
    )
    assert res1.status_code == 422

    # Empty name
    res2 = client.post(
        "/register",
        json={"name": "", "email": f"noname.{run_id}@test.local", "password": "ValidPassword1"},
    )
    assert res2.status_code == 422


def test_unauthenticated_me_returns_401(client):
    response = client.get("/me")
    assert response.status_code == 401
    assert response.json()["detail"] == "Not authenticated"


def test_malformed_token_returns_401(client):
    response = client.get("/me", headers={"Authorization": "Bearer malformed.jwt.token"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid token"


def test_authenticated_me_returns_user_details(client, accounts):
    student = accounts.make("student")
    response = client.get("/me", headers=student["headers"])
    assert response.status_code == 200
    body = response.json()
    assert body["email"] == student["email"]
    assert body["name"] == student["name"]
    assert body["role"] == "student"
    assert "password" not in body


def test_student_cannot_access_admin_endpoints(client, accounts, admin):
    student = accounts.make("student")

    # Student cannot list users via admin route
    student_res = client.get("/admin/users", headers=student["headers"])
    assert student_res.status_code == 403
    assert "requires the admin role" in student_res.json()["detail"]

    # Student cannot create users via admin route
    create_res = client.post(
        "/admin/users",
        headers=student["headers"],
        json={
            "name": "Hacker",
            "email": "hacker@test.local",
            "password": "secret-pass-123",
            "role": "admin",
        },
    )
    assert create_res.status_code == 403

    # Admin CAN access admin route
    admin_res = client.get("/admin/users", headers=admin["headers"])
    assert admin_res.status_code == 200
    assert isinstance(admin_res.json(), list)


def test_link_student_code_flow(client, admin, accounts, make_student):
    student = accounts.make("student")
    sid = make_student()

    # Non-admin cannot issue link code
    bad_issue = client.post(f"/admin/students/{sid}/link-code", headers=student["headers"])
    assert bad_issue.status_code == 403

    # Admin issues link code
    issue_res = client.post(f"/admin/students/{sid}/link-code", headers=admin["headers"])
    assert issue_res.status_code == 201
    code = issue_res.json()["link_code"]

    # Wrong code fails
    fail_res = client.post(
        "/me/link-student",
        headers=student["headers"],
        json={"student_id": sid, "link_code": "WRONGCODE9"},
    )
    assert fail_res.status_code == 400

    # Correct code links the student
    link_res = client.post(
        "/me/link-student",
        headers=student["headers"],
        json={"student_id": sid, "link_code": code},
    )
    assert link_res.status_code == 200
    assert link_res.json()["student_id"] == sid

    # Profile reflects student_id
    me_res = client.get("/me", headers=student["headers"])
    assert me_res.status_code == 200
    assert me_res.json()["student_id"] == sid
