import hmac

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from services.lost_found_matching import analyze_lost_found_image

import os


router = APIRouter(prefix="/lost-found", tags=["Lost and Found AI"])


class LostFoundAnalyzeRequest(BaseModel):
    image_base64: str = Field(min_length=1, max_length=7 * 1024 * 1024)
    image_mime_type: str = Field(default="image/jpeg", max_length=30)


@router.post("/analyze")
def analyze_report_image(
    data: LostFoundAnalyzeRequest,
    x_lost_found_internal_key: str | None = Header(default=None),
):
    required_key = os.getenv("LOST_FOUND_INTERNAL_KEY")
    if not required_key:
        raise HTTPException(status_code=503, detail="Lost and Found AI service is not configured")
    if not x_lost_found_internal_key or not hmac.compare_digest(x_lost_found_internal_key, required_key):
        raise HTTPException(status_code=403, detail="Forbidden")

    if data.image_mime_type not in ("image/jpeg", "image/png", "image/webp"):
        raise HTTPException(status_code=422, detail="Unsupported image format")

    result = analyze_lost_found_image(data.image_base64, data.image_mime_type)
    return result
