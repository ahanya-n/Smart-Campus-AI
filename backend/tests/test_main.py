import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pymongo.errors import AutoReconnect

import main as fastapi_main


@pytest.mark.parametrize(
    "origin",
    ["http://localhost:54321", "http://127.0.0.1:55000"],
)
def test_flutter_web_preflight_allows_loopback_development_origins(origin):
    response = TestClient(fastapi_main.app).options(
        "/login",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    allowed_headers = response.headers["access-control-allow-headers"].lower()
    assert "authorization" in allowed_headers
    assert "content-type" in allowed_headers


def test_flutter_web_preflight_rejects_non_loopback_origins():
    response = TestClient(fastapi_main.app).options(
        "/login",
        headers={
            "Origin": "https://untrusted.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_database_probe_returns_success_when_mongodb_responds(monkeypatch):
    class Admin:
        @staticmethod
        def command(command):
            assert command == "ping"

    class Client:
        admin = Admin()

    monkeypatch.setattr(fastapi_main, "client", Client())

    assert fastapi_main.test_database() == {
        "message": "MongoDB Connected Successfully!"
    }


def test_database_probe_does_not_expose_mongodb_error_details(monkeypatch, caplog):
    secret_detail = "mongodb://private-user:private-password@private-host"

    class Admin:
        @staticmethod
        def command(_command):
            raise AutoReconnect(secret_detail)

    class Client:
        admin = Admin()

    monkeypatch.setattr(fastapi_main, "client", Client())

    with pytest.raises(HTTPException) as raised:
        fastapi_main.test_database()

    assert raised.value.status_code == 503
    assert raised.value.detail == "MongoDB is unavailable"
    assert secret_detail not in caplog.text
