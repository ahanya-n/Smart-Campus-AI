"""Provision login passwords for the local Karnataka synthetic demo cohort."""

import json
import secrets
from datetime import datetime, timezone
from pathlib import Path

from pymongo import MongoClient
from pymongo.errors import PyMongoError

from seed_karnataka_demo_academics import (
    DATASET_MARKER,
    FACULTY_SPECS,
    LOCAL_DEMO_SEED_MARKER,
    _student_rows,
)
from services.user_service import password_hash


LOCAL_MONGO_URL = "mongodb://127.0.0.1:27017/"
DATABASE_NAME = "smart_campus_test"
CREDENTIALS_FILE = Path(__file__).with_name(
    "karnataka-demo-credentials.local.json"
)
LEGACY_DEMO_ACCOUNTS = {
    "admin.demo@smartcampus.test": "admin",
    "faculty.demo@smartcampus.test": "faculty",
    "student.demo@smartcampus.test": "student",
}


def _validate_target_accounts(db) -> tuple[list[dict], dict[str, str]]:
    users = db["users"]
    targets = []

    for student in _student_rows():
        user = users.find_one({
            "email": student["user_email"],
            "role": "student",
            "student_id": student["student_id"],
            "local_demo_seed": LOCAL_DEMO_SEED_MARKER,
            "demo_seed_key": DATASET_MARKER,
        }, {"_id": 1, "email": 1, "name": 1, "student_id": 1})
        profile = db["students"].find_one({
            "student_id": student["student_id"],
            "user_id": str(user["_id"]) if user else None,
            "local_demo_seed": LOCAL_DEMO_SEED_MARKER,
            "demo_seed_key": DATASET_MARKER,
        }, {"_id": 1})
        if user is None or profile is None:
            raise RuntimeError(
                f"Refusing to provision unverified cohort account {student['student_id']}."
            )
        targets.append({
            "email": user["email"],
            "name": user.get("name", student["name"]),
            "role": "student",
            "student_id": student["student_id"],
            "user_id": user["_id"],
        })

    for faculty in FACULTY_SPECS[1:]:
        user = users.find_one({
            "email": faculty["email"],
            "role": "faculty",
            "faculty_id": faculty["faculty_id"],
            "local_demo_seed": LOCAL_DEMO_SEED_MARKER,
            "demo_seed_key": DATASET_MARKER,
        }, {"_id": 1, "email": 1, "name": 1, "faculty_id": 1})
        if user is None:
            raise RuntimeError(
                f"Refusing to provision unverified cohort Faculty account {faculty['faculty_id']}."
            )
        targets.append({
            "email": user["email"],
            "name": user.get("name", faculty["name"]),
            "role": "faculty",
            "faculty_id": faculty["faculty_id"],
            "user_id": user["_id"],
        })

    legacy_password_hashes = {}
    for email, expected_role in LEGACY_DEMO_ACCOUNTS.items():
        user = users.find_one(
            {"email": email, "role": expected_role},
            {"_id": 1, "password": 1},
        )
        if user is None or not isinstance(user.get("password"), str):
            raise RuntimeError(
                f"Refusing to proceed because a legacy demo {expected_role} account is unavailable."
            )
        legacy_password_hashes[email] = user["password"]

    if len(targets) != 24:
        raise RuntimeError("Refusing to provision an unexpected number of cohort accounts.")
    return targets, legacy_password_hashes


def provision() -> int:
    if CREDENTIALS_FILE.exists():
        raise RuntimeError(
            "Credential file already exists; refusing to replace credentials or reset passwords."
        )

    client = MongoClient(LOCAL_MONGO_URL, serverSelectionTimeoutMS=5000)
    try:
        client.admin.command("ping")
        db = client[DATABASE_NAME]
        if db.name != DATABASE_NAME:
            raise RuntimeError("Refusing to use a database other than the pinned local demo database.")

        targets, legacy_password_hashes = _validate_target_accounts(db)
        passwords = [secrets.token_urlsafe(32) for _ in targets]
        if len(set(passwords)) != len(passwords):
            raise RuntimeError("Secure password generation produced a duplicate.")

        timestamp = datetime.now(timezone.utc).isoformat()
        credential_document = {
            "database": DATABASE_NAME,
            "created_at_utc": timestamp,
            "accounts": [
                {
                    key: target[key]
                    for key in ("role", "email", "name", "student_id", "faculty_id")
                    if key in target
                } | {"password": password}
                for target, password in zip(targets, passwords)
            ],
        }
        try:
            with CREDENTIALS_FILE.open("x", encoding="utf-8", newline="\n") as file:
                json.dump(credential_document, file, indent=2)
                file.write("\n")
        except FileExistsError:
            raise RuntimeError(
                "Credential file already exists; refusing to replace credentials or reset passwords."
            ) from None

        users = db["users"]
        for target, password in zip(targets, passwords):
            identity = {
                "_id": target["user_id"],
                "email": target["email"],
                "role": target["role"],
                "local_demo_seed": LOCAL_DEMO_SEED_MARKER,
                "demo_seed_key": DATASET_MARKER,
            }
            if target["role"] == "student":
                identity["student_id"] = target["student_id"]
            else:
                identity["faculty_id"] = target["faculty_id"]
            result = users.update_one(
                identity,
                {"$set": {"password": password_hash.hash(password)}},
            )
            if result.matched_count != 1:
                raise RuntimeError(
                    "A verified cohort account changed during provisioning; "
                    "saved credentials are retained for recovery."
                )

        for target, password in zip(targets, passwords):
            user = users.find_one(
                {"_id": target["user_id"], "email": target["email"]},
                {"password": 1},
            )
            if not user or not password_hash.verify(password, user.get("password", "")):
                raise RuntimeError(
                    "Post-provision verification failed; saved credentials are retained."
                )

        for email, password_hash_before in legacy_password_hashes.items():
            user = users.find_one({"email": email}, {"password": 1})
            if not user or user.get("password") != password_hash_before:
                raise RuntimeError("A legacy demo account password hash changed unexpectedly.")

        return len(targets)
    except PyMongoError:
        raise RuntimeError(
            "Local database operation failed; credential details were withheld."
        ) from None
    finally:
        client.close()


if __name__ == "__main__":
    count = provision()
    print(
        f"Provisioned {count} cohort accounts. Credentials saved locally to "
        f"{CREDENTIALS_FILE.name}; no passwords or hashes were printed."
    )
