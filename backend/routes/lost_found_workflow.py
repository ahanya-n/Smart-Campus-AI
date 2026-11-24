from __future__ import annotations

import base64
import binascii
import json
import math
import os
import re
from datetime import datetime, time, timezone
from pathlib import Path
import secrets
from typing import Any, Literal

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from pymongo.errors import DuplicateKeyError

from database import (
    lost_found_claims_collection,
    lost_found_items_collection,
    lost_found_matches_collection,
    notifications_collection,
    users_collection,
)
from dependencies.auth import get_current_user, require_roles
from services.lost_found_matching import analyze_lost_found_image

router = APIRouter()

_CATEGORIES = {
    "Bag",
    "Book",
    "Clothing",
    "Electronic device",
    "ID card",
    "Keys",
    "Bottle",
    "Other",
}
_STATUSES = {
    "active",
    "match_found",
    "verification_pending",
    "resolved",
    "closed",
}
_IMAGE_TYPES = {
    "image/jpeg": (".jpg", lambda data: data.startswith(b"\xff\xd8\xff")),
    "image/png": (".png", lambda data: data.startswith(b"\x89PNG\r\n\x1a\n")),
    "image/webp": (
        ".webp",
        lambda data: len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP",
    ),
}
_MAX_IMAGE_BYTES = 5 * 1024 * 1024
_IMAGE_REFERENCE = re.compile(r"^[a-f0-9]{40}\.(jpg|png|webp)$")
_HIGH_CONFIDENCE_THRESHOLD = 75
_MINIMUM_MATCH_THRESHOLD = 55


class LostFoundImage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(max_length=255)
    type: str = Field(max_length=30)
    size: int = Field(ge=0, le=_MAX_IMAGE_BYTES)
    data: str = Field(min_length=1, max_length=7 * 1024 * 1024)


class LostFoundReportCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    report_type: Literal["lost", "found"]
    item_name: str = Field(min_length=1, max_length=120)
    brand: str = Field(default="", max_length=80)
    description: str = Field(min_length=1, max_length=1000)
    category: str
    colour: str = Field(min_length=1, max_length=60)
    event_date: str
    event_time: str
    location: str = Field(min_length=1, max_length=200)
    additional_details: str = Field(default="", max_length=1000)
    image: LostFoundImage | None = None


class LostFoundSuggestionsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str | None = None
    colour: str | None = Field(default=None, max_length=60)


