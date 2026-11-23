"""AI Campus Assistant and Smart Free-Time Finder routes.
"""

from datetime import datetime, timedelta, timezone
import re
from typing import Any, Literal
from secrets import token_urlsafe

from fastapi import APIRouter, Depends, Query
from fastapi import HTTPException
from bson import ObjectId
from bson.errors import InvalidId
from pydantic import BaseModel, Field, ConfigDict

from dependencies.auth import get_current_user, require_roles, user_role
from dependencies.student import find_linked_student
from database import students_collection, timetable_collection
from services.assistant_service import KOLKATA, process_assistant_query
from services.ai_provider import AIProviderError, generate_natural_reply
from database import (
    assistant_confirmations_collection,
    assistant_conversations_collection,
    assistant_documents_collection,
    complaints_collection,
)
from database import (
    placement_sessions_collection,
    placement_progress_collection,
    academic_progress_collection,
    attendance_collection,
    database,
)
from services.agent_tools import tool_registry
from services.assistant_documents import analyze_job_description, answer_study_question
from services.free_time_service import calculate_free_time
from services.data_filters import (
    is_local_demo_student,
    visible_academic_filter,
)
from validators import DayOfWeek

router = APIRouter(prefix="/assistant", tags=["Assistant"])

_CRISIS_SIGNAL = re.compile(
    r"\b(?:suicid(?:e|al)|kill myself|end my life|self[- ]?harm|hurt myself|"
    r"don['’]t want to live|do not want to live|overdose)\b",
    re.IGNORECASE,
)
_URGENT_SUPPORT_REPLY = (
    "I’m sorry you’re facing this. If you may act on these thoughts or are in immediate "
    "danger, contact local emergency services now, go to the nearest emergency department, "
    "and tell someone you trust so you are not alone. In India, call 112 for emergencies or "
    "14416 for Tele-MANAS mental-health support. This assistant is not a crisis service."
)


class ConversationTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=500)
    intent: str | None = Field(None, max_length=50)


class PlacementContextInput(BaseModel):
    company: str | None = Field(None, max_length=120)
    role: str | None = Field(None, max_length=120)
    salary: str | None = Field(None, max_length=80)
    current_skills: str | None = Field(None, max_length=500)
    skills_to_improve: str | None = Field(None, max_length=500)
    preparation_level: str | None = Field(None, max_length=120)
    application_timeline: str | None = Field(None, max_length=120)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=500)
    mode: Literal["general", "placement", "study", "mood"] = "general"
    document_id: str | None = Field(None, min_length=24, max_length=24)
    day: str | None = Field(None, max_length=20)
    history: list[ConversationTurn] = Field(default_factory=list, max_length=8)
    conversation_id: str | None = Field(None, min_length=24, max_length=24)
    placement_context: PlacementContextInput | None = None
    complaint_category: Literal["academic", "facilities", "transport", "library", "safety", "other"] | None = None
    complaint_title: str | None = Field(None, max_length=120)
    complaint_description: str | None = Field(None, max_length=5000)


class DataSummary(BaseModel):
    linked: bool
    student_name: str | None
    overall_attendance: float | None
    low_attendance_count: int
    total_classes_day: int
    is_demo: bool = False


class ChatResponse(BaseModel):
    reply: str
    intent: str
    mode: Literal["general", "placement", "study", "mood"] = "general"
    provider: str
    day: str
    data_summary: DataSummary
    suggestions: list[str]
    study_plan: list[dict[str, Any]] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)
    data_limitations: list[str] = Field(default_factory=list)
    disclaimer: str | None = None
    conversation_id: str | None = None
    sources: list[str] = Field(default_factory=list)
    action: dict[str, Any] | None = None
    requires_confirmation: bool = False
    confirmation_id: str | None = None
    tool_results: dict[str, Any] = Field(default_factory=dict)


class ConversationSummary(BaseModel):
    id: str
    title: str
    mode: Literal["general", "placement", "study", "mood"] = "general"
    updated_at: str
    message_count: int


class ConversationDetail(BaseModel):
    id: str
    title: str
    mode: Literal["general", "placement", "study", "mood"] = "general"
    messages: list[dict[str, Any]]
    created_at: str
    updated_at: str


class ComplaintActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category: Literal["academic", "facilities", "transport", "library", "safety", "other"]
    title: str = Field(min_length=3, max_length=120)
    description: str = Field(min_length=10, max_length=5000)


class PlacementSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    topic: Literal[
        "Java", "Python", "SQL", "DBMS", "OOP", "Operating Systems",
        "Computer Networks", "DSA", "Aptitude", "HR Interview", "Technical Interview",
    ]
    difficulty: Literal["beginner", "intermediate", "advanced"] = "beginner"


class PlacementAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answer: str = Field(min_length=1, max_length=5000)


class AcademicSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subject_code: str = Field(min_length=1, max_length=20)
    subject_name: str | None = Field(None, max_length=120)
    completed_minutes: int = Field(ge=1, le=600)
    activity: str = Field(min_length=1, max_length=500)


