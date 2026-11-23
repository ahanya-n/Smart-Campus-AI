"""Role-scoped conversational campus answers grounded in official records."""

import re
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId

from database import (
    academic_progress_collection,
    assignments_collection,
    attendance_collection,
    attendance_entries_collection,
    database,
    notifications_collection,
    students_collection,
    timetable_collection,
    users_collection,
)
from services.academic_intelligence import analyze_student, generate_study_plan
from services.data_filters import (
    is_local_demo_account,
    is_local_demo_student,
    trusted_demo_owner_markers,
    visible_academic_filter,
)

KOLKATA = timezone(timedelta(hours=5, minutes=30), name="Asia/Kolkata")
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
LOW_ATTENDANCE_THRESHOLD = 75.0

STUDENT_SUGGESTIONS = [
    "Where is my next class?",
    "When is my next class?",
    "Show my subject-wise attendance.",
    "Which subject has low attendance?",
    "Today which hour am I free?",
    "Who is taking my next class?",
    "How many classes did I miss?",
    "Create a study plan for my free hours.",
    "What is my internal marks average?",
]

FACULTY_SUGGESTIONS = [
    "What is my next class?",
    "Where is my next classroom?",
    "What is my timetable today?",
    "Today which hour am I free?",
    "Show my assigned subjects.",
    "How many students are assigned to me?",
    "Which students have attendance below 75%?",
    "Show attendance for my assigned subject.",
    "Which students need academic attention?",
    "Generate a summary of my class performance.",
]


def _normalise_text(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value).casefold()).strip()


