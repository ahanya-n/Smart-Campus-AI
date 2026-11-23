"""Private mood and study-document APIs for the assistant.

Contract:
- POST /assistant/mood/check-ins -> {id, mood, sentiment, score, created_at, support_message?}
- GET /assistant/mood/check-ins -> {check_ins: [...]}, restricted to the signed-in student.
- GET /assistant/mood/analytics -> aggregate groups only; groups smaller than five are omitted.
- Study and placement uploads store extracted text under the authenticated user's MongoDB id.
  Document content is analysed locally and is never sent to an AI or search provider.
- Placement research sends only the career goal to Tavily after explicit consent.
- POST /assistant/study/documents -> {id, filename, summary, word_count}
- GET /assistant/study/documents -> {documents: [...]}
- POST /assistant/study/documents/{id}/quiz -> {questions: [...]}
"""

import json
import os
import re
from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, ConfigDict, Field

from database import (
    assistant_documents_collection,
    mood_check_ins_collection,
    students_collection,
    users_collection,
)
from dependencies.auth import require_roles
from services.assistant_documents import (
    analyze_study_text,
    analyze_job_description,
    answer_study_question,
    build_flashcards,
    build_quiz,
    extract_uploaded_document,
    summarize_text,
)

router = APIRouter(prefix="/assistant", tags=["Assistant Private Data"])
MINIMUM_ANALYTICS_GROUP_SIZE = 5
MOOD_SCORES = {
    "very_low": 1,
    "low": 2,
    "neutral": 3,
    "good": 4,
    "very_good": 5,
}


class MoodCheckInRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mood: Literal["very_low", "low", "neutral", "good", "very_good"]
    reflection: str | None = Field(None, max_length=2000)


class PlacementResearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    career_goal: str = Field(min_length=2, max_length=500)
    job_description: str | None = Field(None, max_length=10_000)
    allow_external_processing: bool = False


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return str(value)


def _sentiment(score: int) -> str:
    if score < 3:
        return "negative"
    if score > 3:
        return "positive"
    return "neutral"


def _mood_response(record: dict) -> dict[str, Any]:
    result = {
        "id": str(record["_id"]),
        "mood": record["mood"],
        "sentiment": record["sentiment"],
        "score": record["score"],
        "created_at": _iso(record["created_at"]),
    }
    if record.get("support_message"):
        result["support_message"] = record["support_message"]
    if record.get("reflection"):
        result["reflection"] = record["reflection"]
    return result


@router.post("/mood/check-ins")
def create_mood_check_in(
    data: MoodCheckInRequest,
    user: dict = Depends(require_roles("student")),
):
    """Create a non-diagnostic check-in, kept out of chat conversations and prompts."""
    score = MOOD_SCORES[data.mood]
    support_message = None
    if score <= 2:
        support_message = (
            "This check-in is not a diagnosis. Consider reaching out to someone you trust "
            "or a campus support service if you would like help."
        )
    now = datetime.now(timezone.utc)
    record = {
        "user_id": user["_id"],
        "mood": data.mood,
        "sentiment": _sentiment(score),
        "score": score,
        "created_at": now,
    }
    reflection = data.reflection.strip() if data.reflection else ""
    if reflection:
        record["reflection"] = reflection
    if support_message:
        record["support_message"] = support_message
    result = mood_check_ins_collection.insert_one(record)
    record["_id"] = result.inserted_id
    return _mood_response(record)


@router.get("/mood/check-ins")
def list_mood_check_ins(
    limit: int = Query(100, ge=1, le=500),
    user: dict = Depends(require_roles("student")),
):
    """List only the authenticated student's own check-ins."""
    records = mood_check_ins_collection.find(
        {"user_id": user["_id"]},
        {"user_id": 0},
    ).sort("created_at", -1).limit(limit)
    return {"check_ins": [_mood_response(record) for record in records]}


