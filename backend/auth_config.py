import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import HTTPException


load_dotenv(Path(__file__).resolve().parent / ".env")


def get_jwt_config(env: dict | os._Environ | None = None) -> dict:
    source = os.environ if env is None else env
    secret = source.get("JWT_SECRET", "").strip()
    algorithm = source.get("JWT_ALGORITHM", "HS256").strip()
    raw_expiry = source.get("TOKEN_EXPIRE_MINUTES", "60").strip()

    if not secret or secret == "change-me":
        raise HTTPException(status_code=500, detail="JWT_SECRET is not configured")
    if algorithm != "HS256":
        raise HTTPException(status_code=500, detail="JWT_ALGORITHM must be HS256")

    try:
        expires_in_minutes = int(raw_expiry)
    except (TypeError, ValueError):
        expires_in_minutes = 0
    if expires_in_minutes < 1:
        raise HTTPException(
            status_code=500,
            detail="TOKEN_EXPIRE_MINUTES must be a positive integer",
        )

    return {
        "secret": secret,
        "algorithm": algorithm,
        "expires_in_minutes": expires_in_minutes,
    }