def detect_intent(query: str, history: list[dict[str, Any]] | None = None) -> str:
    """Classifies phrased requests using combinations of language cues."""
    text = _normalise_text(query)
    if not text:
        return "general"

    scores: dict[str, int] = {}

    def add(intent: str, points: int, *patterns: str) -> None:
        if any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns):
            scores[intent] = max(scores.get(intent, 0), points)

    add(
        "placement_preparation",
        11,
        r"\b(placement|interview|mock interview|resume|aptitude|coding practice|leetcode|dsa)\b",
        r"\b(target company|job role|hr interview|technical interview)\b",
        r"\b(java|python|sql|dbms|oop|operating systems|computer networks)\b.{0,50}\b(learn|practice|prepare|interview|question|explain)\b",
    )
    add(
        "create_complaint",
        12,
        r"\b(create|submit|file|open)\b.{0,30}\bcomplaint\b",
        r"\bcomplaint\b.{0,30}\b(create|submit|file|open)\b",
    )
    add(
        "placement_preparation",
        10,
        r"\b(study|prepare)\b.{0,40}\b(placement|interview|resume|aptitude)\b",
    )

    add(
        "classroom_location",
        10,
        r"\bwhere\b.{0,50}\b(class|classroom|room|lecture|period)\b",
        r"\b(classroom|room number|which room)\b",
        r"\b(elli|yelli|ellide|yelli ide|ಎಲ್ಲಿ|ಎಲ್ಲಿದೆ|ಕೊಠಡಿ)\b",
    )
    add(
        "faculty_details",
        9,
        r"\bwho\b.{0,40}\b(taking|teaching|handling|conducting)\b",
        r"\b(faculty|teacher|lecturer|professor)\b",
        r"\b(yaaru|yāru|ಯಾರು|ಶಿಕ್ಷಕರು|ಯಾರು ತೆಗೆದುಕೊಳ್ಳುತ್ತಾರೆ)\b",
    )
    add(
        "next_class",
        8,
        r"\b(next|upcoming|nearest)\b.{0,40}\b(class|lecture|period)\b",
        r"\b(mundina|ಮುಂದಿನ)\b.{0,30}\b(class|lecture|ಕ್ಲಾಸ್|ತರಗತಿ)\b",
        r"\b(class|lecture)\b.{0,30}\b(yavaaga|when|ಯಾವಾಗ)\b",
    )
    add(
        "today_timetable",
        8,
        r"\b(timetable|time table|schedule)\b",
        r"\b(classes|class)\b.{0,30}\b(today|today's|ivattu|ಇವತ್ತು|ಇಂದು)\b",
        r"\b(what|which|yava)\b.{0,30}\b(classes|class|lectures)\b",
        r"\b(yava|ಯಾವ)\b.{0,30}\b(class|ಕ್ಲಾಸ್|ತರಗತಿ)\b",
        r"\b(ಇವತ್ತು|ಇಂದು)\b.{0,30}\b(ಕ್ಲಾಸ್|ತರಗತಿ|ವೇಳಾಪಟ್ಟಿ|ಟೈಮ್ ಟೇಬಲ್)\b",
        r"\b(ವೇಳಾಪಟ್ಟಿ|ಟೈಮ್ ಟೇಬಲ್)\b",
        r"(ಇವತ್ತು|ಇಂದು).{0,30}(ಕ್ಲಾಸ್|ತರಗತಿ|ವೇಳಾಪಟ್ಟಿ|ಟೈಮ್ ಟೇಬಲ್)",
        r"(ವೇಳಾಪಟ್ಟಿ|ಟೈಮ್ ಟೇಬಲ್)",
    )
    add(
        "free_hours",
        9,
        r"\b(free|gap|break)\b.{0,45}\b(hour|time|slot|today|after|class)\b",
        r"\b(when|which hour|what time)\b.{0,40}\bfree\b",
        r"\b(ivattu|today)\b.{0,30}\b(hour|time)\b.{0,25}\bfree\b",
        r"\b(free|khali|ಖಾಲಿ)\b.{0,35}\b(idini|am i|time|hour|ಗಂಟೆ)\b",
        r"\b(ಇವತ್ತು|ಇಂದು)\b.{0,35}\b(ಗಂಟೆ|ಸಮಯ)\b.{0,25}\b(free|ಫ್ರೀ|ಖಾಲಿ)\b",
        r"\b(ಖಾಲಿ ಸಮಯ|ಖಾಲಿ ಗಂಟೆ)\b",
        r"(ಇವತ್ತು|ಇಂದು).{0,35}(ಗಂಟೆ|ಸಮಯ).{0,25}(free|ಫ್ರೀ|ಖಾಲಿ)",
        r"(ಖಾಲಿ ಸಮಯ|ಖಾಲಿ ಗಂಟೆ)",
        r"\bfree\b.{0,30}\b(after that|after it)\b",
    )
    add(
        "study_plan",
        10,
        r"\b(study|revision| ಓದು)\b.{0,35}\b(plan|schedule|free|hour|time)\b",
        r"\b(plan|schedule)\b.{0,25}\b(study|revision)\b",
        r"\b(study plan|study schedule|ಓದು ಯೋಜನೆ|ಅಧ್ಯಯನ ಯೋಜನೆ)\b",
        r"(ಓದು ಯೋಜನೆ|ಅಧ್ಯಯನ ಯೋಜನೆ)",
    )
    add(
        "absent_classes",
        10,
        r"\b(absent|missed|miss|skipped)\b.{0,35}\b(class|classes|lecture|period)\b",
        r"\b(how many|count|number of)\b.{0,35}\b(absent|missed|miss)\b",
        r"\b(miss agide|miss madide|ತಪ್ಪಿಸಿದ ತರಗತಿ)\b",
        r"\b(eshtu|ಎಷ್ಟು)\b.{0,30}\b(miss|absent)\b",
    )
    add(
        "low_attendance",
        10,
        r"\b(low|shortage|below|less than|under|kammi|ಕಡಿಮೆ)\b.{0,45}\b(attendance|ಹಾಜರಾತಿ|75)\b",
        r"\b(attendance|ಹಾಜರಾತಿ)\b.{0,35}\b(low|shortage|below|kammi|ಕಡಿಮೆ)\b",
        r"\b(which|ಯಾವ)\b.{0,35}\b(subject|ವಿಷಯ)\b.{0,35}\b(attendance|ಹಾಜರಾತಿ|kammi|ಕಡಿಮೆ)\b",
        r"\b(students|ಯಾವ ವಿದ್ಯಾರ್ಥಿಗಳು)\b.{0,50}\b(below|under|ಕಡಿಮೆ)\b.{0,20}\b75\b",
        r"(ಹಾಜರಾತಿ).{0,35}(ಕಡಿಮೆ)",
        r"(ಯಾವ).{0,35}(ವಿಷಯ).{0,35}(ಹಾಜರಾತಿ|ಕಡಿಮೆ)",
    )
    add(
        "subject_attendance",
        9,
        r"\b(subject[- ]wise|per subject|each subject|subject attendance)\b",
        r"\b(attendance|ಹಾಜರಾತಿ)\b.{0,35}\b(subject|ವಿಷಯ)\b",
        r"\b(subject|ವಿಷಯ)\b.{0,35}\b(attendance|ಹಾಜರಾತಿ)\b",
        r"\b(attendance|ಹಾಜರಾತಿ)\b.{0,45}\b(assigned classes|my classes|assigned subject)\b",
        r"(ವಿಷಯ).{0,35}(ಹಾಜರಾತಿ)",
    )
    add(
        "attendance_summary",
        7,
        r"\b(attendance|ಹಾಜರಾತಿ)\b",
        r"(ಹಾಜರಾತಿ)",
        r"\b(attend|present)\b.{0,25}\b(percentage|percent|summary|eshtu|ಎಷ್ಟು)\b",
        r"\b(nanna|my)\b.{0,25}\b(attendance|ಹಾಜರಾತಿ)\b",
    )
    add(
        "student_profile",
        8,
        r"\b(my|what is my|which is my)\b.{0,30}\b(name|student id|roll number|course|semester|section)\b",
        r"\b(my profile|my student details|student profile)\b",
    )
    add(
        "assignments_summary",
        11,
        r"\b(assignments?|homework|coursework|deadlines?)\b",
    )
    add(
        "notifications_summary",
        10,
        r"\b(notifications?|announcements?|alerts?)\b",
    )
    add(
        "academic_progress",
        9,
        r"\b(academic progress|study progress|study sessions|study time|minutes studied)\b",
        r"\bhow much\b.{0,30}\b(studied|study)\b",
    )
    add(
        "assigned_subjects",
        9,
        r"\b(assigned subjects|my subjects|subjects assigned|assigned classes)\b",
        r"\b(subjects|classes)\b.{0,35}\b(assigned|nanage assign|ನನಗೆ ನೀಡಿದ)\b",
        r"\b(assigned|nanage assign|ನನಗೆ ನೀಡಿದ)\b.{0,35}\b(subjects|classes|ವಿಷಯ)\b",
        r"\b(which|what)\b.{0,30}\b(subjects|classes)\b.{0,30}\b(teaching|teach|handling)\b",
        r"\b(subjects|classes)\b.{0,30}\b(i am teaching|am i teaching|i teach)\b",
    )
    add(
        "academic_focus",
        10,
        r"\b(which|what)\b.{0,40}\b(subjects?|topics?)\b.{0,30}\b(focus|improve|prioritize|study)\b",
        r"\bwhat should i focus on\b",
    )
    add(
        "assigned_student_count",
        10,
        r"\bhow many\b.{0,30}\b(students|learners)\b.{0,40}\b(assigned|do i have|teach|in my class|in my classes)\b",
        r"\b(number|count) of (students|learners)\b.{0,40}\b(assigned|in my class|in my classes)\b",
        r"\b(nanna|my)\b.{0,25}\b(class|ತರಗತಿ)\b.{0,20}\b(eshtu|ಎಷ್ಟು)\b.{0,20}\b(students|ವಿದ್ಯಾರ್ಥಿಗಳು)\b",
    )
    add(
        "marks_summary",
        12,
        r"\b(internal marks|marks average|marks summary|scores|grades)\b",
        r"\b(marks|scores|grades)\b.{0,40}\b(each|all|every|subject|subjects)\b",
        r"\b(each|all|every)\b.{0,40}\b(subject|subjects)\b.{0,40}\b(marks|scores|grades)\b",
        r"\b(marks|ಅಂಕಗಳು)\b.{0,35}\b(average|summary|eshtu|ಎಷ್ಟು)\b",
        r"\b(average|summary)\b.{0,25}\b(marks|ಅಂಕಗಳು)\b",
        r"\b(show|list|display|what are|what is|give me)\b.{0,30}\b(my )?(internal )?marks\b",
        r"\b(my|ನನ್ನ)\b.{0,20}\b(marks|ಅಂಕಗಳು)\b",
    )
    add(
        "student_performance",
        8,
        r"\b(class|student|students)\b.{0,40}\b(performance|summary|improvement)\b",
        r"\b(performance|summary)\b.{0,40}\b(class|student|students)\b",
        r"\b(class performance|academic performance)\b",
    )
    add(
        "academic_risk",
        9,
        r"\b(risk|at[- ]risk|academic attention|need academic attention|intervention)\b",
        r"\b(students|student)\b.{0,40}\b(attention|risk|struggling)\b",
        r"\b(ಗಮನ ಬೇಕು|ಅಪಾಯದಲ್ಲಿರುವ)\b",
    )

    if not scores:
        return "general"
    order = (
        "create_complaint", "placement_preparation",
        "classroom_location", "faculty_details", "next_class", "today_timetable",
        "study_plan", "free_hours", "absent_classes", "low_attendance",
        "subject_attendance", "attendance_summary", "student_profile",
        "assignments_summary", "notifications_summary", "academic_progress",
        "assigned_subjects", "academic_focus", "assigned_student_count",
        "marks_summary", "student_performance", "academic_risk",
    )
    return max(order, key=lambda intent: scores.get(intent, 0))