class FreeSlotItem(BaseModel):
    start_time: str
    end_time: str
    duration_minutes: int
    duration_display: str
    slot_label: str


class BusySlotItem(BaseModel):
    start_time: str
    end_time: str
    duration_minutes: int
    duration_display: str


class FreeTimeResponse(BaseModel):
    day: str
    linked: bool
    total_classes: int
    busy_slots: list[BusySlotItem]
    free_slots: list[FreeSlotItem]
    total_free_minutes: int
    total_free_display: str
    best_slot: FreeSlotItem | None
    message: str


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return str(value)


def _object_id(value: str) -> ObjectId:
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail="Conversation not found")


def _conversation_for_user(conversation_id: str, user: dict) -> dict:
    conversation = assistant_conversations_collection.find_one(
        {"_id": _object_id(conversation_id), "user_id": user["_id"], "deleted_at": None}
    )
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


def _update_placement_context(context: dict[str, Any], message: str) -> dict[str, str]:
    updated = {
        key: str(value)[:300]
        for key, value in context.items()
        if key in {
            "company", "role", "salary", "current_skills", "skills_to_improve",
            "preparation_level", "application_timeline",
        } and isinstance(value, str)
    }
    patterns = {
        "company": (
            r"\bcompany(?: name)?\s*(?:is|:)?\s*([^.;,\n]+)",
            r"\bat\s+([A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,2})\b",
        ),
        "role": (
            r"\b(?:target role|job title|role|position)\s*(?:is|:)?\s*([^.;,\n]+)",
            r"\b(?:a|an)\s+([A-Za-z][A-Za-z0-9 /+-]{2,50}?)\s+(?:job|role|position)\s+at\b",
        ),
        "salary": (r"\b(?:salary|package|compensation)\s*(?:is|:)?\s*([^.;,\n]+)",),
        "current_skills": (r"\b(?:current skills|my skills|skills I have)\s*(?:are|is|:)?\s*([^.;\n]+)",),
        "skills_to_improve": (r"\b(?:skills to improve|improve|learn|work on)\s*(?:are|is|:)?\s*([^.;\n]+)",),
        "preparation_level": (r"\b(?:preparation level|experience level|level)\s*(?:is|:)?\s*([^.;,\n]+)",),
        "application_timeline": (
            r"\b(?:apply|applying|application)\s+(?:in|by|on)\s+([^.;,\n]+)",
            r"\b(?:application timeline|timeline)\s*(?:is|:)?\s*([^.;,\n]+)",
        ),
    }
    for field, expressions in patterns.items():
        for expression in expressions:
            match = re.search(expression, message, re.IGNORECASE)
            if match:
                value = match.group(1).strip(" .,:;-")
                if value:
                    updated[field] = value[:300]
                    break
    return updated


def _placement_reply(context: dict[str, str]) -> str:
    company = context.get("company")
    role = context.get("role")
    if not company:
        return (
            "I can create a tailored preparation roadmap. What is your dream company? "
            "You can also include your target role, salary goal, "
            "current skills, skills to improve, preparation level, and application timeline."
        )
    if not role:
        return (
            f"I have {company} as your target company. Which job role are you targeting? "
            "You can include your salary goal, current skills, skills to improve, "
            "preparation level, and application timeline in the same reply."
        )

    current_skills = context.get("current_skills", "Not provided")
    improvement = context.get("skills_to_improve", "Not provided")
    skill_status = (
        f"Skills to improve: {improvement}"
        if improvement != "Not provided"
        else "Skills to improve: not provided yet; I will not infer a personal skill gap."
    )
    next_question = next(
        (
            question
            for key, question in (
                ("salary", "What salary or package are you targeting?"),
                ("current_skills", "Which skills do you currently have?"),
                ("skills_to_improve", "Which skills would you like to improve?"),
                ("preparation_level", "How would you describe your current preparation level?"),
                ("application_timeline", "When are you planning to apply?"),
            )
            if not context.get(key)
        ),
        "Which topic would you like to prepare next?",
    )
    return (
        f"Preparation roadmap for {role} at {company}\n\n"
        f"Skills already covered (self-reported): {current_skills}\n"
        f"{skill_status}\n"
        f"Salary goal: {context.get('salary', 'not provided')}\n"
        f"Preparation level: {context.get('preparation_level', 'not provided')}\n"
        f"Application timeline: {context.get('application_timeline', 'not provided')}\n\n"
        "Suggested 3-week plan (general recommendations, not company-verified requirements):\n"
        "1. Week 1: review role fundamentals and identify two projects that demonstrate your experience.\n"
        "2. Week 2: practice role-relevant coding or work samples, technical explanations, and aptitude questions.\n"
        "3. Week 3: complete mock technical and HR interviews, then revise weak topics.\n\n"
        "These recommendations are not verified company requirements. "
        f"{next_question}"
    )


