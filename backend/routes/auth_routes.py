from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from auth_config import get_jwt_config
from dependencies.auth import get_current_user, require_roles
from services.link_codes import redeem_code
from services.user_service import (
    UserError,
    create_user,
    find_user_by_email,
    password_hash,
    public_user,
    verify_password,
)

router = APIRouter(tags=["Authentication"])

# Used to spend the same hashing time when the email doesn't exist,
# so response timing doesn't reveal which emails are registered.
DUMMY_HASH = password_hash.hash("dummy-password")


class RegisterRequest(BaseModel):
    # Unknown fields (including any "role") are ignored: public registration
    # always creates a student account.
    model_config = ConfigDict(extra="ignore")

    name: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: str
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str


class UserOut(BaseModel):
    name: str
    email: str
    role: str
    student_id: str | None = None
    assigned_subject_codes: list[str] = []


class LinkStudentRequest(BaseModel):
    student_id: str = Field(min_length=1, max_length=50)
    link_code: str = Field(min_length=4, max_length=32)


def create_access_token(subject: str, role: str = "student") -> str:
    config = get_jwt_config()

    now = datetime.now(timezone.utc)
    payload = {
        "sub": subject,
        "iat": now,
        "exp": now + timedelta(minutes=config["expires_in_minutes"]),
        "role": role if role in ("student", "faculty", "admin") else "student",
    }

    return jwt.encode(payload, config["secret"], algorithm=config["algorithm"])


@router.post("/register")
def register_user(user: RegisterRequest):
    """Creates a **student** account. A `role` field, if sent, is ignored."""
    try:
        create_user(user.name, user.email, user.password, role="student")
    except UserError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)

    return {
        "message": "User registered successfully"
    }


@router.post("/login", response_model=Token)
def login_user(credentials: LoginRequest):

    user = find_user_by_email(credentials.email)

    if user:
        password_ok = verify_password(
            credentials.password,
            user["password"]
        )
    else:
        password_hash.verify(credentials.password, DUMMY_HASH)
        password_ok = False

    if not password_ok:
        raise HTTPException(
            status_code=401,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"}
        )

    access_token = create_access_token(str(user["_id"]), user.get("role", "student"))

    return {
        "access_token": access_token,
        "token_type": "bearer"
    }


@router.get("/me", response_model=UserOut)
def read_current_user(current_user: dict = Depends(get_current_user)):
    """The signed-in user's profile. Never includes the password hash."""
    return public_user(current_user)


@router.post("/me/link-student", response_model=UserOut)
def link_my_student_record(
    data: LinkStudentRequest,
    current_user: dict = Depends(require_roles("student")),
):
    """Links your account to your student record using the one-time code
    issued by the college admin."""
    try:
        return redeem_code(current_user, data.student_id.strip(), data.link_code)
    except UserError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
