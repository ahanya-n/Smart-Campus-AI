from collections import defaultdict
from datetime import date, datetime, timedelta
import math
from typing import Any

from services.free_time_service import calculate_free_time


ATTENDANCE_THRESHOLD = 75.0
HIGH_ATTENDANCE_THRESHOLD = 60.0
MARKS_THRESHOLD = 60.0
HIGH_MARKS_THRESHOLD = 40.0


def _percentage(present: int, total: int) -> float | None:
    if total <= 0:
        return None
    return round(present / total * 100, 2)


def _validated_count(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number) or number < 0 or not number.is_integer():
        return None
    return int(number)


def _validated_mark(mark: dict) -> tuple[str, float] | None:
    subject_code = str(mark.get("subject_code", "")).strip().upper()
    if isinstance(mark.get("score"), bool) or isinstance(mark.get("max_score"), bool):
        return None
    try:
        score = float(mark["score"])
        maximum = float(mark["max_score"])
    except (KeyError, TypeError, ValueError, OverflowError):
        return None
    if (
        not subject_code
        or not math.isfinite(score)
        or not math.isfinite(maximum)
        or maximum <= 0
        or score < 0
        or score > maximum
    ):
        return None
    assessment_date = mark.get("assessment_date")
    if assessment_date is not None:
        try:
            if date.fromisoformat(str(assessment_date)) > date.today():
                return None
        except (TypeError, ValueError):
            return None
    return subject_code, score / maximum * 100


def _attendance_trend(entries: list[dict]) -> dict[str, Any]:
    dated = []
    seen = set()
    invalid_count = 0
    for entry in entries:
        try:
            session_date = date.fromisoformat(str(entry["session_date"]))
            status = entry.get("status")
            subject_code = str(entry.get("subject_code", "")).strip().upper()
            start_time = str(entry.get("start_time", ""))
            valid_time = datetime.strptime(start_time, "%H:%M").strftime("%H:%M") == start_time
            if (
                status not in ("present", "absent")
                or not subject_code
                or not valid_time
                or session_date > date.today()
            ):
                raise ValueError("invalid attendance status")
            identity = (
                subject_code,
                session_date,
                start_time,
            )
            if identity in seen:
                continue
            seen.add(identity)
            dated.append((session_date, status))
        except (KeyError, TypeError, ValueError):
            invalid_count += 1

    dated.sort(key=lambda item: item[0])
    if len(dated) < 4:
        return {
            "direction": "insufficient_data",
            "recent_percentage": None,
            "previous_percentage": None,
            "sessions_analyzed": len(dated),
            "invalid_sessions_ignored": invalid_count,
            "message": "At least four valid, unique attendance sessions are needed to compare recent periods.",
        }

    midpoint = len(dated) // 2
    previous = dated[:midpoint]
    recent = dated[midpoint:]
    previous_rate = _percentage(
        sum(status == "present" for _, status in previous),
        len(previous),
    )
    recent_rate = _percentage(
        sum(status == "present" for _, status in recent),
        len(recent),
    )
    delta = recent_rate - previous_rate
    direction = "declining" if delta <= -10 else "improving" if delta >= 10 else "stable"
    return {
        "direction": direction,
        "recent_percentage": recent_rate,
        "previous_percentage": previous_rate,
        "sessions_analyzed": len(dated),
        "invalid_sessions_ignored": invalid_count,
        "message": f"Recent attendance changed by {delta:+.2f} percentage points across recorded sessions.",
    }