def _now_kolkata(now: datetime | None = None) -> datetime:
    if now is None:
        return datetime.now(KOLKATA)
    if now.tzinfo is None:
        return now.replace(tzinfo=KOLKATA)
    return now.astimezone(KOLKATA)


def _extract_requested_day(query: str, today_name: str) -> str:
    """Compatibility helper for callers using the campus Monday-Saturday week."""
    text = _normalise_text(query)
    for day in WEEKDAYS[:-1]:
        if re.search(rf"\b{day.casefold()}\b", text):
            return day
    if re.search(r"\b(tomorrow|naale|nale|ನಾಳೆ)\b", text):
        days = list(WEEKDAYS[:-1])
        index = days.index(today_name) if today_name in days else -1
        return days[(index + 1) % len(days)]
    return today_name


def _requested_day(query: str, now: datetime, override: str | None = None) -> str:
    if override and override.title() in WEEKDAYS:
        return override.title()
    text = _normalise_text(query)
    for day in WEEKDAYS:
        if re.search(rf"\b{day.casefold()}\b", text):
            return day
    if re.search(r"\b(tomorrow|naale|nale|ನಾಳೆ)\b", text):
        return (now + timedelta(days=1)).strftime("%A")
    return now.strftime("%A")


def _clock_minutes(value: Any) -> int | None:
    if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
        return None
    hour, minute = map(int, value.split(":"))
    return hour * 60 + minute


def _format_clock(minutes: int) -> str:
    hour, minute = divmod(minutes, 60)
    return f"{hour % 12 or 12}:{minute:02d} {'AM' if hour < 12 else 'PM'}"


def _schedule_for_day(entries: list[dict], day: str) -> list[dict]:
    result = []
    for entry in entries:
        start = _clock_minutes(entry.get("start_time"))
        end = _clock_minutes(entry.get("end_time"))
        if (
            entry.get("day_of_week", "").casefold() != day.casefold()
            or start is None
            or end is None
            or end <= start
        ):
            continue
        result.append({**entry, "_start": start, "_end": end})
    return sorted(result, key=lambda item: (item["_start"], item["_end"], item.get("subject_code", "")))


def _class_label(entry: dict) -> str:
    name = str(entry.get("subject_name") or entry.get("subject_code") or "Subject not listed")
    code = str(entry.get("subject_code") or "").strip()
    return f"{name} ({code})" if code and code.casefold() not in name.casefold() else name


def _resolve_faculty(entry: dict, user: dict | None = None) -> None:
    if entry.get("faculty_name") or entry.get("teacher_name"):
        return
    faculty_id = entry.get("faculty_user_id")
    if user and faculty_id == str(user.get("_id")):
        entry["faculty_name"] = str(user.get("name") or "")
        return
    if not faculty_id:
        return
    try:
        faculty = users_collection.find_one(
            {"_id": ObjectId(str(faculty_id)), "role": "faculty"},
            {"name": 1},
        )
    except (InvalidId, TypeError):
        faculty = None
    if faculty and faculty.get("name"):
        entry["faculty_name"] = faculty["name"]


def _class_details(entry: dict, include_faculty: bool = True) -> str:
    details = [
        f"Subject: {_class_label(entry)}",
        f"Time: {_format_clock(entry['_start'])}–{_format_clock(entry['_end'])}",
    ]
    room = entry.get("room_number") or entry.get("classroom") or entry.get("room")
    details.append(f"Room: {room}" if room else "Room: classroom information is unavailable in the timetable")
    if include_faculty:
        faculty = entry.get("faculty_name") or entry.get("teacher_name")
        details.append(f"Faculty: {faculty}" if faculty else "Faculty: information is unavailable in the timetable")
    return "; ".join(details)


