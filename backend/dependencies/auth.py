import os

import jwt
from bson import ObjectId
from bson.errors import InvalidId
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from auth_config import get_jwt_config
from database import users_collection

JWT_SECRET = os.getenv("JWT_SECRET")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")

# auto_error=False so a missing header gives our own 401 instead of FastAPI's default.
bearer_scheme = HTTPBearer(auto_error=False)


def unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=401,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"}
    )


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)
) -> dict:

    if credentials is None or credentials.scheme.lower() != "bearer":
        raise unauthorized("Not authenticated")

    config = get_jwt_config()

    try:
        payload = jwt.decode(
            credentials.credentials,
            config["secret"],
            algorithms=[config["algorithm"]],
            options={"require": ["exp", "sub"]}
        )
    except jwt.ExpiredSignatureError:
        raise unauthorized("Token has expired")
    except jwt.InvalidTokenError:
        raise unauthorized("Invalid token")

    try:
        user_id = ObjectId(payload["sub"])
    except (InvalidId, TypeError):
        raise unauthorized("Invalid token")

    user = users_collection.find_one(
        {"_id": user_id},
        {"password": 0}
    )

    if user is None:
        raise unauthorized("User not found")

    return user


def user_role(user: dict) -> str:
    """The user's role; anything unknown is treated as the least-privileged role."""
    role = user.get("role")
    return role if role in ("student", "faculty", "admin") else "student"


def assigned_subjects(user: dict) -> list[str]:
    """Subject codes an admin has assigned to a faculty member."""
    codes = user.get("assigned_subject_codes") or []
    return [str(code) for code in codes]


def require_roles(*roles: str):
    """Dependency factory: 401 if not signed in, 403 if the role is not allowed.

    Usage: `user: dict = Depends(require_roles("faculty", "admin"))`
    """

    def checker(current_user: dict = Depends(get_current_user)) -> dict:
        if user_role(current_user) not in roles:
            raise HTTPException(
                status_code=403,
                detail=f"This action requires the {' or '.join(roles)} role.",
            )
        return current_user

    return checker