class LostFoundClaimReview(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["approved", "rejected"]


def _object_id(raw_id: str) -> ObjectId:
    try:
        return ObjectId(raw_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail="Lost and Found report not found")


def _timestamp(report: dict[str, Any]) -> datetime | None:
    value = report.get("event_timestamp")
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    try:
        return datetime.combine(
            datetime.strptime(report["event_date"], "%Y-%m-%d").date(),
            time.fromisoformat(report["event_time"]),
            tzinfo=timezone.utc,
        )
    except (KeyError, TypeError, ValueError):
        return None


def _passes_matching_filters(left: dict[str, Any], right: dict[str, Any]) -> bool:
    if left.get("report_type") == right.get("report_type"):
        return False
    if left.get("report_type") not in ("lost", "found") or right.get(
        "report_type"
    ) not in ("lost", "found"):
        return False
    if left.get("status") != "active" or right.get("status") != "active":
        return False
    if any(left.get(field) or right.get(field) for field in ("closed_at", "resolved_at")):
        return False
    left_timestamp = _timestamp(left)
    right_timestamp = _timestamp(right)
    return bool(
        left_timestamp is not None
        and right_timestamp is not None
        and abs((left_timestamp - right_timestamp).total_seconds()) <= 24 * 60 * 60
    )


def _report_output(report: dict[str, Any]) -> dict[str, Any]:
    reference = report.get("image_reference")
    image_url = report.get("image_url")
    if isinstance(image_url, str) and image_url.startswith("/api/lost-found/"):
        image_url = image_url[4:]
    if image_url is None and reference:
        image_url = f"/lost-found/images/{reference}"
    analysis = report.get("ai_analysis")
    safe_analysis = None
    if isinstance(analysis, dict):
        safe_analysis = {
            key: analysis[key]
            for key in (
                "predicted_category",
                "predicted_item",
                "predicted_colour",
                "visual_features",
                "analysis_status",
                "model",
                "confidence",
                "limitations",
            )
            if key in analysis
        }
    return {
        "id": str(report.get("_id", report.get("id", ""))),
        "report_type": report.get("report_type", ""),
        "item_name": report.get("item_name", ""),
        "brand": report.get("brand", ""),
        "description": report.get("description", ""),
        "category": report.get("category", "Other"),
        "colour": report.get("colour", ""),
        "event_date": report.get("event_date", ""),
        "event_time": report.get("event_time", ""),
        "location": report.get("location", ""),
        "additional_details": report.get("additional_details", ""),
        "status": report.get("status", "active"),
        "image_url": image_url,
        "created_at": report.get("created_at"),
        "updated_at": report.get("updated_at"),
        "closed_at": report.get("closed_at"),
        "resolved_at": report.get("resolved_at"),
        "ai_analysis": safe_analysis,
        "image_embedding_reference": report.get("image_embedding_reference"),
        "matching_status": report.get("matching_status", "not_requested"),
        "last_matching_at": report.get("last_matching_at"),
    }


def _find_report(report_id: str) -> dict[str, Any]:
    report = lost_found_items_collection.find_one({"_id": _object_id(report_id)})
    if report is None:
        raise HTTPException(status_code=404, detail="Lost and Found report not found")
    return report


def _require_owner_or_admin(report: dict[str, Any], user: dict[str, Any]) -> None:
    if str(report.get("user_id")) != str(user.get("_id")) and user.get("role") != "admin":
        raise HTTPException(status_code=404, detail="Lost and Found report not found")


def _decode_and_save_image(image: LostFoundImage) -> tuple[str, str, dict[str, Any]]:
    mime_type = image.type
    encoded = image.data.strip()
    data_url = re.fullmatch(r"data:[^;]+;base64,(.+)", encoded, re.DOTALL)
    if data_url:
        encoded = data_url.group(1)
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="Image data is invalid")
    if not image_bytes:
        raise HTTPException(status_code=422, detail="Image data is empty")
    if len(image_bytes) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=422, detail="Image must be 5 MB or smaller")
    image_type = _IMAGE_TYPES.get(mime_type)
    if image_type is None or not image_type[1](image_bytes):
        raise HTTPException(status_code=422, detail="Unsupported or invalid image format")

    reference = f"{secrets.token_hex(20)}{image_type[0]}"
    upload_dir = Path(
        os.getenv(
            "LOST_FOUND_UPLOAD_DIR",
            str(
                Path(__file__).resolve().parents[2]
                / "backend_node"
                / "uploads"
                / "lost-found"
            ),
        )
    ).resolve()
    upload_dir.mkdir(parents=True, exist_ok=True)
    image_path = (upload_dir / reference).resolve()
    if image_path.parent != upload_dir:
        raise HTTPException(status_code=422, detail="Image reference is invalid")
    with image_path.open("xb") as file:
        file.write(image_bytes)
    analysis = analyze_lost_found_image(encoded, mime_type)
    return reference, mime_type, analysis


def _safe_match_output(
    match: dict[str, Any], report: dict[str, Any], factors: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": str(match.get("_id", match.get("id", ""))),
        "similarity_score": round(float(match.get("similarity_score", 0)), 2),
        "factor_scores": factors,
        "explanation": _match_explanation(
            float(match.get("similarity_score", 0)), factors
        ),
        "category": report.get("category", "Other"),
        "colour": report.get("colour", "Unknown"),
        "item_name": report.get("item_name", "Potential item"),
        "brand": report.get("brand", ""),
        "report_type": report.get("report_type"),
        "event_date": report.get("event_date"),
        "event_time": report.get("event_time"),
        "approximate_location": "Sensitive exact location withheld",
        "image_url": f"/lost-found/matches/{match.get('_id')}/image",
        "match_status": match.get("match_status", "possible"),
    }


def _cosine_similarity(left: Any, right: Any) -> float | None:
    if not isinstance(left, list) or not isinstance(right, list) or len(left) != len(right):
        return None
    try:
        left_values = [float(value) for value in left]
        right_values = [float(value) for value in right]
        denominator = math.sqrt(sum(value * value for value in left_values)) * math.sqrt(
            sum(value * value for value in right_values)
        )
        if denominator == 0:
            return None
        return max(0.0, min(1.0, sum(a * b for a, b in zip(left_values, right_values)) / denominator))
    except (TypeError, ValueError):
        return None


