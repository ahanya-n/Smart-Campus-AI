"""AI Campus Assistant and Smart Free-Time Finder routes.
"""

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from dependencies.auth import require_roles, user_role
from dependencies.student import find_linked_student
from database import students_collection, timetable_collection
from services.assistant_service import KOLKATA, process_assistant_query
from services.free_time_service import calculate_free_time
from services.data_filters import (
    is_local_demo_student,
    visible_academic_filter,
)
from validators import DayOfWeek

router = APIRouter(prefix="/assistant", tags=["Assistant"])


class ConversationTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=500)
    intent: str | None = Field(None, max_length=50)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=500)
    day: str | None = Field(None, max_length=20)
    history: list[ConversationTurn] = Field(default_factory=list, max_length=8)


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
    provider: str
    day: str
    data_summary: DataSummary
    suggestions: list[str]
    study_plan: list[dict[str, Any]] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)
    data_limitations: list[str] = Field(default_factory=list)
    disclaimer: str | None = None


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


@router.post("/chat", response_model=ChatResponse)
def assistant_chat(
    data: ChatRequest,
    user: dict = Depends(require_roles("student", "faculty")),
):
    """Answers role-scoped questions using live, authorized campus records.
    Student identity is resolved only from the authenticated account.
    Answers are strictly grounded in official records.
    """
    student = None
    if user_role(user) == "student":
        student_id = user.get("student_id")
        if isinstance(student_id, str) and student_id.strip():
            student = students_collection.find_one(
                {"student_id": student_id}, {"_id": 0}
            )
    res = process_assistant_query(
        query=data.message,
        student=student,
        day_override=data.day,
        user=user,
        history=[turn.model_dump() for turn in data.history],
    )
    return ChatResponse(
        reply=res["reply"],
        intent=res["intent"],
        provider=res["provider"],
        day=res["day"],
        data_summary=DataSummary(**res["data_summary"]),
        suggestions=res["suggestions"],
        study_plan=res.get("study_plan", []),
        recommendations=res.get("recommendations", []),
        data_limitations=res.get("data_limitations", []),
        disclaimer=res.get("disclaimer"),
    )


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

    if (
        not student
        or (
            (student.get("is_demo") is True or student.get("synthetic_demo") is True)
            and not is_local_demo_student(student)
        )
    ):
        return FreeTimeResponse(
            day=target_day,
            linked=False,
            total_classes=0,
            busy_slots=[],
            free_slots=[],
            total_free_minutes=0,
            total_free_display="0 mins",
            best_slot=None,
            message="Your account is not linked to a student record. Cannot calculate timetable free time.",
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