def _next_class(entries: list[dict], now_minutes: int) -> tuple[dict | None, list[dict], list[dict]]:
    ongoing = [entry for entry in entries if entry["_start"] <= now_minutes < entry["_end"]]
    upcoming = [entry for entry in entries if entry["_start"] > now_minutes]
    return (ongoing[0] if ongoing else (upcoming[0] if upcoming else None), ongoing, upcoming)


def _free_gaps(
    entries: list[dict],
    now_minutes: int,
    after_minutes: int | None = None,
) -> list[dict]:
    intervals: list[list[int]] = []
    for entry in entries:
        start, end = entry["_start"], entry["_end"]
        if intervals and start <= intervals[-1][1]:
            intervals[-1][1] = max(intervals[-1][1], end)
        else:
            intervals.append([start, end])

    gaps = []
    for previous, following in zip(intervals, intervals[1:]):
        start = max(previous[1], now_minutes)
        if after_minutes is not None:
            start = max(start, after_minutes)
        end = following[0]
        if end > start:
            gaps.append({
                "start": start,
                "end": end,
                "duration": end - start,
            })
    return gaps


def _has_next_class_context(history: list[dict[str, Any]] | None) -> bool:
    return any(
        turn.get("role") == "assistant"
        and turn.get("intent") in {"next_class", "classroom_location"}
        for turn in (history or [])[-8:]
    )


def _read_student_context(
    student: dict | None,
    is_demo: bool = False,
    user: dict | None = None,
) -> dict[str, Any]:
    seeded_demo_student = is_local_demo_student(student)
    seeded_demo_account = is_local_demo_account(user)
    synthetic_profile = bool(
        student
        and (student.get("is_demo") is True or student.get("synthetic_demo") is True)
        and not seeded_demo_student
    )
    demo_ownership_mismatch = bool(
        user is not None
        and student
        and seeded_demo_account != seeded_demo_student
    )
    if user is not None and student:
        account_markers = trusted_demo_owner_markers(user)
        student_markers = trusted_demo_owner_markers(student)
        marker_match = bool(
            account_markers
            and student_markers
            and account_markers & student_markers
        )
        if account_markers or student_markers:
            demo_ownership_mismatch = not marker_match
    if (
        not student
        or is_demo
        or synthetic_profile
        or demo_ownership_mismatch
    ):
        limitation = (
            "The linked student profile is marked as synthetic/demo data. "
            "Official academic records are unavailable; ask a college administrator "
            "to verify and relink your account."
            if synthetic_profile
            else (
                "The local demo account and student profile do not have matching "
                "demo ownership markers; no academic records were loaded."
                if demo_ownership_mismatch
                else "No non-synthetic linked student records are available."
            )
        )
        return {
            "linked": False,
            "student": None,
            "academic_report": None,
            "data_limitations": [limitation],
            "timetable_entries": [],
        }

    student_id = student.get("student_id")
    visibility = visible_academic_filter(user if user is not None else student)
    academic_query = {"student_id": student_id, **visibility}
    attendance = list(attendance_collection.find(academic_query, {"_id": 0}))
    attendance_entries = list(attendance_entries_collection.find(academic_query, {"_id": 0}))
    marks = list(database["marks"].find(academic_query, {"_id": 0}))
    assignments = []
    notifications = []
    progress_sessions = []
    if user is not None:
        assignments = list(assignments_collection.find(
            academic_query,
            {"_id": 0},
        ).sort("due_date", 1).limit(100))
        notifications = list(notifications_collection.find(
            academic_query,
            {"_id": 0},
        ).sort("created_at", -1).limit(20))
        if user.get("_id") is not None:
            progress_sessions = list(academic_progress_collection.find(
                {"user_id": user["_id"], "student_id": student_id},
                {"_id": 0, "user_id": 0},
            ).sort("created_at", -1).limit(100))
    report = analyze_student(student, attendance, attendance_entries, marks)
    semester = student.get("semester")
    try:
        semester = int(semester)
    except (TypeError, ValueError):
        semester = str(semester)
    timetable_query = {
        "department": student.get("department"),
        "semester": semester,
        **visibility,
    }
    if student.get("section"):
        timetable_query["$or"] = [
            {"section": student["section"]},
            {"section": {"$exists": False}},
        ]
    timetable = list(timetable_collection.find(timetable_query, {"_id": 0}))
    for entry in timetable:
        _resolve_faculty(entry)
    return {
        "linked": True,
        "role": "student",
        "student": student,
        "academic_report": report,
        "data_limitations": [
            *report["data_limitations"],
            *(
                ["DEMO DATA: synthetic sample records, not official academic records."]
                if seeded_demo_student
                else []
            ),
        ],
        "timetable_entries": timetable,
        "assignments": assignments,
        "notifications": notifications,
        "academic_progress": progress_sessions,
        "is_demo": seeded_demo_student,
    }


def _faculty_timetable(user: dict) -> list[dict]:
    user_id = str(user["_id"])
    assigned = [str(code).upper() for code in user.get("assigned_subject_codes", [])]
    query = {
        **visible_academic_filter(user),
        "$or": [
            {"faculty_user_id": user_id},
            {
                "$and": [
                    {"$or": [{"faculty_user_id": None}, {"faculty_user_id": {"$exists": False}}]},
                    {"subject_code": {"$in": assigned}},
                ]
            },
        ],
    }
    entries = list(timetable_collection.find(query, {"_id": 0}))
    for entry in entries:
        _resolve_faculty(entry, user)
    return entries