def _stored_embedding(report: dict[str, Any]) -> Any:
    embedding = report.get("image_embedding")
    if isinstance(embedding, list):
        return embedding
    reference = report.get("image_embedding_reference")
    if not isinstance(reference, str) or not re.fullmatch(
        r"lost_found_[a-f0-9]{40}\.json", reference
    ):
        return None
    embedding_dir = Path(
        os.getenv(
            "LOST_FOUND_EMBEDDING_DIR",
            str(
                Path(__file__).resolve().parents[2]
                / "backend_node"
                / "uploads"
                / "lost-found-embeddings"
            ),
        )
    ).resolve()
    embedding_path = (embedding_dir / reference).resolve()
    if embedding_path.parent != embedding_dir or not embedding_path.is_file():
        return None
    try:
        with embedding_path.open("r", encoding="utf-8") as file:
            content = json.load(file)
    except (OSError, ValueError):
        return None
    return content.get("embedding") if isinstance(content, dict) else None


def _token_set(value: Any) -> set[str]:
    if not isinstance(value, str):
        return set()
    stop_words = {
        "a",
        "an",
        "the",
        "and",
        "or",
        "with",
        "has",
        "have",
        "my",
        "near",
        "of",
        "at",
    }
    synonyms = {
        "cellphone": "phone",
        "mobile": "phone",
        "smartphone": "phone",
        "eyeglasses": "glasses",
        "spectacles": "glasses",
        "knapsack": "backpack",
        "rucksack": "backpack",
        "flask": "bottle",
        "tumbler": "bottle",
    }
    return {
        synonyms.get(word, re.sub(r"(ies|s)$", lambda match: "y" if match.group(1) == "ies" else "", word))
        for word in re.findall(r"[a-z0-9]+", value.lower())
        if word not in stop_words
    }


def _jaccard(left: Any, right: Any) -> float:
    left_words = _token_set(left)
    right_words = _token_set(right)
    union = left_words | right_words
    return len(left_words & right_words) / len(union) if union else 0.0


