import pytest
from fastapi import HTTPException
from pymongo.errors import AutoReconnect

import main as fastapi_main


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