@router.post("/chat", response_model=ChatResponse)
def assistant_chat(
    data: ChatRequest,
    user: dict = Depends(require_roles("student", "faculty")),
):
    """Answers role-scoped questions using live, authorized campus records.
    Student identity is resolved only from the authenticated account.
    Answers are strictly grounded in official records.
    """
    if data.mode in {"placement", "study", "mood"} and user_role(user) != "student":
        raise HTTPException(status_code=403, detail="This assistant mode is available to students only.")
    if data.placement_context and data.mode != "placement":
        raise HTTPException(status_code=422, detail="Placement context is only valid in Placement Assistant mode.")

    student = None
    if user_role(user) == "student":
        student = find_linked_student(user)
    server_history: list[dict[str, Any]] = []
    conversation = None
    if data.conversation_id:
        conversation = _conversation_for_user(data.conversation_id, user)
        if conversation.get("mode", "general") != data.mode:
            raise HTTPException(status_code=409, detail="Conversation belongs to a different assistant mode.")
        server_history = conversation.get("messages", [])[-8:]
    history = server_history or [turn.model_dump() for turn in data.history]
    placement_context: dict[str, str] = {}
    if data.mode == "placement":
        if conversation:
            placement_context = _update_placement_context(
                conversation.get("placement_context") or {},
                "",
            )
        if data.placement_context:
            for key, value in data.placement_context.model_dump(exclude_none=True).items():
                cleaned = value.strip()
                if cleaned:
                    placement_context[key] = cleaned
        for turn in history:
            if turn.get("role") == "user":
                placement_context = _update_placement_context(
                    placement_context,
                    str(turn.get("content") or ""),
                )
        placement_context = _update_placement_context(placement_context, data.message)

    placement_document = None
    if data.mode == "placement" and data.document_id:
        try:
            placement_document = assistant_documents_collection.find_one({
                "_id": ObjectId(data.document_id),
                "user_id": user["_id"],
                "purpose": {"$in": ["placement", "resume"]},
            })
        except (InvalidId, TypeError):
            placement_document = None
        if placement_document is None:
            raise HTTPException(status_code=404, detail="Placement document not found")

    res = process_assistant_query(
        query=data.message,
        student=student,
        day_override=data.day,
        user=user,
        history=history,
    )

    if data.mode == "study" and data.document_id:
        try:
            document = assistant_documents_collection.find_one({
                "_id": ObjectId(data.document_id),
                "user_id": user["_id"],
                "purpose": "study",
            })
        except (InvalidId, TypeError):
            document = None
        if document is None:
            raise HTTPException(status_code=404, detail="Study document not found")
        text = str(document.get("content") or "").strip()
        if not text:
            raise HTTPException(status_code=422, detail="No readable text is available for this study document.")
        res["reply"] = answer_study_question(
            text,
            data.message,
            document.get("filename", "study document"),
        )
        res["intent"] = "document_grounded_study"
        res["provider"] = "extractive_document_context"
        res["recommendations"] = [
            "Ask about a topic named in the document.",
            "Request notes, MCQs, or a question with a required mark count.",
        ]

    crisis_signal = bool(_CRISIS_SIGNAL.search(data.message))
    if crisis_signal:
        res["reply"] = _URGENT_SUPPORT_REPLY
        res["intent"] = "urgent_support"
        res["study_plan"] = []
        res["recommendations"] = []
    elif data.mode == "mood":
        res["reply"] = (
            "How are you feeling after your most recent lecture or your day? "
            "You can share a general mood and, if you want, an optional academic factor "
            "such as subject difficulty, teaching pace, workload, or timetable pressure. "
            "Use the private Mood check-in page for a saved check-in; this chat does not "
            "store mood check-ins or reflections."
        )
        res["intent"] = "mood_check_in"
        res["study_plan"] = []
        res["recommendations"] = [
            "Choose only the information you want to share.",
            "This conversation is not a diagnosis or a crisis service.",
        ]
    elif data.mode == "study" and not data.document_id:
        res["reply"] = (
            "Study mode keeps uploaded material private and processes it locally. Upload a PDF, "
            "DOCX, or TXT document to get an extractive summary, quiz questions, and flashcards."
        )
        res["intent"] = "study_mode"
        res["study_plan"] = []
        res["recommendations"] = [
            "Upload notes or a reading to create a private study resource.",
            "Open the resource to generate a quiz or flashcards.",
        ]
    elif data.mode == "placement":
        if placement_document:
            placement_text = str(placement_document.get("content") or "")
            job_analysis = analyze_job_description(
                placement_document.get("filename", "placement document"),
                placement_text,
            )
            res["reply"] = answer_study_question(
                placement_text,
                data.message,
                placement_document.get("filename", "placement document"),
            )
            res["provider"] = "extractive_document_context"
            res["recommendations"] = [
                f"Extracted technical skills: {', '.join(job_analysis['technical_skills'])}."
                if job_analysis["technical_skills"]
                else "No supported technical skills were extracted from the uploaded document.",
                "Follow-up answers use only statements in the uploaded document.",
            ]
        else:
            res["reply"] = _placement_reply(placement_context)
            res["provider"] = "grounded_rule_engine"
        res["intent"] = "placement_preparation"
        res["study_plan"] = []
    if data.mode == "placement" and placement_document:
        res["data_limitations"] = [
            "Answers use only matching statements from the uploaded document; omitted details are not inferred."
        ]

    tool_results: dict[str, Any] = {}
    tool_sources: list[str] = []
    intent_tool_map = {
        "classroom_location": ("get_timetable", {"day": res["day"]}),
        "faculty_details": ("get_timetable", {"day": res["day"]}),
        "next_class": ("get_timetable", {"day": res["day"]}),
        "today_timetable": ("get_timetable", {"day": res["day"]}),
        "free_hours": ("get_free_periods", {"day": res["day"]}),
        "attendance_summary": ("get_attendance", {}),
        "subject_attendance": ("get_attendance", {}),
        "low_attendance": ("get_attendance", {}),
        "absent_classes": ("get_attendance", {}),
        "marks_summary": ("get_internal_marks", {}),
        "student_performance": ("generate_academic_recommendations", {}),
        "academic_risk": ("generate_academic_recommendations", {}),
    }
    tool_call = intent_tool_map.get(res["intent"])
    if tool_call:
        tool_name, tool_arguments = tool_call
        try:
            tool_results[tool_name] = tool_registry.execute(tool_name, user, tool_arguments)
            tool_sources.append(f"tool:{tool_name}")
        except HTTPException:
            tool_results = {}

    provider = res["provider"]
    if data.mode == "general" and res["intent"] == "general" and not crisis_signal:
        try:
            reply, provider = generate_natural_reply(
                intent=res["intent"],
                fallback_reply=res["reply"],
                user_message=data.message,
                verified_context={
                    "data_summary": res["data_summary"],
                    "suggestions": res["suggestions"],
                    "limitations": res["data_limitations"],
                },
            )
            res["reply"] = reply
        except AIProviderError:
            res["reply"] = res["reply"]
            provider = "grounded_rule_engine"

    conversation_id = None
    now = datetime.now(timezone.utc)
    if conversation is None:
        conversation_result = assistant_conversations_collection.insert_one({
            "user_id": user["_id"],
            "role": user_role(user),
            "mode": data.mode,
            "title": data.message.strip()[:60],
            "messages": [],
            "summary": "",
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        })
        conversation = {
            "_id": conversation_result.inserted_id,
            "messages": [],
            "title": data.message.strip()[:60],
            "placement_context": placement_context if data.mode == "placement" else {},
        }
    conversation_id = str(conversation["_id"])
    messages = conversation.get("messages", [])[-40:]
    messages.extend([
        {"role": "user", "content": data.message, "created_at": now.isoformat()},
        {
            "role": "assistant",
            "content": res["reply"],
            "intent": res["intent"],
            "provider": provider,
            "created_at": now.isoformat(),
        },
    ])
    conversation_update = {"messages": messages[-40:], "updated_at": now}
    if data.mode == "placement":
        conversation_update["placement_context"] = placement_context
    assistant_conversations_collection.update_one(
        {"_id": conversation["_id"], "user_id": user["_id"], "deleted_at": None},
        {"$set": conversation_update},
    )

    sources = []
    if res["data_summary"].get("linked"):
        sources.extend(["MongoDB authorized campus records"])
    if data.mode == "placement" and placement_document:
        sources.append(
            f"Private uploaded document: {placement_document.get('filename', 'placement document')}"
        )
    sources.extend(f"tool:{tool_name}" for tool_name in tool_results)
    if data.mode == "general" and res["intent"] == "general" and not crisis_signal:
        sources.append("General educational guidance")

    action = None
    requires_confirmation = False
    confirmation_id = None
    if res["intent"] == "create_complaint" and user_role(user) == "student":
        action = {
            "tool": "create_complaint",
            "status": "requires_details",
            "required_fields": ["category", "title", "description"],
        }
        requires_confirmation = True
        if (
            data.complaint_category
            and data.complaint_title
            and 3 <= len(data.complaint_title.strip()) <= 120
            and data.complaint_description
            and 10 <= len(data.complaint_description.strip()) <= 5000
        ):
            now_confirmation = datetime.now(timezone.utc)
            confirmation_id = token_urlsafe(24)
            assistant_confirmations_collection.insert_one({
                "_id": ObjectId(),
                "confirmation_id": confirmation_id,
                "user_id": user["_id"],
                "tool": "create_complaint",
                "arguments": {
                    "category": data.complaint_category,
                    "title": data.complaint_title.strip(),
                    "description": data.complaint_description.strip(),
                },
                "status": "pending",
                "created_at": now_confirmation,
                "expires_at": now_confirmation + timedelta(minutes=10),
            })
            action = {
                "tool": "create_complaint",
                "status": "requires_confirmation",
                "summary": {
                    "category": data.complaint_category,
                    "title": data.complaint_title.strip(),
                    "description": data.complaint_description.strip(),
                },
            }

    return ChatResponse(
        reply=res["reply"],
        intent=res["intent"],
        mode=data.mode,
        provider=provider,
        day=res["day"],
        data_summary=DataSummary(**res["data_summary"]),
        suggestions=res["suggestions"],
        study_plan=res.get("study_plan", []),
        recommendations=res.get("recommendations", []),
        data_limitations=res.get("data_limitations", []),
        disclaimer=res.get("disclaimer"),
        conversation_id=conversation_id,
        sources=sources,
        action=action,
        requires_confirmation=requires_confirmation,
        confirmation_id=confirmation_id,
        tool_results=tool_results,
    )