@router.get("/mood/analytics")
def get_mood_analytics(
    user: dict = Depends(require_roles("admin", "faculty")),
):
    """Return latest-per-student aggregates; suppress every group below five people."""
    linked_users = list(users_collection.find(
        {
            "role": "student",
            "student_id": {"$type": "string", "$ne": ""},
        },
        {"_id": 1, "student_id": 1},
    ))
    by_student_id = {
        record["student_id"]: record
        for record in students_collection.find(
            {"student_id": {"$in": [item["student_id"] for item in linked_users]}},
            {"student_id": 1, "department": 1, "semester": 1},
        )
    }
    if not linked_users or not by_student_id:
        return {
            "suppressed": False,
            "minimum_group_size": MINIMUM_ANALYTICS_GROUP_SIZE,
            "groups": [],
        }

    latest_by_user: dict[ObjectId, dict] = {}
    user_to_student = {item["_id"]: item["student_id"] for item in linked_users}
    for check_in in mood_check_ins_collection.find(
        {"user_id": {"$in": list(user_to_student)}},
        {"user_id": 1, "mood": 1, "sentiment": 1, "score": 1, "created_at": 1},
    ).sort("created_at", -1):
        latest_by_user.setdefault(check_in["user_id"], check_in)

    grouped: dict[tuple[str, str | None], list[dict]] = defaultdict(list)
    for user_id, check_in in latest_by_user.items():
        student = by_student_id.get(user_to_student[user_id])
        department = student.get("department") if student else None
        if not isinstance(department, str) or not department.strip():
            continue
        semester = student.get("semester")
        grouped[(department.strip(), str(semester) if semester is not None else None)].append(check_in)

    groups = []
    suppressed = False
    for (department, semester), check_ins in sorted(grouped.items()):
        if len(check_ins) < MINIMUM_ANALYTICS_GROUP_SIZE:
            suppressed = True
            continue
        sentiment_counts = {"negative": 0, "neutral": 0, "positive": 0}
        for check_in in check_ins:
            sentiment_counts[check_in["sentiment"]] += 1
        group = {
            "department": department,
            "count": len(check_ins),
            "sentiment_counts": sentiment_counts,
            "average_score": round(
                sum(int(check_in["score"]) for check_in in check_ins) / len(check_ins),
                2,
            ),
        }
        if semester is not None:
            group["semester"] = semester
        groups.append(group)
    return {
        "suppressed": suppressed,
        "minimum_group_size": MINIMUM_ANALYTICS_GROUP_SIZE,
        "groups": groups,
    }


async def _store_document(file: UploadFile, user: dict, purpose: str) -> dict[str, Any]:
    filename, text, size_bytes = await extract_uploaded_document(file)
    now = datetime.now(timezone.utc)
    summary = summarize_text(text)
    record = {
        "user_id": user["_id"],
        "purpose": purpose,
        "filename": filename,
        "content": text,
        "summary": summary,
        "word_count": len(re.findall(r"\b[\w'-]+\b", text)),
        "size_bytes": size_bytes,
        "created_at": now,
    }
    result = assistant_documents_collection.insert_one(record)
    return {
        "id": str(result.inserted_id),
        "filename": filename,
        "summary": summary,
        "word_count": record["word_count"],
    }


@router.post("/study/documents")
async def upload_study_document(
    file: UploadFile = File(...),
    user: dict = Depends(require_roles("student")),
):
    """Accept private PDF/DOCX/TXT material; all extraction and summaries are local."""
    return await _store_document(file, user, "study")


@router.get("/study/documents")
def list_study_documents(
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(require_roles("student")),
):
    """List the current student's study documents without exposing extracted text."""
    records = assistant_documents_collection.find(
        {"user_id": user["_id"], "purpose": "study"},
        {"content": 0, "user_id": 0, "size_bytes": 0},
    ).sort("created_at", -1).limit(limit)
    return {
        "documents": [
            {
                "id": str(record["_id"]),
                "filename": record["filename"],
                "summary": record["summary"],
                "word_count": record["word_count"],
                "created_at": _iso(record["created_at"]),
            }
            for record in records
        ]
    }


def _owned_study_document(document_id: str, user: dict) -> dict:
    try:
        object_id = ObjectId(document_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail="Study document not found")
    document = assistant_documents_collection.find_one({
        "_id": object_id,
        "user_id": user["_id"],
        "purpose": "study",
    })
    if document is None:
        raise HTTPException(status_code=404, detail="Study document not found")
    return document


@router.delete("/study/documents/{document_id}")
def delete_study_document(
    document_id: str,
    user: dict = Depends(require_roles("student")),
):
    """Delete one of the authenticated student's private study documents."""
    document = _owned_study_document(document_id, user)
    assistant_documents_collection.delete_one({
        "_id": document["_id"],
        "user_id": user["_id"],
        "purpose": "study",
    })
    return {"deleted": True, "id": document_id}


@router.post("/study/documents/{document_id}/quiz")
def create_study_quiz(
    document_id: str,
    user: dict = Depends(require_roles("student")),
):
    """Build deterministic quiz questions from private text; never invoke a provider."""
    document = _owned_study_document(document_id, user)
    return {"questions": build_quiz(document["content"])}


@router.post("/study/documents/{document_id}/analysis")
def analyze_study_document(
    document_id: str,
    user: dict = Depends(require_roles("student")),
):
    """Return a deterministic analysis grounded only in the owned extracted text."""
    document = _owned_study_document(document_id, user)
    return analyze_study_text(document["filename"], document["content"])


class JobDescriptionAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_description: str = Field(min_length=30, max_length=100_000)


@router.post("/placement/job-description/analysis")
def analyze_pasted_job_description(
    data: JobDescriptionAnalysisRequest,
    user: dict = Depends(require_roles("student")),
):
    """Extract requirements from pasted text without sending it to a provider."""
    return analyze_job_description("Pasted job description", data.job_description)