def _faculty_context(user: dict) -> dict[str, Any]:
    timetable = _faculty_timetable(user)
    subject_codes = sorted({
        str(entry.get("subject_code", "")).upper()
        for entry in timetable
        if entry.get("subject_code")
    })
    groups = {
        (entry.get("department"), entry.get("semester"))
        for entry in timetable
        if entry.get("department") is not None and entry.get("semester") is not None
    }
    authorized_ids: set[str] = set()
    if subject_codes:
        query = {"subject_code": {"$in": subject_codes}, **visible_academic_filter(user)}
        for collection in (attendance_collection, attendance_entries_collection, database["marks"]):
            authorized_ids.update(
                item["student_id"]
                for item in collection.find(query, {"student_id": 1})
                if item.get("student_id")
            )

    students = []
    reports = []
    if authorized_ids and groups:
        student_query = {
            "student_id": {"$in": sorted(authorized_ids)},
            **visible_academic_filter(user),
        }
        if is_local_demo_account(user):
            student_query["local_demo_seed"] = "smart-campus-local-demo-v1"
        for student in students_collection.find(student_query, {"_id": 0}):
            group = (student.get("department"), student.get("semester"))
            if group not in groups or (
                (student.get("is_demo") is True or student.get("synthetic_demo") is True)
                and not (is_local_demo_account(user) and is_local_demo_student(student))
            ):
                continue
            student_id = student.get("student_id")
            academic_query = {
                "student_id": student_id,
                "subject_code": {"$in": subject_codes},
                **visible_academic_filter(user),
            }
            attendance = list(attendance_collection.find(academic_query, {"_id": 0}))
            entries = list(attendance_entries_collection.find(academic_query, {"_id": 0}))
            marks = list(database["marks"].find(academic_query, {"_id": 0}))
            students.append(student)
            reports.append(analyze_student(student, attendance, entries, marks))
    return {
        "linked": True,
        "role": "faculty",
        "student": user,
        "assigned_subject_codes": sorted({
            str(code).upper() for code in user.get("assigned_subject_codes", [])
        }),
        "subject_codes": subject_codes,
        "students": students,
        "student_reports": reports,
        "data_limitations": (
            (
                ["DEMO DATA: synthetic sample records, not official academic records."]
                if is_local_demo_account(user)
                else []
            )
            if students
            else ["No academic records are available for the faculty's authorized classes."]
        ),
        "timetable_entries": timetable,
        "is_demo": is_local_demo_account(user),
    }