def analyze_student(
    student: dict,
    attendance_docs: list[dict],
    attendance_entries: list[dict],
    marks: list[dict] | None = None,
) -> dict[str, Any]:
    marks = marks or []
    subject_rows = []
    subjects_by_code = {}
    total_classes = 0
    present_classes = 0
    reasons = []
    weak_subjects = []
    normalized_marks = []
    invalid_attendance_count = 0
    invalid_mark_count = 0

    for record in attendance_docs:
        total = _validated_count(record.get("total_classes"))
        present = _validated_count(record.get("present_classes"))
        if total is None or present is None or present > total:
            invalid_attendance_count += 1
            continue
        subject_code = str(record.get("subject_code", "")).strip().upper()
        if not subject_code:
            invalid_attendance_count += 1
            continue
        percentage = _percentage(present, total)
        subject = subjects_by_code.get(subject_code)
        if subject is None:
            subject = {
                "subject_code": subject_code,
                "subject_name": str(record.get("subject_name") or subject_code),
                "attendance_percentage": None,
                "present_classes": 0,
                "total_classes": 0,
                "marks_average": None,
                "marks_available": False,
            }
            subjects_by_code[subject_code] = subject
            subject_rows.append(subject)
        subject["present_classes"] += present
        subject["total_classes"] += total
        subject["attendance_percentage"] = _percentage(
            subject["present_classes"],
            subject["total_classes"],
        )
        total_classes += total
        present_classes += present

    overall = _percentage(present_classes, total_classes)

    for mark in marks:
        validated = _validated_mark(mark)
        if validated is None:
            invalid_mark_count += 1
            continue
        subject_code, percentage = validated
        normalized_marks.append((subject_code, percentage, mark))

    marks_by_subject: dict[str, list[float]] = defaultdict(list)
    mark_subject_names: dict[str, str] = {}
    for subject_code, percentage, mark in normalized_marks:
        marks_by_subject[subject_code].append(percentage)
        mark_subject_names.setdefault(
            subject_code,
            str(mark.get("subject_name") or subject_code),
        )

    for subject_code, scores in marks_by_subject.items():
        subject = subjects_by_code.get(subject_code)
        if subject is None:
            subject = {
                "subject_code": subject_code,
                "subject_name": mark_subject_names[subject_code],
                "attendance_percentage": None,
                "present_classes": 0,
                "total_classes": 0,
                "marks_average": None,
                "marks_available": False,
            }
            subjects_by_code[subject_code] = subject
            subject_rows.append(subject)
        subject["marks_average"] = round(sum(scores) / len(scores), 2)
        subject["marks_available"] = True

    for subject in subject_rows:
        attendance_pct = subject["attendance_percentage"]
        marks_pct = subject["marks_average"]
        attendance_weak = attendance_pct is not None and attendance_pct < ATTENDANCE_THRESHOLD
        marks_weak = marks_pct is not None and marks_pct < MARKS_THRESHOLD
        if attendance_weak or marks_weak:
            weak_subjects.append(subject["subject_code"])
        if attendance_weak:
            reasons.append(
                f"{subject['subject_name']} attendance is {attendance_pct:.2f}% "
                f"({subject['present_classes']}/{subject['total_classes']} classes), "
                f"below the {ATTENDANCE_THRESHOLD:.0f}% threshold."
            )
        if attendance_pct is not None and attendance_pct < HIGH_ATTENDANCE_THRESHOLD:
            reasons.append(
                f"{subject['subject_name']} attendance is below {HIGH_ATTENDANCE_THRESHOLD:.0f}%, "
                "a high-priority attendance warning."
            )
        if marks_weak:
            reasons.append(
                f"{subject['subject_name']} internal marks average is {marks_pct:.2f}%, "
                f"below the {MARKS_THRESHOLD:.0f}% threshold."
            )
        if marks_pct is not None and marks_pct < HIGH_MARKS_THRESHOLD:
            reasons.append(
                f"{subject['subject_name']} internal marks average is below "
                f"{HIGH_MARKS_THRESHOLD:.0f}%, a high-priority academic warning."
            )

    if overall is None:
        reasons.append("No valid official attendance totals are available.")
    elif overall < ATTENDANCE_THRESHOLD:
        reasons.append(
            f"Overall attendance is {overall:.2f}% "
            f"({present_classes}/{total_classes} classes), below the {ATTENDANCE_THRESHOLD:.0f}% threshold."
        )
    if overall is not None and overall < HIGH_ATTENDANCE_THRESHOLD:
        reasons.append(f"Overall attendance is below {HIGH_ATTENDANCE_THRESHOLD:.0f}%, a high-priority warning.")

    trend = _attendance_trend(attendance_entries)
    if trend["direction"] == "declining":
        reasons.append(
            f"Recent attendance declined from {trend['previous_percentage']:.2f}% "
            f"to {trend['recent_percentage']:.2f}% across {trend['sessions_analyzed']} valid sessions."
        )

    attendance_high = (
        overall is not None and overall < HIGH_ATTENDANCE_THRESHOLD
    ) or any(
        row["attendance_percentage"] is not None
        and row["attendance_percentage"] < HIGH_ATTENDANCE_THRESHOLD
        for row in subject_rows
    )
    marks_high = any(
        score < HIGH_MARKS_THRESHOLD for _, score, _ in normalized_marks
    )
    if attendance_high or marks_high:
        risk = "high"
    elif (
        (overall is not None and overall < ATTENDANCE_THRESHOLD)
        or any(
            row["attendance_percentage"] is not None
            and row["attendance_percentage"] < ATTENDANCE_THRESHOLD
            for row in subject_rows
        )
        or any(score < MARKS_THRESHOLD for _, score, _ in normalized_marks)
        or trend["direction"] == "declining"
    ):
        risk = "medium"
    elif overall is not None or normalized_marks:
        risk = "low"
    else:
        risk = "insufficient_data"

    if risk == "low":
        indicators = []
        if overall is not None:
            indicators.append(f"overall attendance {overall:.2f}%")
        if normalized_marks:
            marks_average = sum(score for _, score, _ in normalized_marks) / len(normalized_marks)
            indicators.append(f"internal marks average {marks_average:.2f}%")
        reasons.append(
            "No configured risk threshold was crossed by valid indicators"
            + (f" ({', '.join(indicators)})" if indicators else "")
            + f"; attendance trend status is {trend['direction']}."
        )
    elif risk == "insufficient_data":
        reasons.append(
            "Insufficient data: no valid attendance totals or internal marks are available to classify risk."
        )

    recommendations = []
    if overall is None:
        recommendations.append(
            "Ask faculty to confirm that valid attendance totals have been recorded."
        )
    elif overall < ATTENDANCE_THRESHOLD:
        recommendations.append(
            f"Attend upcoming classes for the subjects below threshold; current overall attendance is "
            f"{overall:.2f}% ({present_classes}/{total_classes}). Confirm shortage requirements with faculty."
        )
    for subject in subject_rows:
        attendance_pct = subject["attendance_percentage"]
        marks_pct = subject["marks_average"]
        if attendance_pct is not None and attendance_pct < ATTENDANCE_THRESHOLD:
            recommendations.append(
                f"Prioritize attending {subject['subject_name']} classes "
                f"({attendance_pct:.2f}%, {subject['present_classes']}/{subject['total_classes']} attended) "
                "and discuss the shortage with its faculty."
            )
        if marks_pct is not None and marks_pct < MARKS_THRESHOLD:
            recommendations.append(
                f"Review the recorded assessments for {subject['subject_name']} "
                f"(average {marks_pct:.2f}%) and ask its faculty to clarify missed concepts."
            )
    if trend["direction"] == "declining":
        recommendations.append(
            "Discuss the measured attendance decline with your faculty mentor and review the next sessions."
        )
    if not normalized_marks:
        recommendations.append(
            "No valid internal marks are available; marks-based analysis and planning are limited."
        )
    if invalid_attendance_count or invalid_mark_count or trend["invalid_sessions_ignored"]:
        recommendations.append(
            "Ask the relevant faculty to correct invalid academic records before relying on this report."
        )
    if risk == "low" and not weak_subjects:
        recommendations.append(
            "No recorded subject is below the current thresholds; review your subject progress after the next assessment."
        )
    recommendations = list(dict.fromkeys(recommendations))

    return {
        "student": {
            "student_id": str(student.get("student_id", "")),
            "name": str(student.get("name", "")),
            "department": str(student.get("department", "")),
            "semester": student.get("semester"),
            "section": student.get("section"),
        },
        "risk_level": risk,
        "classification_type": "explainable_rule_based_baseline",
        "risk_reasons": list(dict.fromkeys(reasons)),
        "attendance": {
            "overall_percentage": overall,
            "present_classes": present_classes,
            "total_classes": total_classes,
            "subject_count": sum(row["total_classes"] > 0 for row in subject_rows),
            "below_threshold_subject_count": sum(
                row["attendance_percentage"] is not None
                and row["attendance_percentage"] < ATTENDANCE_THRESHOLD
                for row in subject_rows
            ),
        },
        "attendance_trend": trend,
        "subjects": subject_rows,
        "weak_subjects": sorted(set(weak_subjects)),
        "internal_marks": {
            "available": bool(normalized_marks),
            "assessment_count": len(normalized_marks),
            "average_percentage": (
                round(sum(score for _, score, _ in normalized_marks) / len(normalized_marks), 2)
                if normalized_marks
                else None
            ),
        },
        "data_quality": {
            "invalid_attendance_records": invalid_attendance_count,
            "invalid_attendance_sessions": trend["invalid_sessions_ignored"],
            "invalid_mark_records": invalid_mark_count,
        },
        "data_limitations": [
            item
            for item, missing in (
                ("No valid internal exam marks are available.", not normalized_marks),
                ("No valid attendance totals are available.", overall is None),
                ("Assignment completion data is unavailable.", True),
                ("Longitudinal prior academic performance is unavailable.", True),
                ("Assessment dates and syllabus information are unavailable.", True),
                ("Section information is unavailable for this student.", not student.get("section")),
            )
            if missing
        ],
        "recommendations": recommendations,
        "generated_at": datetime.now().astimezone().isoformat(),
    }