def _normalized_category(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    aliases = {
        "electronics": "electronic device",
        "electronic": "electronic device",
        "id": "id card",
        "card": "id card",
        "bags": "bag",
        "books": "book",
        "clothes": "clothing",
    }
    key = value.strip().lower()
    return aliases.get(key, key)


def _colour_similarity(left: Any, right: Any) -> float:
    if not isinstance(left, str) or not isinstance(right, str):
        return 0.0
    aliases = {
        "navy": "blue",
        "cyan": "blue",
        "turquoise": "blue",
        "crimson": "red",
        "maroon": "red",
        "scarlet": "red",
        "lime": "green",
        "olive": "green",
        "charcoal": "gray",
        "grey": "gray",
    }
    left_colour = left.strip().lower()
    right_colour = right.strip().lower()
    if not left_colour or not right_colour:
        return 0.0
    return float(aliases.get(left_colour, left_colour) == aliases.get(right_colour, right_colour))


def _match_score(
    lost: dict[str, Any], found: dict[str, Any]
) -> tuple[float, dict[str, Any], dict[str, float]]:
    image_score = _cosine_similarity(
        _stored_embedding(lost), _stored_embedding(found)
    )
    if image_score is not None:
        image_score = max(0.0, image_score)
    name_score = _jaccard(lost.get("item_name"), found.get("item_name"))
    brand_score = _jaccard(lost.get("brand"), found.get("brand"))
    left_description = " ".join(
        str(value) for value in (lost.get("description"), lost.get("additional_details")) if value
    )
    right_description = " ".join(
        str(value) for value in (found.get("description"), found.get("additional_details")) if value
    )
    description_score = _jaccard(left_description, right_description)
    category_score = float(
        bool(_normalized_category(lost.get("category")))
        and _normalized_category(lost.get("category"))
        == _normalized_category(found.get("category"))
    )
    colour_score = _colour_similarity(lost.get("colour"), found.get("colour"))
    location_score = _jaccard(lost.get("location"), found.get("location"))
    left_time = _timestamp(lost)
    right_time = _timestamp(found)
    event_time_score = (
        max(0.0, 1 - abs((left_time - right_time).total_seconds()) / 86400)
        if left_time is not None and right_time is not None
        else 0.0
    )
    description_present = bool(left_description.strip() and right_description.strip())
    brand_present = bool(
        str(lost.get("brand", "")).strip() and str(found.get("brand", "")).strip()
    )
    name_present = bool(
        str(lost.get("item_name", "")).strip()
        and str(found.get("item_name", "")).strip()
    )
    category_or_colour_present = bool(
        (lost.get("category") and found.get("category"))
        or (lost.get("colour") and found.get("colour"))
    )
    factors = {
        "image": image_score,
        "itemName": round(name_score, 2),
        "brand": round(brand_score, 2),
        "description": round(description_score, 2),
        "category": category_score,
        "colour": colour_score,
        "location": round(location_score, 2),
        "eventTime": round(event_time_score, 2),
    }
    weights = {
        "image": 0.45 if image_score is not None else 0.0,
        "itemName": 0.10 if name_present else 0.0,
        "brand": 0.10 if brand_present else 0.0,
        "description": 0.15 if description_present else 0.0,
        "categoryColour": 0.10 if category_or_colour_present else 0.0,
        "location": 0.05 if lost.get("location") and found.get("location") else 0.0,
        "eventTime": 0.05 if left_time is not None and right_time is not None else 0.0,
    }
    available_weight = sum(weights.values())
    combined_factors = (
        [
            (image_score, weights["image"]),
            (name_score, weights["itemName"]),
            (brand_score, weights["brand"]),
            (description_score, weights["description"]),
            ((category_score + colour_score) / 2, weights["categoryColour"]),
            (location_score, weights["location"]),
            (event_time_score, weights["eventTime"]),
        ]
    )
    score = (
        sum(value * weight for value, weight in combined_factors if value is not None)
        / available_weight
        * 100
        if available_weight
        else 0.0
    )
    normalized_weights = {
        key: round(value / available_weight, 4) if available_weight else 0.0
        for key, value in weights.items()
    }
    return round(score, 2), factors, normalized_weights


def _match_explanation(score: float, factors: dict[str, Any]) -> list[str]:
    explanations = [
        "Strong overall similarity across the available factors."
        if score >= _HIGH_CONFIDENCE_THRESHOLD
        else "Possible similarity across the available factors; ownership is not verified."
    ]
    if factors.get("image") is not None and factors["image"] >= 0.75:
        explanations.append("Images are visually similar.")
    if factors.get("itemName", 0) >= 0.5:
        explanations.append("Item names or related terms overlap.")
    if factors.get("brand", 0) >= 0.5:
        explanations.append("Brand details overlap.")
    if factors.get("description", 0) >= 0.35:
        explanations.append("Identifying details overlap.")
    if factors.get("category", 0) > 0:
        explanations.append("Item categories match.")
    if factors.get("colour", 0) > 0:
        explanations.append("Reported colours match.")
    if factors.get("location", 0) >= 0.3:
        explanations.append("Approximate locations overlap.")
    if factors.get("eventTime", 0) >= 0.5:
        explanations.append("Reported times are close.")
    return explanations


@router.get("/my-reports")
def list_lost_found_reports(
    report_type: str | None = None,
    status: str | None = None,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if report_type is not None and report_type not in ("lost", "found"):
        raise HTTPException(status_code=422, detail="report_type must be lost or found")
    if status is not None and status not in _STATUSES:
        raise HTTPException(status_code=422, detail="status is invalid")
    query: dict[str, Any] = {"user_id": user["_id"]}
    if report_type is not None:
        query["report_type"] = report_type
    if status is not None:
        query["status"] = status
    items = list(lost_found_items_collection.find(query).sort("created_at", -1))
    return {"items": [_report_output(item) for item in items], "total": len(items)}


@router.post("/", status_code=201)
def create_lost_found_report(
    data: LostFoundReportCreate,
    user: dict[str, Any] = Depends(require_roles("student")),
) -> dict[str, Any]:
    item_name = data.item_name.strip()
    description = data.description.strip()
    colour = data.colour.strip()
    location = data.location.strip()
    brand = data.brand.strip()
    additional_details = data.additional_details.strip()
    if not item_name or not description or not colour or not location:
        raise HTTPException(status_code=422, detail="Required report fields cannot be blank")
    if data.category not in _CATEGORIES:
        raise HTTPException(status_code=422, detail="category is invalid")
    try:
        event_date = datetime.strptime(data.event_date, "%Y-%m-%d").date()
        event_time = time.fromisoformat(data.event_time)
        if event_date.isoformat() != data.event_date or event_time.strftime("%H:%M") != data.event_time:
            raise ValueError
        event_timestamp = datetime.combine(
            event_date,
            event_time,
            tzinfo=timezone.utc,
        )
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail="event_date or event_time is invalid",
        )

    image_reference = None
    image_mime_type = None
    analysis = None
    image_embedding = None
    matching_status = "not_requested"
    if data.image is not None:
        image_reference, image_mime_type, analysis = _decode_and_save_image(data.image)
        image_embedding = analysis.get("embedding")
        matching_status = (
            "ready" if isinstance(image_embedding, list) else "failed"
        )

    now = datetime.now(timezone.utc)
    document = {
        "user_id": user["_id"],
        "report_type": data.report_type,
        "item_name": item_name,
        "brand": brand,
        "description": description,
        "category": data.category,
        "colour": colour,
        "event_date": data.event_date,
        "event_time": data.event_time,
        "event_timestamp": event_timestamp,
        "location": location,
        "additional_details": additional_details,
        "status": "active",
        "image_reference": image_reference,
        "image_url": (
            f"/api/lost-found/images/{image_reference}"
            if image_reference
            else None
        ),
        "image_mime_type": image_mime_type,
        "ai_analysis": analysis,
        "image_embedding": image_embedding,
        "image_embedding_reference": None,
        "matching_status": matching_status,
        "created_at": now,
        "updated_at": now,
        "last_matching_at": None,
        "closed_at": None,
        "resolved_at": None,
    }
    result = lost_found_items_collection.insert_one(document)
    document["_id"] = result.inserted_id
    return _report_output(document)


@router.get("/images/{reference}")
def get_lost_found_image(
    reference: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> FileResponse:
    if not _IMAGE_REFERENCE.fullmatch(reference):
        raise HTTPException(status_code=404, detail="Image not found")
    report = lost_found_items_collection.find_one({"image_reference": reference})
    if report is None:
        raise HTTPException(status_code=404, detail="Image not found")
    _require_owner_or_admin(report, user)
    upload_dir = Path(
        os.getenv(
            "LOST_FOUND_UPLOAD_DIR",
            str(
                Path(__file__).resolve().parents[2]
                / "backend_node"
                / "uploads"
                / "lost-found"
            ),
        )
    ).resolve()
    image_path = (upload_dir / reference).resolve()
    if image_path.parent != upload_dir or not image_path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(
        image_path,
        media_type=report.get("image_mime_type", "image/jpeg"),
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/matches/{match_id}/image")
def get_lost_found_match_image(
    match_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> FileResponse:
    match = lost_found_matches_collection.find_one({"_id": _object_id(match_id)})
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    lost = lost_found_items_collection.find_one({"_id": match["queried_report_id"]})
    found = lost_found_items_collection.find_one({"_id": match["candidate_report_id"]})
    if lost is None or found is None:
        raise HTTPException(status_code=404, detail="Match not found")
    if (
        lost.get("report_type") != "lost"
        or found.get("report_type") != "found"
        or not _passes_matching_filters(lost, found)
        or match.get("match_status") in ("invalidated", "rejected")
    ):
        raise HTTPException(status_code=404, detail="Match not found")
    if (
        str(lost.get("user_id")) != str(user.get("_id"))
        and str(found.get("user_id")) != str(user.get("_id"))
        and user.get("role") != "admin"
    ):
        raise HTTPException(status_code=404, detail="Match not found")
    reference = found.get("image_reference")
    if not isinstance(reference, str) or not _IMAGE_REFERENCE.fullmatch(reference):
        raise HTTPException(status_code=404, detail="Image not found")
    upload_dir = Path(
        os.getenv(
            "LOST_FOUND_UPLOAD_DIR",
            str(
                Path(__file__).resolve().parents[2]
                / "backend_node"
                / "uploads"
                / "lost-found"
            ),
        )
    ).resolve()
    image_path = (upload_dir / reference).resolve()
    if image_path.parent != upload_dir or not image_path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(
        image_path,
        media_type=found.get("image_mime_type", "image/jpeg"),
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/claims/incoming")
def list_incoming_lost_found_claims(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    query = {} if user.get("role") == "admin" else {"report_owner_id": user["_id"]}
    claims = list(lost_found_claims_collection.find(query).sort("created_at", -1))
    results = []
    for claim in claims:
        match = lost_found_matches_collection.find_one({"_id": claim["match_id"]})
        if match is None:
            continue
        if match.get("match_status") in ("invalidated", "rejected"):
            continue
        lost = lost_found_items_collection.find_one(
            {"_id": match["queried_report_id"]}
        )
        found = lost_found_items_collection.find_one(
            {"_id": match["candidate_report_id"]}
        )
        if lost is None or found is None:
            continue
        if not _passes_matching_filters(lost, found):
            continue
        is_owner = str(found.get("user_id")) == str(user.get("_id"))
        if not is_owner and user.get("role") != "admin":
            continue
        results.append(
            {
                "id": str(claim["_id"]),
                "match_id": str(match["_id"]),
                "verification_status": claim.get("verification_status", "pending"),
                "created_at": claim.get("created_at"),
                "similarity_score": match.get("similarity_score"),
                "owner_report": {
                    "id": str(found["_id"]),
                    "item_name": found.get("item_name"),
                    "report_type": found.get("report_type"),
                    "status": found.get("status"),
                    "image_url": (
                        f"/lost-found/images/{found['image_reference']}"
                        if found.get("image_reference")
                        else None
                    ),
                },
                "requesting_report": {
                    "item_name": lost.get("item_name"),
                    "report_type": lost.get("report_type"),
                    "category": lost.get("category"),
                    "colour": lost.get("colour"),
                    "event_date": lost.get("event_date"),
                    "event_time": lost.get("event_time"),
                },
            }
        )
    return {"items": results}


@router.patch("/matches/{match_id}/claims/{claim_id}/review")
def review_lost_found_claim(
    match_id: str,
    claim_id: str,
    data: LostFoundClaimReview,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    match_object_id = _object_id(match_id)
    claim_object_id = _object_id(claim_id)
    match = lost_found_matches_collection.find_one({"_id": match_object_id})
    claim = lost_found_claims_collection.find_one(
        {"_id": claim_object_id, "match_id": match_object_id}
    )
    if match is None or claim is None:
        raise HTTPException(status_code=404, detail="Match request not found")
    found = lost_found_items_collection.find_one(
        {"_id": match["candidate_report_id"]}
    )
    lost = lost_found_items_collection.find_one(
        {"_id": match["queried_report_id"]}
    )
    if found is None or lost is None or (
        str(found.get("user_id")) != str(user.get("_id"))
        and user.get("role") != "admin"
    ):
        raise HTTPException(
            status_code=403,
            detail="Only the report owner or an admin can review this request",
        )
    if (
        lost.get("report_type") != "lost"
        or found.get("report_type") != "found"
        or not _passes_matching_filters(lost, found)
        or match.get("match_status") in ("invalidated", "rejected")
        or float(match.get("similarity_score", 0)) < _MINIMUM_MATCH_THRESHOLD
    ):
        raise HTTPException(status_code=409, detail="This match is no longer eligible")
    if claim.get("verification_status") != "pending":
        raise HTTPException(status_code=409, detail="Match request has already been reviewed")

    now = datetime.now(timezone.utc)
    lost_found_claims_collection.update_one(
        {"_id": claim_object_id, "verification_status": "pending"},
        {
            "$set": {
                "verification_status": data.decision,
                "reviewed_by": user["_id"],
                "reviewed_at": now,
                "updated_at": now,
            }
        },
    )
    lost_found_matches_collection.update_one(
        {"_id": match_object_id},
        {
            "$set": {
                "match_status": "approved" if data.decision == "approved" else "rejected",
                "updated_at": now,
            }
        },
    )
    return {
        "id": claim_id,
        "match_id": match_id,
        "verification_status": data.decision,
        "private_details_revealed": False,
        "updated_at": now,
    }


@router.get("/{report_id}/matches")
def find_lost_found_matches(
    report_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    report = _find_report(report_id)
    _require_owner_or_admin(report, user)
    if report.get("report_type") != "lost":
        raise HTTPException(
            status_code=422,
            detail="Matching results are available only for LOST reports",
        )
    report_id_object = report["_id"]
    now = datetime.now(timezone.utc)
    report_timestamp = _timestamp(report)
    items: list[dict[str, Any]] = []
    if report_timestamp is not None and report.get("status") not in ("closed", "resolved"):
        candidates = lost_found_items_collection.find(
            {
                "report_type": "found",
                "status": "active",
                "user_id": {"$ne": report["user_id"]},
            }
        )
        for candidate in candidates:
            candidate_timestamp = _timestamp(candidate)
            if candidate_timestamp is None or abs(
                (report_timestamp - candidate_timestamp).total_seconds()
            ) > 24 * 60 * 60:
                continue
            if not _passes_matching_filters(report, candidate):
                continue
            score, factors, weights = _match_score(report, candidate)
            if score < _MINIMUM_MATCH_THRESHOLD:
                continue
            match = lost_found_matches_collection.find_one(
                {
                    "queried_report_id": report_id_object,
                    "candidate_report_id": candidate["_id"],
                }
            )
            if match is not None and match.get("match_status") in (
                "invalidated",
                "rejected",
            ):
                continue
            if match is None:
                match_doc = {
                    "queried_report_id": report_id_object,
                    "candidate_report_id": candidate["_id"],
                    "claimant_id": report["user_id"],
                    "report_owner_id": candidate["user_id"],
                    "similarity_score": score,
                    "factor_scores": factors,
                    "factor_weights": weights,
                    "match_status": "pending",
                    "created_at": now,
                    "updated_at": now,
                }
                inserted = lost_found_matches_collection.insert_one(match_doc)
                match_doc["_id"] = inserted.inserted_id
                match = match_doc
            else:
                lost_found_matches_collection.update_one(
                    {"_id": match["_id"]},
                    {
                        "$set": {
                            "similarity_score": score,
                            "factor_scores": factors,
                            "factor_weights": weights,
                            "updated_at": now,
                        }
                    },
                )
                match["similarity_score"] = score
                match["factor_scores"] = factors
            items.append(_safe_match_output(match, candidate, factors))
        lost_found_items_collection.update_one(
            {"_id": report_id_object},
            {"$set": {"last_matching_at": now}},
        )
    items.sort(key=lambda item: item["similarity_score"], reverse=True)
    high_confidence = [
        item
        for item in items
        if item["similarity_score"] >= _HIGH_CONFIDENCE_THRESHOLD
    ]
    return {
        "items": items,
        "high_confidence": high_confidence,
        "possible_matches": [
            item for item in items if item not in high_confidence
        ],
        "high_confidence_threshold": _HIGH_CONFIDENCE_THRESHOLD,
        "minimum_threshold": _MINIMUM_MATCH_THRESHOLD,
    }


@router.post("/matches/{match_id}/request", status_code=201)
def request_lost_found_match(
    match_id: str,
    user: dict[str, Any] = Depends(require_roles("student")),
) -> dict[str, Any]:
    match_object_id = _object_id(match_id)
    match = lost_found_matches_collection.find_one({"_id": match_object_id})
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    lost = lost_found_items_collection.find_one(
        {"_id": match["queried_report_id"]}
    )
    found = lost_found_items_collection.find_one(
        {"_id": match["candidate_report_id"]}
    )
    if (
        lost is None
        or found is None
        or str(lost.get("user_id")) != str(user.get("_id"))
        or lost.get("report_type") != "lost"
        or found.get("report_type") != "found"
        or lost.get("status") in ("closed", "resolved")
        or not _passes_matching_filters(lost, found)
        or float(match.get("similarity_score", 0)) < _MINIMUM_MATCH_THRESHOLD
    ):
        raise HTTPException(status_code=409, detail="This match is no longer eligible")
    existing = lost_found_claims_collection.find_one(
        {
            "match_id": match_object_id,
            "claimant_id": user["_id"],
        }
    )
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail="A match request already exists",
        )
    now = datetime.now(timezone.utc)
    claim = {
        "match_id": match_object_id,
        "claimant_id": user["_id"],
        "report_owner_id": found["user_id"],
        "verification_status": "pending",
        "created_at": now,
        "updated_at": now,
    }
    try:
        inserted = lost_found_claims_collection.insert_one(claim)
    except DuplicateKeyError as error:
        raise HTTPException(
            status_code=409,
            detail="A match request already exists",
        ) from error
    claim["_id"] = inserted.inserted_id
    lost_found_matches_collection.update_one(
        {"_id": match_object_id},
        {"$set": {"match_status": "verification_pending", "updated_at": now}},
    )
    owner = users_collection.find_one(
        {"_id": found["user_id"]}, {"password": 0}
    )
    student_id = (
        owner.get("student_id", "")
        if isinstance(owner, dict) and isinstance(owner.get("student_id"), str)
        else ""
    )
    if notifications_collection.find_one({"claim_id": inserted.inserted_id}) is None:
        notifications_collection.insert_one(
        {
            "student_id": student_id,
            "recipient_user_id": found["user_id"],
            "claim_id": inserted.inserted_id,
            "match_id": match_object_id,
            "lost_report_id": lost["_id"],
            "found_report_id": found["_id"],
            "action_type": "lost_found_claim",
            "subject_code": "lost-found",
            "subject_name": "Lost and Found",
            "attendance_percentage": 0,
            "threshold": 0,
            "week_id": f"LF-{str(match_object_id)[-8:]}",
            "warning_type": "lost_found_match",
            "title": "Lost and Found match request",
            "message": "A student requested verification for a potential match. Review it in Lost and Found.",
            "reporting_date": now.date().isoformat(),
            "created_at": now,
            "is_read": False,
        }
        )
    return {
        "id": str(inserted.inserted_id),
        "match_id": match_id,
        "verification_status": "pending",
        "private_details_revealed": False,
    }


@router.patch("/{report_id}/ai-suggestions")
def apply_lost_found_ai_suggestions(
    report_id: str,
    data: LostFoundSuggestionsUpdate,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    report = _find_report(report_id)
    _require_owner_or_admin(report, user)
    changes: dict[str, Any] = {}
    if data.category is not None:
        if data.category not in _CATEGORIES:
            raise HTTPException(status_code=422, detail="category is invalid")
        changes["category"] = data.category
    if data.colour is not None:
        colour = data.colour.strip()
        if not colour:
            raise HTTPException(
                status_code=422,
                detail="colour must be between 1 and 60 characters",
            )
        changes["colour"] = colour
    if not changes:
        raise HTTPException(
            status_code=422,
            detail="At least category or colour is required",
        )
    now = datetime.now(timezone.utc)
    changes["updated_at"] = now
    lost_found_items_collection.update_one(
        {"_id": report["_id"], "user_id": report["user_id"]},
        {"$set": changes},
    )
    report.update(changes)
    return _report_output(report)


def _change_report_status(
    report_id: str,
    status: Literal["closed", "resolved"],
    user: dict[str, Any],
) -> dict[str, Any]:
    report = _find_report(report_id)
    _require_owner_or_admin(report, user)
    if report.get("status") == "resolved":
        raise HTTPException(status_code=409, detail="Report is already resolved")
    if status == "closed" and report.get("status") == "closed":
        raise HTTPException(status_code=409, detail="Report is already closed")
    if status == "resolved" and report.get("status") == "closed":
        raise HTTPException(status_code=409, detail="Closed reports cannot be resolved")
    now = datetime.now(timezone.utc)
    timestamp_field = "closed_at" if status == "closed" else "resolved_at"
    update_result = lost_found_items_collection.update_one(
        {"_id": report["_id"], "status": report.get("status")},
        {"$set": {"status": status, timestamp_field: now, "updated_at": now}},
    )
    if update_result.matched_count != 1:
        raise HTTPException(
            status_code=409,
            detail=f"Report changed during {status}. Please retry.",
        )
    report.update({"status": status, timestamp_field: now, "updated_at": now})
    related_match_ids = set()
    for match in lost_found_matches_collection.find({}):
        if (
            match.get("match_status") in (None, "pending", "verification_pending")
            and report["_id"]
            in (match.get("queried_report_id"), match.get("candidate_report_id"))
        ):
            related_match_ids.add(match["_id"])
            lost_found_matches_collection.update_one(
                {"_id": match["_id"]},
                {
                    "$set": {
                        "match_status": "invalidated",
                        "invalidated_at": now,
                        "invalidation_reason": "report_closed_or_resolved",
                        "updated_at": now,
                    }
                },
            )
    for claim in lost_found_claims_collection.find({}):
        if (
            claim.get("match_id") in related_match_ids
            and claim.get("verification_status") == "pending"
        ):
            review_result = lost_found_claims_collection.update_one(
                {"_id": claim["_id"]},
                {
                    "$set": {
                        "verification_status": "invalidated",
                        "updated_at": now,
                    }
                },
            )
            if review_result.matched_count != 1:
                raise HTTPException(
                    status_code=409,
                    detail="Match request has already been reviewed",
                )
    return _report_output(report)


@router.patch("/{report_id}/close")
def close_lost_found_report(
    report_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    return _change_report_status(report_id, "closed", user)


@router.patch("/{report_id}/resolve")
def resolve_lost_found_report(
    report_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    return _change_report_status(report_id, "resolved", user)


@router.get("/{report_id}")
def get_lost_found_report(
    report_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    report = _find_report(report_id)
    _require_owner_or_admin(report, user)
    return _report_output(report)