def _student_reply(intent: str, data: dict[str, Any], query: str, day: str, now: datetime, history: list[dict[str, Any]]) -> tuple[str, list[dict], list[str]]:
    student = data["student"]
    report = data["academic_report"]
    entries = _schedule_for_day(data["timetable_entries"], day)
    now_minutes = now.hour * 60 + now.minute
    study_plan: list[dict] = []
    recommendations: list[str] = []
    timetable_label = "demo" if data.get("is_demo") else "official"

    if intent in {"next_class", "classroom_location", "faculty_details"}:
        target, ongoing, upcoming = _next_class(entries, now_minutes)
        if target is None:
            if not entries:
                return f"No {timetable_label} timetable entries are available for {day}.", study_plan, recommendations
            return f"No upcoming classes remain on your {day} timetable.", study_plan, recommendations
        if ongoing:
            reply = f"Your current class is in progress. {_class_details(target)}."
            if upcoming:
                reply += f" Your next scheduled class is {_class_details(upcoming[0])}."
            return reply, study_plan, recommendations
        if intent == "faculty_details":
            faculty = target.get("faculty_name") or target.get("teacher_name")
            if not faculty:
                return f"Faculty information for {_class_label(target)} is unavailable in the timetable.", study_plan, recommendations
            return f"Your next class, {_class_label(target)}, is taught by {faculty}.", study_plan, recommendations
        return f"Your next class is {_class_details(target)}.", study_plan, recommendations

    if intent == "today_timetable":
        if not entries:
            return f"No {timetable_label} classes are listed for {day}.", study_plan, recommendations
        lines = [
            f"{_format_clock(item['_start'])}–{_format_clock(item['_end'])}: {_class_details(item)}"
            for item in entries
        ]
        return f"Your {timetable_label} timetable for {day}:\n" + "\n".join(lines), study_plan, recommendations

    if intent == "free_hours":
        after_reference = "after that" in _normalise_text(query) and _has_next_class_context(history)
        after = None
        next_entry, _, _ = _next_class(entries, now_minutes)
        if after_reference and next_entry is not None:
            after = next_entry["_end"]
        gaps = _free_gaps(entries, now_minutes, after)
        if not entries:
            return f"No {timetable_label} timetable entries are available for {day}, so free hours cannot be calculated.", study_plan, recommendations
        if not gaps:
            return f"No remaining free interval between scheduled classes is recorded for {day}.", study_plan, recommendations
        lines = [
            f"{_format_clock(slot['start'])}–{_format_clock(slot['end'])} ({slot['duration']} minutes)"
            for slot in gaps
        ]
        prefix = "After that class, " if after_reference and after is not None else ""
        return prefix + "recorded free intervals between classes: " + "; ".join(lines) + ".", study_plan, recommendations

    if intent in {"attendance_summary", "subject_attendance", "low_attendance", "absent_classes"}:
        attendance = report["attendance"]
        subjects = report["subjects"]
        available = [item for item in subjects if item["attendance_percentage"] is not None]
        if attendance["overall_percentage"] is None:
            return "Attendance information is unavailable because no valid attendance totals are recorded.", study_plan, recommendations
        if intent == "attendance_summary":
            absent = attendance["total_classes"] - attendance["present_classes"]
            return (
                f"Your recorded attendance is {attendance['overall_percentage']}% "
                f"({attendance['present_classes']} attended, {absent} missed, "
                f"{attendance['total_classes']} total classes).",
                study_plan,
                recommendations,
            )
        if intent == "subject_attendance":
            return "Subject-wise attendance: " + "; ".join(
                f"{item['subject_name']} ({item['subject_code']}): {item['attendance_percentage']}% "
                f"({item['present_classes']}/{item['total_classes']} attended)"
                for item in available
            ) + ".", study_plan, recommendations
        if intent == "low_attendance":
            low = [item for item in available if item["attendance_percentage"] < LOW_ATTENDANCE_THRESHOLD]
            if not low:
                return "No subject is below the 75% attendance threshold in your recorded data.", study_plan, recommendations
            return "Subjects below 75% attendance: " + "; ".join(
                f"{item['subject_name']} ({item['attendance_percentage']}%, "
                f"{item['present_classes']}/{item['total_classes']} attended)"
                for item in low
            ) + ".", study_plan, recommendations
        absent_by_subject = [
            f"{item['subject_name']}: {item['total_classes'] - item['present_classes']} missed"
            for item in available
        ]
        total_absent = attendance["total_classes"] - attendance["present_classes"]
        return f"You have {total_absent} recorded missed classes. " + "; ".join(absent_by_subject) + ".", study_plan, recommendations

    if intent == "marks_summary":
        marks = report["internal_marks"]
        if not marks["available"]:
            return "Internal marks information is unavailable; no valid assessment marks are recorded.", study_plan, recommendations
        details = [
            f"{item['subject_name']}: {item['marks_average']}%"
            for item in report["subjects"]
            if item.get("marks_average") is not None
        ]
        return (
            f"Your internal marks average is {marks['average_percentage']}% across "
            f"{marks['assessment_count']} recorded assessments. " + "; ".join(details),
            study_plan,
            recommendations,
        )

    if intent == "assigned_student_count":
        return (
            "Student roster counts for classes are not available to student accounts; "
            "I can only show your own linked academic information.",
            study_plan,
            recommendations,
        )

    if intent == "student_profile":
        profile = student
        details = [
            f"Name: {profile.get('name') or 'not recorded'}",
            f"Student ID: {profile.get('student_id') or 'not recorded'}",
            f"Course: {profile.get('course') or profile.get('department') or 'not recorded'}",
            f"Semester: {profile.get('semester') or 'not recorded'}",
        ]
        if profile.get("section"):
            details.append(f"Section: {profile['section']}")
        return "Your linked student details: " + "; ".join(details) + ".", study_plan, recommendations

    if intent == "assigned_subjects":
        subjects_by_code = {
            str(subject.get("subject_code", "")).upper(): subject.get("subject_name") or subject.get("subject_code")
            for subject in report["subjects"]
            if subject.get("subject_code")
        }
        for entry in data["timetable_entries"]:
            code = str(entry.get("subject_code", "")).upper()
            if code:
                subjects_by_code.setdefault(code, entry.get("subject_name") or code)
        if not subjects_by_code:
            return "No subject records are available for your linked account.", study_plan, recommendations
        return "Your recorded subjects: " + "; ".join(
            f"{code} ({subjects_by_code[code]})" if subjects_by_code[code] != code else code
            for code in sorted(subjects_by_code)
        ) + ".", study_plan, recommendations

    if intent == "assignments_summary":
        assignments = data["assignments"]
        if not assignments:
            return (
                "No assignment records are available for your linked account, "
                "so I cannot confirm pending assignments or deadlines.",
                study_plan,
                recommendations,
            )
        pending = [item for item in assignments if item.get("status") != "submitted"]
        if not pending:
            return (
                f"No pending assignments are recorded; all {len(assignments)} recorded assignments are submitted.",
                study_plan,
                recommendations,
            )
        details = []
        for assignment in pending[:5]:
            due_date = assignment.get("due_date")
            if isinstance(due_date, datetime):
                due_date = due_date.date().isoformat()
            details.append(
                f"{assignment.get('title') or 'Untitled assignment'} "
                f"(due {str(due_date)[:10] if due_date else 'date not recorded'})"
            )
        return (
            f"You have {len(pending)} pending of {len(assignments)} recorded assignments: "
            + "; ".join(details)
            + ".",
            study_plan,
            recommendations,
        )

    if intent == "notifications_summary":
        notifications = data["notifications"]
        if not notifications:
            return "No notifications are currently recorded for your account.", study_plan, recommendations
        summaries = [
            str(item.get("title") or item.get("message") or "Campus notification").strip()
            for item in notifications[:5]
        ]
        return (
            f"You have {len(notifications)} recent recorded notifications: "
            + "; ".join(summaries)
            + ".",
            study_plan,
            recommendations,
        )

    if intent == "academic_progress":
        sessions = data["academic_progress"]
        if not sessions:
            return "No academic progress sessions have been recorded for your account yet.", study_plan, recommendations
        subject_minutes: dict[str, int] = {}
        for session in sessions:
            subject = str(session.get("subject_name") or session.get("subject_code") or "Other")
            subject_minutes[subject] = subject_minutes.get(subject, 0) + int(
                session.get("completed_minutes", 0) or 0
            )
        total_minutes = sum(subject_minutes.values())
        summary = ", ".join(
            f"{subject}: {minutes} min"
            for subject, minutes in sorted(subject_minutes.items())
        )
        return (
            f"You have logged {total_minutes} study minutes across {len(sessions)} sessions. "
            f"By subject: {summary}.",
            study_plan,
            recommendations,
        )

    if intent == "academic_focus":
        if (
            report["attendance"]["overall_percentage"] is None
            and not report["internal_marks"]["available"]
        ):
            return "I cannot identify focus subjects because no valid attendance or marks are recorded.", study_plan, recommendations
        subjects_by_code = {
            item["subject_code"]: item["subject_name"]
            for item in report["subjects"]
            if item.get("subject_code") in report["weak_subjects"]
        }
        if not subjects_by_code:
            return "Your recorded attendance and marks do not identify a below-threshold subject to prioritize.", study_plan, recommendations
        return "Based on your recorded attendance and marks, focus on: " + ", ".join(
            subjects_by_code[code] for code in sorted(subjects_by_code)
        ) + ".", study_plan, recommendations

    if intent in {"student_performance", "academic_risk"}:
        recommendations = report["recommendations"]
        if report["risk_level"] == "insufficient_data":
            return "There is insufficient academic data to assess performance or academic risk. " + " ".join(report["data_limitations"]), study_plan, recommendations
        reasons = " ".join(report["risk_reasons"]) or "No recorded attendance or marks threshold is currently triggered."
        return (
            f"Your explainable academic status is {report['risk_level']}. {reasons}",
            study_plan,
            recommendations,
        )

    if intent == "study_plan":
        study_plan = generate_study_plan(report, data["timetable_entries"])
        if not study_plan:
            return "A personalized study plan is unavailable because valid subject attendance or marks are not recorded.", study_plan, recommendations
        recommendations = report["recommendations"]
        return "Here is a study plan based on your recorded weak subjects, attendance trend, marks, and timetable.", study_plan, recommendations

    if intent == "placement_preparation":
        return (
            "I can help with placement preparation. Tell me the target role or company, "
            "your strongest and weakest subjects, and whether you want aptitude, coding, "
            "HR, technical interview, or resume practice.",
            study_plan,
            [
                "Start with a short knowledge check.",
                "Create a focused daily practice plan.",
                "Explain solutions and mistakes, not only final answers.",
            ],
        )

    if intent == "create_complaint":
        return (
            "I can prepare a complaint for confirmation, but I need the category, title and description.",
            study_plan,
            ["Use category: academic, facilities, transport, library, safety, or other."],
        )

    return (
        f"Hi {student.get('name') or 'there'}! I can answer questions about your classes, rooms, faculty, free gaps, attendance, missed classes, marks, academic risk, and study plans. I use only your linked student records.",
        study_plan,
        recommendations,
    )