@router.get("/conversations", response_model=list[ConversationSummary])
def list_assistant_conversations(
    mode: Literal["general", "placement", "study", "mood"] = Query("general"),
    user: dict = Depends(require_roles("student", "faculty")),
):
    mode_filter = (
        {"$or": [{"mode": mode}, {"mode": {"$exists": False}}]}
        if mode == "general"
        else {"mode": mode}
    )
    conversations = assistant_conversations_collection.find(
        {"user_id": user["_id"], "deleted_at": None, **mode_filter},
        {"title": 1, "messages": 1, "created_at": 1, "updated_at": 1},
    ).sort("updated_at", -1).limit(50)
    return [
        ConversationSummary(
            id=str(item["_id"]),
            title=item.get("title") or "New conversation",
            mode=item.get("mode", "general") if item.get("mode") in {"general", "placement", "study", "mood"} else "general",
            updated_at=_iso(item.get("updated_at")),
            message_count=len(item.get("messages", [])),
        )
        for item in conversations
    ]


@router.post("/conversations", response_model=ConversationDetail)
def create_assistant_conversation(
    mode: Literal["general", "placement", "study", "mood"] = Query("general"),
    user: dict = Depends(require_roles("student", "faculty")),
):
    if mode in {"placement", "study", "mood"} and user_role(user) != "student":
        raise HTTPException(status_code=403, detail="This assistant mode is available to students only.")
    now = datetime.now(timezone.utc)
    result = assistant_conversations_collection.insert_one({
        "user_id": user["_id"],
        "role": user_role(user),
        "mode": mode,
        "title": "New conversation",
        "messages": [],
        "summary": "",
        "created_at": now,
        "updated_at": now,
        "deleted_at": None,
    })
    return ConversationDetail(
        id=str(result.inserted_id),
        title="New conversation",
        mode=mode,
        messages=[],
        created_at=_iso(now),
        updated_at=_iso(now),
    )


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
def get_assistant_conversation(
    conversation_id: str,
    user: dict = Depends(require_roles("student", "faculty")),
):
    conversation = _conversation_for_user(conversation_id, user)
    return ConversationDetail(
        id=str(conversation["_id"]),
        title=conversation.get("title") or "New conversation",
        mode=conversation.get("mode", "general") if conversation.get("mode") in {"general", "placement", "study", "mood"} else "general",
        messages=conversation.get("messages", [])[-40:],
        created_at=_iso(conversation.get("created_at")),
        updated_at=_iso(conversation.get("updated_at")),
    )


