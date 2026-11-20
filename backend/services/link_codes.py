"""One-time codes that let a student link their account to their student record.

An admin issues a code for a student record and hands it to that student
in person (or through an official college channel). Codes are:
- random (10 characters from a 32-letter alphabet, ~10^15 possibilities)
- stored only as a SHA-256 hash
- valid for 7 days (MongoDB deletes them automatically afterwards)
- invalidated after 5 wrong attempts
- consumed on first successful use
"""

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from database import link_codes_collection, students_collection
from services.user_service import UserError, link_student

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I confusion
CODE_LENGTH = 10
VALID_FOR = timedelta(days=7)
MAX_ATTEMPTS = 5

INVALID_CODE = "Invalid or expired link code"


def _digest(code: str) -> str:
    return hashlib.sha256(code.strip().upper().encode()).hexdigest()


def issue_code(student_id: str, issued_by: str) -> tuple[str, datetime]:
    """Creates a new code for a student, replacing any earlier unused code."""
    if students_collection.find_one({"student_id": student_id}, {"_id": 1}) is None:
        raise UserError(404, f"Student {student_id} not found")

    code = "".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH))
    expires_at = datetime.now(timezone.utc) + VALID_FOR
    link_codes_collection.update_one(
        {"student_id": student_id},
        {"$set": {
            "code_hash": _digest(code),
            "expires_at": expires_at,
            "attempts": 0,
            "issued_by": issued_by,
        }},
        upsert=True,
    )
    return code, expires_at


def redeem_code(user: dict, student_id: str, code: str) -> dict:
    """Links the signed-in student to student_id if the code is valid."""
    if user.get("role", "student") != "student":
        raise UserError(403, "Only student accounts can link a student record")
    if user.get("student_id"):
        raise UserError(409, "Your account is already linked to a student record")

    record = link_codes_collection.find_one({"student_id": student_id})
    now = datetime.now(timezone.utc)

    expires_at = record.get("expires_at") if record else None
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if record is None or expires_at is None or expires_at <= now:
        raise UserError(400, INVALID_CODE)

    if not hmac.compare_digest(record.get("code_hash", ""), _digest(code)):
        attempts = int(record.get("attempts", 0)) + 1
        if attempts >= MAX_ATTEMPTS:
            link_codes_collection.delete_one({"_id": record["_id"]})
        else:
            link_codes_collection.update_one({"_id": record["_id"]}, {"$set": {"attempts": attempts}})
        raise UserError(400, INVALID_CODE)

    linked = link_student(str(user["_id"]), student_id)
    link_codes_collection.delete_one({"_id": record["_id"]})
    return linked