def _faculty_reply(
    intent: str,
    data: dict[str, Any],
    day: str,
    now: datetime,
    query: str,
) -> tuple[str, list[dict], list[str]]:
    entries = _schedule_for_day(data["timetable_entries"], day)
    now_minutes = now.hour * 60 + now.minute
    students = data["students"]
    reports = data["student_reports"]
    subjects = data["subject_codes"]

    if intent in {"next_class", "classroom_location", "faculty_details"}:
        target, ongoing, upcoming = _next_class(entries, now_minutes)
        if target is None:
            if not entries:
                return f"No official classes are listed for your authorized schedule on {day}.", [], []
            return f"No upcoming classes remain on your {day} timetable.", [], []
        if ongoing:
            reply = f"Your current class is in progress. {_class_details(target)}."
            if upcoming:
                reply += f" Your next scheduled class is {_class_details(upcoming[0])}."
            return reply, [], []
        return f"Your next class is {_class_details(target)}.", [], []

    if intent == "today_timetable":
        if not entries:
            return f"No official classes are listed for your authorized schedule on {day}.", [], []
        return "Your authorized timetable for " + day + ":\n" + "\n".join(
            _class_details(item) for item in entries
        ), [], []

    if intent == "free_hours":
        gaps = _free_gaps(entries, now_minutes)
        if not entries:
            return f"No official timetable entries are available for your authorized classes on {day}.", [], []
        if not gaps:
            return f"No remaining free interval between your scheduled classes is recorded for {day}.", [], []
        return "Recorded free intervals between your classes: " + "; ".join(
            f"{_format_clock(slot['start'])}–{_format_clock(slot['end'])} ({slot['duration']} minutes)"
            for slot in gaps
        ) + ".", [], []

    if intent == "assigned_subjects":
        by_code = {str(item.get("subject_code", "")).upper(): item for item in data["timetable_entries"]}
        all_codes = sorted(set(data["assigned_subject_codes"]) | set(subjects))
        if not all_codes:
            return "No subjects are assigned to your faculty account.", [], []
        return "Your assigned subjects: " + "; ".join(
            f"{code} ({by_code[code].get('subject_name')})"
            if code in by_code and by_code[code].get("subject_name")
            else code
            for code in all_codes
        ) + ".", [], []

    if intent == "assigned_student_count":
        if not students:
            return "No students with academic records are available in your authorized classes.", [], []
        return (
            f"{len(students)} student(s) have academic records in your authorized classes.",
            [],
            [],
        )

    if intent == "attendance_summary":
        attendance_values = [
            report["attendance"]["overall_percentage"]
            for report in reports
            if report["attendance"]["overall_percentage"] is not None
        ]
        if not attendance_values:
            return "Attendance data is unavailable for your authorized classes.", [], []
        return (
            f"Recorded attendance summary for {len(attendance_values)} authorized students: "
            f"{round(sum(attendance_values) / len(attendance_values), 2)}% mean attendance.",
            [],
            [],
        )

    if intent in {"low_attendance", "subject_attendance", "absent_classes"}:
        requested_codes = {
            code.upper()
            for code in re.findall(
                r"\b[a-z][a-z0-9_-]*\d[a-z0-9_-]*\b",
                _normalise_text(query),
            )
        }
        authorized_codes = {str(code).upper() for code in subjects}
        unauthorized_codes = requested_codes - authorized_codes
        if unauthorized_codes:
            requested_code = sorted(unauthorized_codes)[0]
            return f"Subject {requested_code} is not in your authorized subject scope.", [], []

        rows = []
        for student, report in zip(students, reports):
            for subject in report["subjects"]:
                if requested_codes and str(subject.get("subject_code", "")).upper() not in requested_codes:
                    continue
                percentage = subject.get("attendance_percentage")
                if percentage is None:
                    continue
                if intent == "low_attendance" and percentage >= LOW_ATTENDANCE_THRESHOLD:
                    continue
                missed = subject["total_classes"] - subject["present_classes"]
                rows.append(
                    f"{student.get('name') or student.get('student_id')} — "
                    f"{subject['subject_name']} ({percentage}%, {missed} missed)"
                )
        if not rows:
            if not students:
                return "No attendance records are available for your authorized classes.", [], []
            return "No authorized student has a recorded subject below the 75% threshold.", [], []
        label = "Attendance below 75%" if intent == "low_attendance" else "Authorized subject attendance"
        if intent == "absent_classes":
            label = "Recorded absences in your authorized classes"
        return label + ":\n" + "\n".join(rows), [], []

    if intent == "marks_summary":
        values = [
            (subject["marks_average"], subject["subject_name"])
            for report in reports
            for subject in report["subjects"]
            if subject.get("marks_average") is not None
        ]
        if not values:
            return "Internal marks are unavailable for your authorized classes.", [], []
        average = round(sum(value for value, _ in values) / len(values), 2)
        return f"Recorded class internal-marks average: {average}% across {len(values)} student-subject averages.", [], []

    if intent in {"academic_risk", "student_performance"}:
        if not students:
            return "No authorized student academic records are available for a class performance summary.", [], []
        by_risk: dict[str, int] = {}
        for report in reports:
            risk = report["risk_level"]
            by_risk[risk] = by_risk.get(risk, 0) + 1
        attendance_values = [
            report["attendance"]["overall_percentage"]
            for report in reports
            if report["attendance"]["overall_percentage"] is not None
        ]
        marks_values = [
            report["internal_marks"]["average_percentage"]
            for report in reports
            if report["internal_marks"]["available"]
        ]
        if intent == "academic_risk":
            attention = [
                f"{student.get('name') or student.get('student_id')} ({report['risk_level']})"
                for student, report in zip(students, reports)
                if report["risk_level"] in {"high", "medium"}
            ]
            if not attention:
                return "No authorized student currently meets the recorded high- or medium-risk thresholds.", [], []
            return "Students needing academic attention based on recorded indicators: " + "; ".join(attention) + ".", [], []
        summary = (
            f"Authorized class summary: {len(students)} students; "
            f"{len(attendance_values)} with attendance data"
        )
        if attendance_values:
            summary += f" (mean {round(sum(attendance_values) / len(attendance_values), 2)}%)"
        summary += f"; {len(marks_values)} with marks data"
        if marks_values:
            summary += f" (mean {round(sum(marks_values) / len(marks_values), 2)}%)"
        summary += "; risk categories " + ", ".join(
            f"{risk}: {count}" for risk, count in sorted(by_risk.items())
        ) + "."
        return summary, [], []

    return (
        "I can answer about your assigned timetable and subjects, free gaps, authorized attendance, low-attendance students, marks, and class performance.",
        [],
        [],
    )