def generate_study_plan(
    report: dict,
    timetable_entries: list[dict] | None = None,
) -> list[dict[str, Any]]:
    timetable_entries = timetable_entries or []
    subjects = [
        subject for subject in report.get("subjects", [])
        if subject.get("attendance_percentage") is not None or subject.get("marks_available")
    ]
    if not subjects:
        return []

    weak_codes = set(report.get("weak_subjects", []))
    focused = [subject for subject in subjects if subject["subject_code"] in weak_codes]
    candidates = focused or subjects
    trend = report.get("attendance_trend", {})
    plan = []
    today = date.today()
    for offset in range(7):
        current_day = today + timedelta(days=offset)
        subject = candidates[offset % len(candidates)]
        attendance_pct = subject.get("attendance_percentage")
        marks_pct = subject.get("marks_average")
        actions = []
        if attendance_pct is not None and attendance_pct < ATTENDANCE_THRESHOLD:
            actions.append(
                f"Attend the next {subject['subject_name']} class; current attendance is "
                f"{attendance_pct:.2f}% ({subject['present_classes']}/{subject['total_classes']})."
            )
        if marks_pct is not None and marks_pct < MARKS_THRESHOLD:
            actions.append(
                f"Review the concepts covered by the recorded {subject['subject_name']} assessments "
                f"(average {marks_pct:.2f}%) and note questions for faculty."
            )
        if trend.get("direction") == "declining":
            actions.append(
                f"Check your next {subject['subject_name']} attendance entry against the recent declining trend."
            )
        if not actions:
            actions.append(
                f"Review current material for {subject['subject_name']} and revisit progress after its next recorded assessment."
            )

        free_time = calculate_free_time(timetable_entries, current_day.strftime("%A"))
        best_slot = free_time.get("best_slot") if free_time.get("data_complete", True) else None
        plan.append({
            "day": current_day.strftime("%A"),
            "subject": subject["subject_name"],
            "activity": " ".join(actions),
            "time_window": (
                f"{best_slot['start_time']} - {best_slot['end_time']}"
                if best_slot
                else None
            ),
        })
    return plan


