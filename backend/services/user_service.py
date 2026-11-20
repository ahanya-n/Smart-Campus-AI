"""User account operations shared by the API and the manage_users.py CLI.
Password hashes never leave this module."""

import re

from bson import ObjectId
from bson.errors import InvalidId
from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError
from pymongo.errors import DuplicateKeyError

from database import students_collection, users_collection
from validators import ROLES

password_hash = PasswordHash.recommended()

MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
CODE_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,20}$")
NODE_ARGON2_PATTERN = re.compile(
    r"^\$argon2id\$v=19\$m=(\d+),p=(\d+),t=(\d+)\$([A-Za-z0-9+/]{16,})\$([A-Za-z0-9+/]{32,})$"
)


class UserError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def normalize_email(email: str) -> str:
    return email.strip().lower()


def public_user(doc: dict) -> dict:
    """Safe user fields for API responses. Never includes the password hash."""
    return {
        "id": str(doc["_id"]),
        "name": doc.get("name", ""),
        "email": doc.get("email", ""),
        "role": doc.get("role") if doc.get("role") in ROLES else "student",
        "student_id": doc.get("student_id"),
        "registration_number": doc.get("registration_number"),
        "faculty_id": doc.get("faculty_id"),
        "department": doc.get("department"),
        "designation": doc.get("designation"),
        "assigned_subject_codes": list(doc.get("assigned_subject_codes") or []),
        "assigned_class_ids": list(doc.get("assigned_class_ids") or []),
    }


def _object_id(user_id: str) -> ObjectId:
    try:
        return ObjectId(user_id)
    except (InvalidId, TypeError):
        raise UserError(404, "User not found")


def get_user(user_id: str) -> dict:
    user = users_collection.find_one({"_id": _object_id(user_id)}, {"password": 0})
    if user is None:
        raise UserError(404, "User not found")
    return user


def find_user_by_email(email: str) -> dict | None:
    """Exact match first (accounts created before emails were normalised),
    then the normalised form."""
    typed = email.strip()
    return users_collection.find_one({"email": {"$in": list({typed, typed.lower()})}})


def validate_password(password: str) -> None:
    if not (MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH):
        raise UserError(
            422,
            f"Password must be {MIN_PASSWORD_LENGTH}-{MAX_PASSWORD_LENGTH} characters long",
        )


def verify_password(password: str, encoded_hash: str) -> bool:
    if not isinstance(encoded_hash, str) or len(encoded_hash) > 256:
        return False

    match = NODE_ARGON2_PATTERN.fullmatch(encoded_hash)
    if match:
        memory_cost, parallelism, time_cost = map(int, match.group(1, 2, 3))
        if (
            memory_cost < 8
            or memory_cost > 262144
            or time_cost < 1
            or time_cost > 10
            or parallelism < 1
            or parallelism > 16
        ):
            return False
        salt, digest = match.group(4, 5)
        encoded_hash = (
            f"$argon2id$v=19$m={memory_cost},t={time_cost},p={parallelism}"
            f"${salt}${digest}"
        )

    try:
        return password_hash.verify(password, encoded_hash)
    except UnknownHashError:
        return False


def create_user(name: str, email: str, password: str, role: str = "student") -> dict:
    name = name.strip()
    email = normalize_email(email)
    if not name:
        raise UserError(422, "Name is required")
    if not EMAIL_PATTERN.match(email):
        raise UserError(422, "Please enter a valid email")
    if role not in ROLES:
        raise UserError(422, f"Role must be one of: {', '.join(ROLES)}")
    validate_password(password)

    if find_user_by_email(email):
        raise UserError(400, "Email already registered")

    doc = {
        "name": name,
        "email": email,
        "password": password_hash.hash(password),
        "role": role,
    }
    if role == "faculty":
        doc["assigned_subject_codes"] = []

    try:
        result = users_collection.insert_one(doc)
    except DuplicateKeyError:
        raise UserError(400, "Email already registered")

    doc["_id"] = result.inserted_id
    return public_user(doc)


def set_role(user_id: str, role: str, acting_user_id: str | None = None) -> dict:
    if role not in ROLES:
        raise UserError(422, f"Role must be one of: {', '.join(ROLES)}")
    user = get_user(user_id)

    if user.get("role") == "admin" and role != "admin":
        if acting_user_id is not None and str(user["_id"]) == acting_user_id:
            raise UserError(409, "You cannot remove your own admin role")
        if users_collection.count_documents({"role": "admin"}) <= 1:
            raise UserError(409, "Cannot remove the last admin")

    update: dict = {"$set": {"role": role}}
    if role == "faculty" and "assigned_subject_codes" not in user:
        update["$set"]["assigned_subject_codes"] = []
    users_collection.update_one({"_id": user["_id"]}, update)
    return public_user(get_user(user_id))


def set_assigned_subjects(user_id: str, subject_codes: list[str]) -> dict:
    user = get_user(user_id)
    if user.get("role") != "faculty":
        raise UserError(409, "Subjects can only be assigned to faculty accounts")

    codes = []
    for code in subject_codes:
        code = code.strip().upper()
        if not CODE_PATTERN.match(code):
            raise UserError(422, f"Invalid subject code: {code or '(empty)'}")
        if code not in codes:
            codes.append(code)

    users_collection.update_one({"_id": user["_id"]}, {"$set": {"assigned_subject_codes": codes}})
    return public_user(get_user(user_id))


def link_student(user_id: str, student_id: str | None) -> dict:
    """Links (or with None, unlinks) a student account to a student record."""
    user = get_user(user_id)

    if student_id is None:
        users_collection.update_one({"_id": user["_id"]}, {"$unset": {"student_id": ""}})
        return public_user(get_user(user_id))

    if user.get("role", "student") != "student":
        raise UserError(409, "Only student accounts can be linked to a student record")
    if students_collection.find_one({"student_id": student_id}, {"_id": 1}) is None:
        raise UserError(404, f"Student {student_id} not found")

    other = users_collection.find_one(
        {"student_id": student_id, "_id": {"$ne": user["_id"]}}, {"_id": 1}
    )
    if other is not None:
        raise UserError(409, f"Student {student_id} is already linked to another account")

    try:
        users_collection.update_one({"_id": user["_id"]}, {"$set": {"student_id": student_id}})
    except DuplicateKeyError:
        raise UserError(409, f"Student {student_id} is already linked to another account")
    return public_user(get_user(user_id))