@router.delete("/conversations/{conversation_id}")
def delete_assistant_conversation(
    conversation_id: str,
    user: dict = Depends(require_roles("student", "faculty")),
):
    conversation = _conversation_for_user(conversation_id, user)
    now = datetime.now(timezone.utc)
    result = assistant_conversations_collection.update_one(
        {"_id": conversation["_id"], "user_id": user["_id"], "deleted_at": None},
        {"$set": {"deleted_at": now, "updated_at": now}},
    )
    if result.matched_count != 1:
        raise HTTPException(status_code=409, detail="Conversation changed during deletion")
    return {"deleted": True, "id": str(conversation["_id"])}


@router.post("/actions/prepare")
def prepare_assistant_action(
    data: ComplaintActionRequest,
    user: dict = Depends(require_roles("student")),
):
    now = datetime.now(timezone.utc)
    confirmation_id = token_urlsafe(24)
    assistant_confirmations_collection.insert_one({
        "_id": ObjectId(),
        "confirmation_id": confirmation_id,
        "user_id": user["_id"],
        "tool": "create_complaint",
        "arguments": data.model_dump(),
        "status": "pending",
        "created_at": now,
        "expires_at": now + timedelta(minutes=10),
    })
    return {
        "confirmation_id": confirmation_id,
        "tool": "create_complaint",
        "summary": {
            "category": data.category,
            "title": data.title,
            "description": data.description,
        },
        "requires_confirmation": True,
    }