def academic_mentor_response(
    message: str,
    report: dict,
    timetable_entries: list[dict] | None = None,
) -> dict[str, Any]:
    query = message.casefold()
    attendance = report["attendance"]
    percentage = attendance["overall_percentage"]
    subjects = report["subjects"]
    weak_codes = set(report["weak_subjects"])
    weak_subjects = [subject for subject in subjects if subject["subject_code"] in weak_codes]
    plan = []

    if any(term in query for term in ("7-day", "7 day", "study plan", "study schedule", "study")):
        plan = generate_study_plan(report, timetable_entries)
        reply = (
            "This plan prioritizes your recorded subject-level attendance, marks, and attendance trend."
            if plan
            else "A subject-specific study plan cannot be generated because valid subject performance records are unavailable."
        )
        intent = "study_plan"
    elif any(term in query for term in ("attendance", "attend")):
        if percentage is None:
            reply = "Insufficient data: no valid official attendance totals are available."
        else:
            reply = (
                f"Your recorded attendance is {percentage}% "
                f"({attendance['present_classes']} of {attendance['total_classes']} classes)."
            )
            low_subjects = [
                subject for subject in subjects
                if subject["attendance_percentage"] is not None
                and subject["attendance_percentage"] < ATTENDANCE_THRESHOLD
            ]
            if low_subjects:
                reply += " Below-threshold subjects: " + ", ".join(
                    f"{subject['subject_name']} ({subject['attendance_percentage']}%)"
                    for subject in low_subjects
                ) + "."
        intent = (
            "low_attendance"
            if any(term in query for term in ("low attendance", "shortage", "which subject"))
            else "attendance"
        )
    elif any(term in query for term in ("before exams", "exam preparation", "prepare for exams")) or (
        "exam" in query and any(term in query for term in ("focus", "prepare", "study"))
    ):
        if weak_subjects:
            reply = "Prioritize these recorded weak subjects: " + ", ".join(
                f"{subject['subject_name']} ({subject['subject_code']})"
                for subject in weak_subjects
            ) + ". Their attendance and marks reasons are listed in your report."
        elif subjects:
            reply = "No recorded subject is below the available attendance and marks thresholds."
        else:
            reply = "Insufficient data: no valid subject-level records are available to prioritize exam preparation."
        intent = "exam_preparation"
    elif any(term in query for term in ("gpa", "cgpa")):
        reply = "GPA/CGPA records are not available in the linked academic data; I cannot calculate or infer them."
        intent = "marks_guidance"
    elif any(term in query for term in ("mark", "score", "grade", "exam", "internal", "average")):
        marks = report["internal_marks"]
        if not marks["available"]:
            reply = "Insufficient data: valid internal assessment marks are not available in your linked records."
        else:
            breakdown = [
                f"{subject['subject_name']} {subject['marks_average']:.2f}%"
                for subject in subjects if subject["marks_average"] is not None
            ]
            reply = (
                f"Your valid internal assessment average is {marks['average_percentage']:.2f}% "
                f"across {marks['assessment_count']} recorded assessments."
                + (" Subject averages: " + ", ".join(breakdown) + "." if breakdown else "")
            )
        intent = "marks_guidance"
    elif any(term in query for term in ("subject", "improv", "weak", "focus")):
        if weak_subjects:
            reply = "Based on recorded indicators, focus on: " + ", ".join(
                f"{subject['subject_name']} ({subject['subject_code']})"
                for subject in weak_subjects
            ) + ". See the report for the specific attendance or marks reasons."
        else:
            reply = (
                "No subject is below the available attendance and marks thresholds."
                if subjects
                else "Insufficient data: no valid subject-level attendance or marks are available."
            )
        intent = "subject_guidance"
    else:
        reasons = report["risk_reasons"]
        reply = (
            f"Your explainable rule-based academic status is {report['risk_level'].replace('_', ' ')}. "
            + " ".join(reasons)
        )
        intent = "academic_summary"

    return {
        "reply": reply,
        "intent": intent,
        "study_plan": plan,
        "recommendations": report["recommendations"],
        "data_limitations": list(dict.fromkeys([
            *report["data_limitations"],
            *(
                ["Timetable data is unavailable for scheduling study blocks."]
                if intent == "study_plan" and not timetable_entries
                else []
            ),
        ])),
        "report": report,
        "disclaimer": "Educational guidance only. These indicators are rule-based, not a trained or guaranteed prediction.",
    }