def process_assistant_query(
    query: str,
    student: dict | None = None,
    day_override: str | None = None,
    is_demo: bool = False,
    *,
    user: dict | None = None,
    history: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Answers an authenticated user's campus questions from live authorized records."""
    current = _now_kolkata(now)
    day = _requested_day(query, current, day_override)
    history = (history or [])[-8:]
    role = (user or {}).get("role", "student")
    intent = detect_intent(query, history)

    if role == "faculty":
        context = _faculty_context(user or {})
        reply, plan, recommendations = _faculty_reply(intent, context, day, current, query)
        day_count = len(_schedule_for_day(context["timetable_entries"], day))
        data_summary = {
            "linked": True,
            "student_name": (user or {}).get("name"),
            "overall_attendance": None,
            "low_attendance_count": sum(
                report["risk_level"] in {"high", "medium"}
                for report in context["student_reports"]
            ),
            "total_classes_day": day_count,
            "is_demo": context.get("is_demo", False),
        }
        limitations = context["data_limitations"]
        suggestions = FACULTY_SUGGESTIONS
    else:
        context = _read_student_context(student, is_demo=is_demo, user=user)
        if context["linked"]:
            reply, plan, recommendations = _student_reply(
                intent, context, query, day, current, history,
            )
            report = context["academic_report"]
            data_summary = {
                "linked": True,
                "student_name": student.get("name"),
                "overall_attendance": report["attendance"]["overall_percentage"],
                "low_attendance_count": len([
                    subject for subject in report["subjects"]
                    if subject["attendance_percentage"] is not None
                    and subject["attendance_percentage"] < LOW_ATTENDANCE_THRESHOLD
                ]),
                "total_classes_day": len(_schedule_for_day(context["timetable_entries"], day)),
                "is_demo": context.get("is_demo", False),
            }
        else:
            reply = (
                "Your account is not linked to an official student record, so I cannot access personal campus information."
            )
            plan, recommendations = [], []
            data_summary = {
                "linked": False,
                "student_name": None,
                "overall_attendance": None,
                "low_attendance_count": 0,
                "total_classes_day": 0,
                "is_demo": False,
            }
        limitations = context["data_limitations"]
        suggestions = STUDENT_SUGGESTIONS

    return {
        "reply": reply,
        "intent": intent,
        "provider": "grounded_rule_engine",
        "day": day,
        "data_summary": data_summary,
        "suggestions": suggestions,
        "study_plan": plan,
        "recommendations": recommendations,
        "data_limitations": limitations,
        "disclaimer": (
            "Factual campus answers use authorized database records; unavailable information is not inferred."
            + (
                " The records shown are synthetic demo data, not official academic records."
                if data_summary["is_demo"]
                else ""
            )
        ),
    }