@router.post("/actions/{confirmation_id}/confirm")
def confirm_assistant_action(
    confirmation_id: str,
    user: dict = Depends(require_roles("student")),
):
    now = datetime.now(timezone.utc)
    confirmation = assistant_confirmations_collection.find_one({
        "confirmation_id": confirmation_id,
        "user_id": user["_id"],
        "status": "pending",
        "expires_at": {"$gt": now},
    })
    if confirmation is None:
        raise HTTPException(status_code=404, detail="Confirmation is missing, expired or already used")
    arguments = confirmation["arguments"]
    claimed = assistant_confirmations_collection.update_one(
        {"_id": confirmation["_id"], "status": "pending"},
        {"$set": {"status": "claimed", "updated_at": now}},
    )
    if claimed.matched_count != 1:
        raise HTTPException(status_code=409, detail="Confirmation has already been used")

    document = {
        "user_id": user["_id"],
        "student_id": user.get("student_id"),
        "student_name": user.get("name", ""),
        "student_email": user.get("email", ""),
        **arguments,
        "status": "pending",
        "assigned_to": None,
        "assigned_staff_name": None,
        "resolution_notes": None,
        "responses": [],
        "created_at": now,
        "updated_at": now,
    }
    try:
        result = complaints_collection.insert_one(document)
    except Exception:
        assistant_confirmations_collection.update_one(
            {"_id": confirmation["_id"], "status": "claimed"},
            {"$set": {"status": "pending", "retryable": True, "updated_at": now}},
        )
        raise HTTPException(
            status_code=503,
            detail="Complaint could not be created. The confirmation remains retryable.",
        )
    assistant_confirmations_collection.update_one(
        {"_id": confirmation["_id"]},
        {"$set": {"status": "completed", "result_id": str(result.inserted_id), "updated_at": now}},
    )
    return {
        "success": True,
        "tool": "create_complaint",
        "result": {"id": str(result.inserted_id), "status": "pending"},
    }


@router.post("/actions/{confirmation_id}/cancel")
def cancel_assistant_action(
    confirmation_id: str,
    user: dict = Depends(require_roles("student")),
):
    now = datetime.now(timezone.utc)
    result = assistant_confirmations_collection.update_one(
        {
            "confirmation_id": confirmation_id,
            "user_id": user["_id"],
            "status": "pending",
        },
        {"$set": {"status": "cancelled", "updated_at": now}},
    )
    if result.matched_count != 1:
        raise HTTPException(status_code=404, detail="Confirmation is missing or already used")
    return {"cancelled": True}


@router.get("/tools")
def list_agent_tools(user: dict = Depends(get_current_user)):
    visible = []
    for tool in tool_registry.list():
        if user_role(user) in tool["roles"]:
            visible.append(tool)
    return {"tools": visible}


class ExecuteToolRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    arguments: dict[str, Any] = Field(default_factory=dict)


@router.post("/tools/{tool_name}/execute")
def execute_agent_tool(
    tool_name: str,
    data: ExecuteToolRequest,
    user: dict = Depends(get_current_user),
):
    return tool_registry.execute(tool_name, user, data.arguments)


_PLACEMENT_QUESTIONS = {
    "Java": [
        "What is the difference between an interface and an abstract class?",
        "Explain JVM, JRE and JDK.",
    ],
    "Python": [
        "Explain a list and a tuple in Python.",
        "What are decorators and where are they useful?",
    ],
    "SQL": [
        "Write the SQL to retrieve duplicate rows from a table.",
        "Explain INNER JOIN and LEFT JOIN.",
    ],
    "DBMS": [
        "Explain ACID properties.",
        "What is database normalization?",
    ],
    "OOP": [
        "Explain encapsulation with an example.",
        "What is polymorphism?",
    ],
    "Operating Systems": [
        "Explain process and thread differences.",
        "What is deadlock?",
    ],
    "Computer Networks": [
        "Explain TCP and UDP differences.",
        "What happens during a three-way handshake?",
    ],
    "DSA": [
        "Explain the time complexity of binary search.",
        "Solve a problem using a stack.",
    ],
    "Aptitude": [
        "If a train travels 60 km in 1 hour, how far does it travel in 30 minutes?",
        "A product costs 100 after a 20 percent discount. What was the original price?",
    ],
    "HR Interview": [
        "Tell me about yourself.",
        "Describe a challenge and how you handled it.",
    ],
    "Technical Interview": [
        "Explain a technical project you completed.",
        "How would you debug a slow application?",
    ],
}


@router.post("/placement/practice")
def create_placement_practice(
    data: PlacementSessionRequest,
    user: dict = Depends(require_roles("student")),
):
    now = datetime.now(timezone.utc)
    questions = _PLACEMENT_QUESTIONS[data.topic]
    question = questions[0]
    if data.difficulty == "advanced" and len(questions) > 1:
        question = questions[1]
    result = placement_sessions_collection.insert_one({
        "user_id": user["_id"],
        "topic": data.topic,
        "difficulty": data.difficulty,
        "question": question,
        "status": "pending",
        "answer": None,
        "evaluation": None,
        "score": None,
        "created_at": now,
        "updated_at": now,
    })
    return {
        "id": str(result.inserted_id),
        "topic": data.topic,
        "difficulty": data.difficulty,
        "question": question,
        "status": "pending",
    }