def _placement_research_unavailable(reason: str) -> dict[str, Any]:
    return {
        "available": False,
        "summary": None,
        "sources": [],
        "date_researched": date.today().isoformat(),
        "reason": reason,
    }


def _tavily_research(career_goal: str, api_key: str) -> dict[str, Any]:
    payload = {
        "api_key": api_key,
        "query": career_goal[:200],
        "topic": "general",
        "search_depth": "advanced",
        "max_results": 6,
        "include_answer": "basic",
    }
    request = Request(
        "https://api.tavily.com/search",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=10) as response:
        result = json.loads(response.read().decode("utf-8"))
    if not isinstance(result, dict) or not isinstance(result.get("results"), list):
        raise ValueError("Invalid web-search response")

    sources = []
    for item in result["results"]:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        title = item.get("title")
        if not isinstance(url, str) or not isinstance(title, str):
            continue
        parsed_url = urlsplit(url)
        if parsed_url.scheme != "https" or not parsed_url.hostname or parsed_url.username or parsed_url.password:
            continue
        sources.append({
            "title": title[:300],
            "url": url[:2000],
            "snippet": str(item.get("content") or "")[:1200],
            "published_at": str(item.get("published_date") or "")[:80] or None,
        })
    if not sources:
        return _placement_research_unavailable(
            "The configured search provider returned no usable HTTPS sources."
        )
    provider_answer = result.get("answer")
    summary = str(provider_answer).strip()[:3000] if isinstance(provider_answer, str) else ""
    if not summary:
        summary = "Search results are listed below. Confirm current details on each source before applying."
    return {
        "available": True,
        "summary": summary,
        "sources": sources,
        "date_researched": date.today().isoformat(),
        "reason": None,
    }


@router.post("/study/documents/{document_id}/flashcards")
def create_study_flashcards(
    document_id: str,
    user: dict = Depends(require_roles("student")),
):
    """Build local flashcards from definition-like sentences in private text."""
    document = _owned_study_document(document_id, user)
    return {"flashcards": build_flashcards(document["content"])}


@router.post("/placement/research")
def research_placement(
    data: PlacementResearchRequest,
    user: dict = Depends(require_roles("student")),
):
    """Use optional, consent-gated Tavily search and return cited sources.

    Only the career goal is sent to Tavily; uploaded or pasted job descriptions remain local.
    """
    if not data.allow_external_processing:
        return _placement_research_unavailable(
            "Live research was not requested. Enable external processing consent to search."
        )
    api_key = os.getenv("TAVILY_API_KEY", "").strip()
    if not api_key:
        return _placement_research_unavailable(
            "Live web research is unavailable because no search provider is configured."
        )
    try:
        return _tavily_research(data.career_goal, api_key)
    except (HTTPError, URLError, TimeoutError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return _placement_research_unavailable(
            "The configured web-search provider is unavailable or returned an invalid response."
        )


@router.post("/placement/documents")
async def upload_placement_document(
    file: UploadFile = File(...),
    user: dict = Depends(require_roles("student")),
):
    """Store private job-description or CV text for local, owner-only analysis."""
    return await _store_document(file, user, "placement")


@router.get("/placement/documents")
def list_placement_documents(
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(require_roles("student")),
):
    records = assistant_documents_collection.find(
        {
            "user_id": user["_id"],
            "purpose": {"$in": ["placement", "resume"]},
        },
        {"content": 0, "user_id": 0, "size_bytes": 0},
    ).sort("created_at", -1).limit(limit)
    return {
        "documents": [
            {
                "id": str(record["_id"]),
                "filename": record["filename"],
                "summary": record["summary"],
                "word_count": record["word_count"],
                "created_at": _iso(record["created_at"]),
            }
            for record in records
        ]
    }


def _owned_placement_document(document_id: str, user: dict) -> dict:
    try:
        object_id = ObjectId(document_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail="Placement document not found")
    document = assistant_documents_collection.find_one({
        "_id": object_id,
        "user_id": user["_id"],
        "purpose": {"$in": ["placement", "resume"]},
    })
    if document is None:
        raise HTTPException(status_code=404, detail="Placement document not found")
    return document


@router.post("/placement/documents/{document_id}/analysis")
def analyze_placement_document(
    document_id: str,
    user: dict = Depends(require_roles("student")),
):
    """Analyze only the signed-in student's private extracted job document."""
    document = _owned_placement_document(document_id, user)
    return analyze_job_description(document["filename"], document["content"])


@router.delete("/placement/documents/{document_id}")
def delete_placement_document(
    document_id: str,
    user: dict = Depends(require_roles("student")),
):
    document = _owned_placement_document(document_id, user)
    assistant_documents_collection.delete_one({
        "_id": document["_id"],
        "user_id": user["_id"],
        "purpose": document["purpose"],
    })
    return {"deleted": True, "id": document_id}