@router.get("/placement/practice")
def list_placement_practice(
    user: dict = Depends(require_roles("student")),
):
    items = placement_sessions_collection.find(
        {"user_id": user["_id"]},
        {"answer": 0},
    ).sort("created_at", -1).limit(50)
    result = []
    for item in items:
        item["id"] = str(item.pop("_id"))
        result.append(item)
    return {"sessions": result, "total": len(result)}


@router.post("/placement/practice/{session_id}/evaluate")
def evaluate_placement_practice(
    session_id: str,
    data: PlacementAnswerRequest,
    user: dict = Depends(require_roles("student")),
):
    try:
        object_id = ObjectId(session_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail="Practice session not found")
    session = placement_sessions_collection.find_one({
        "_id": object_id,
        "user_id": user["_id"],
    })
    if not session:
        raise HTTPException(status_code=404, detail="Practice session not found")
    if session.get("status") == "evaluated":
        raise HTTPException(status_code=409, detail="Practice session has already been evaluated")

    answer = data.answer.strip()
    required_terms = {
        "Java": ("interface", "abstract", "class"),
        "Python": ("list", "tuple"),
        "SQL": ("join", "select"),
        "DBMS": ("acid", "atomic", "consistency", "isolation", "durability"),
        "OOP": ("encapsulation", "polymorphism", "inheritance"),
        "Operating Systems": ("process", "thread", "deadlock"),
        "Computer Networks": ("tcp", "udp", "handshake"),
        "DSA": ("complexity", "stack", "search"),
        "Aptitude": ("30", "answer"),
        "HR Interview": ("team", "challenge", "example"),
        "Technical Interview": ("project", "debug", "problem"),
    }.get(session["topic"], ())
    lowered = answer.lower()
    matched = sum(1 for term in required_terms if term in lowered)
    minimum = 1 if len(required_terms) <= 2 else 2
    score = 100 if matched >= minimum else max(20, int((matched / max(len(required_terms), 1)) * 100))
    evaluation = (
        "Rule-based evaluation: the answer includes relevant terms."
        if score >= 80
        else "Rule-based evaluation: add relevant concepts and a practical example."
    )
    now = datetime.now(timezone.utc)
    claimed = placement_sessions_collection.update_one(
        {
            "_id": object_id,
            "user_id": user["_id"],
            "status": "pending",
        },
        {"$set": {
            "answer": answer,
            "evaluation": evaluation,
            "score": score,
            "status": "evaluated",
            "updated_at": now,
        }},
    )
    if getattr(claimed, "matched_count", 0) != 1:
        raise HTTPException(status_code=409, detail="Practice session was already evaluated")
    progress = placement_progress_collection.find_one({"user_id": user["_id"]})
    topic = session["topic"]
    completed = (progress or {}).get("completed_sessions", 0) + 1
    weak_topics = set((progress or {}).get("weak_topics", []))
    if score < 80:
        weak_topics.add(topic)
    else:
        weak_topics.discard(topic)
    placement_progress_collection.update_one(
        {"user_id": user["_id"]},
        {"$set": {
            "completed_sessions": completed,
            "weak_topics": sorted(weak_topics),
            "last_topic": topic,
            "average_score": round(
                ((((progress or {}).get("average_score") or 0) * ((progress or {}).get("completed_sessions", 0)) + score) / completed),
                2,
            ),
            "updated_at": now,
        }, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )
    return {
        "id": session_id,
        "score": score,
        "evaluation": evaluation,
        "provider": "grounded_rule_engine",
        "weak_topic": score < 80,
    }


@router.get("/placement/progress")
def get_placement_progress(
    user: dict = Depends(require_roles("student")),
):
    progress = placement_progress_collection.find_one({"user_id": user["_id"]}, {"_id": 0})
    if not progress:
        return {
            "completed_sessions": 0,
            "average_score": None,
            "weak_topics": [],
            "last_topic": None,
            "next_topic": "Java",
        }
    progress["next_topic"] = (
        progress["weak_topics"][0]
        if progress.get("weak_topics")
        else "Python"
    )
    progress.pop("user_id", None)
    return progress


@router.post("/academic-progress/sessions")
def complete_academic_progress_session(
    data: AcademicSessionRequest,
    user: dict = Depends(require_roles("student")),
):
    student = find_linked_student(user)
    if not student:
        raise HTTPException(status_code=409, detail="Account is not linked to a student record")
    subject_code = data.subject_code.strip().upper()
    authorized_subject = timetable_collection.find_one({
        "department": student.get("department"),
        "semester": student.get("semester"),
        "subject_code": subject_code,
    }, {"subject_name": 1, "subject_code": 1})
    attendance_subject = attendance_collection.find_one({
        "student_id": student["student_id"],
        "subject_code": subject_code,
    }, {"subject_name": 1, "subject_code": 1})
    marks_subject = database["marks"].find_one({
        "student_id": student["student_id"],
        "subject_code": subject_code,
    }, {"subject_name": 1, "subject_code": 1})
    authoritative_subject = authorized_subject or attendance_subject or marks_subject
    if not authoritative_subject:
        raise HTTPException(
            status_code=422,
            detail="Subject is not in the student's authorized timetable or academic records",
        )
    authoritative_name = (
        authoritative_subject.get("subject_name")
        or subject_code
    )
    now = datetime.now(timezone.utc)
    result = academic_progress_collection.insert_one({
        "user_id": user["_id"],
        "student_id": student["student_id"],
        "subject_code": subject_code,
        "subject_name": authoritative_name,
        "completed_minutes": data.completed_minutes,
        "activity": data.activity,
        "created_at": now,
        "updated_at": now,
    })
    return {
        "id": str(result.inserted_id),
        "subject_code": subject_code,
        "subject_name": authoritative_name,
        "completed_minutes": data.completed_minutes,
        "activity": data.activity,
    }


@router.get("/academic-progress")
def get_academic_progress(
    user: dict = Depends(require_roles("student")),
):
    student = find_linked_student(user)
    if not student:
        return {"linked": False, "sessions": [], "subject_totals": {}, "next_activity": None}
    sessions = list(academic_progress_collection.find(
        {"user_id": user["_id"]},
        {"_id": 0, "user_id": 0},
    ).sort("created_at", -1).limit(100))
    totals: dict[str, int] = {}
    for session in sessions:
        code = str(session.get("subject_code", ""))
        totals[code] = totals.get(code, 0) + int(session.get("completed_minutes", 0))
    attendance = list(attendance_collection.find(
        {"student_id": student["student_id"]},
        {"_id": 0},
    ))
    weak_codes = sorted({
        str(record.get("subject_code", "")).upper()
        for record in attendance
        if record.get("attendance_percentage") is not None
        and float(record["attendance_percentage"]) < 75
    })
    next_activity = weak_codes[0] if weak_codes else (
        sorted(totals, key=lambda code: totals[code])[0] if totals else None
    )
    return {
        "linked": True,
        "sessions": sessions,
        "subject_totals": totals,
        "weak_subjects": weak_codes,
        "next_activity": next_activity,
    }


@router.get("/free-time", response_model=FreeTimeResponse)
def get_free_time(
    day: DayOfWeek | None = Query(None, description="Day to calculate free time for"),
    user: dict = Depends(require_roles("student")),
):
    """Calculates free intervals strictly between classes for the authenticated student's timetable.
    Merges overlapping classes and rejects negative / non-existent gaps.
    """
    target_day = day or datetime.now(KOLKATA).strftime("%A")
    student = find_linked_student(user)

    synthetic_profile = bool(
        student
        and (student.get("is_demo") is True or student.get("synthetic_demo") is True)
        and not is_local_demo_student(student)
    )
    if not student or synthetic_profile:
        message = (
            "Your account is linked to a synthetic/demo student profile. "
            "Official academic records are unavailable; ask a college administrator "
            "to verify and relink your account."
            if synthetic_profile
            else "Your account is not linked to a student record. Cannot calculate timetable free time."
        )
        return FreeTimeResponse(
            day=target_day,
            linked=False,
            total_classes=0,
            busy_slots=[],
            free_slots=[],
            total_free_minutes=0,
            total_free_display="0 mins",
            best_slot=None,
            message=message,
        )

    dept = student.get("department")
    sem = student.get("semester")
    try:
        sem_val: Any = int(sem)
    except (TypeError, ValueError):
        sem_val = str(sem)

    query = {
        "department": dept,
        "semester": sem_val,
        **visible_academic_filter(student),
    }
    if student.get("section"):
        query["$or"] = [
            {"section": student["section"]},
            {"section": {"$exists": False}},
        ]
    entries = list(timetable_collection.find(query, {"_id": 0}))

    analysis = calculate_free_time(entries, target_day)

    best_slot_obj = FreeSlotItem(**analysis["best_slot"]) if analysis.get("best_slot") else None

    return FreeTimeResponse(
        day=target_day,
        linked=True,
        total_classes=analysis["total_classes"],
        busy_slots=[BusySlotItem(**b) for b in analysis["busy_slots"]],
        free_slots=[FreeSlotItem(**f) for f in analysis["free_slots"]],
        total_free_minutes=analysis["total_free_minutes"],
        total_free_display=analysis.get("total_free_display", "0 mins"),
        best_slot=best_slot_obj,
        message=(
            "DEMO DATA: synthetic sample schedule. " + analysis["message"]
            if is_local_demo_student(student)
            else analysis["message"]
        ),
    )
