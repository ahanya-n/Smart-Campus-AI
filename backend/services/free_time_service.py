"""Smart Free-Time Finder service.
Calculates free periods strictly BETWEEN scheduled classes on a given day.
Merges overlapping and consecutive class slots.
Never counts time before the first class or after the last class as
a free period between classes unless explicitly requested.
"""

from typing import Any


def time_to_minutes(time_str: str) -> int:
    """Converts HH:MM string to minutes since midnight."""
    parts = time_str.strip().split(":")
    return int(parts[0]) * 60 + int(parts[1])


def minutes_to_time(minutes: int) -> str:
    """Converts minutes since midnight to HH:MM string."""
    h = minutes // 60
    m = minutes % 60
    return f"{h:02d}:{m:02d}"


def format_duration(minutes: int) -> str:
    """Formats duration in minutes to human-readable string."""
    if minutes <= 0:
        return "0 mins"
    hours = minutes // 60
    mins = minutes % 60
    if hours > 0 and mins > 0:
        return f"{hours} hr {mins} mins" if hours == 1 else f"{hours} hrs {mins} mins"
    if hours > 0:
        return f"{hours} hr" if hours == 1 else f"{hours} hrs"
    return f"{mins} mins"


def calculate_free_time(entries: list[dict[str, Any]], day: str) -> dict[str, Any]:
    """Calculates free intervals strictly between classes for a specific day.

    Args:
        entries: list of timetable entries containing start_time, end_time, day_of_week
        day: day name, e.g. "Monday"

    Returns:
        Structured breakdown with busy_slots, free_slots, total_free_minutes, best_slot.
    """
    day_entries = [e for e in entries if e.get("day_of_week", "").lower() == day.lower()]

    if not day_entries:
        return {
            "day": day,
            "total_classes": 0,
            "data_complete": True,
            "busy_slots": [],
            "free_slots": [],
            "total_free_minutes": 0,
            "best_slot": None,
            "message": f"No classes scheduled on {day}.",
        }

    # Extract time intervals in minutes and sort
    intervals: list[tuple[int, int, str, str]] = []
    for entry in day_entries:
        try:
            start_m = time_to_minutes(entry["start_time"])
            end_m = time_to_minutes(entry["end_time"])
        except (KeyError, TypeError, ValueError):
            start_m = end_m = 0
        if end_m <= start_m:
            return {
                "day": day,
                "total_classes": len(day_entries),
                "data_complete": False,
                "busy_slots": [],
                "free_slots": [],
                "total_free_minutes": 0,
                "total_free_display": "0 mins",
                "best_slot": None,
                "message": f"Class times in your timetable for {day} are incomplete or invalid, so free time cannot be calculated reliably.",
            }
        intervals.append((start_m, end_m, entry.get("subject_code", ""), entry.get("subject_name", "")))

    intervals.sort(key=lambda x: (x[0], x[1]))

    # Merge overlapping or contiguous intervals
    merged_busy: list[dict[str, Any]] = []
    current_start = intervals[0][0]
    current_end = intervals[0][1]

    for next_start, next_end, _, _ in intervals[1:]:
        if next_start <= current_end:
            # Overlapping or contiguous; merge
            current_end = max(current_end, next_end)
        else:
            # Non-overlapping; record previous and start new
            merged_busy.append({
                "start_time": minutes_to_time(current_start),
                "end_time": minutes_to_time(current_end),
                "duration_minutes": current_end - current_start,
                "duration_display": format_duration(current_end - current_start),
            })
            current_start = next_start
            current_end = next_end

    merged_busy.append({
        "start_time": minutes_to_time(current_start),
        "end_time": minutes_to_time(current_end),
        "duration_minutes": current_end - current_start,
        "duration_display": format_duration(current_end - current_start),
    })

    # Free time intervals strictly BETWEEN the merged busy blocks
    free_slots: list[dict[str, Any]] = []
    total_free_minutes = 0

    for i in range(len(merged_busy) - 1):
        gap_start_m = time_to_minutes(merged_busy[i]["end_time"])
        gap_end_m = time_to_minutes(merged_busy[i + 1]["start_time"])
        gap_minutes = gap_end_m - gap_start_m

        if gap_minutes > 0:
            slot = {
                "start_time": minutes_to_time(gap_start_m),
                "end_time": minutes_to_time(gap_end_m),
                "duration_minutes": gap_minutes,
                "duration_display": format_duration(gap_minutes),
                "slot_label": f"{minutes_to_time(gap_start_m)} - {minutes_to_time(gap_end_m)}",
            }
            free_slots.append(slot)
            total_free_minutes += gap_minutes

    # Identify best (longest) free slot
    best_slot = max(free_slots, key=lambda s: s["duration_minutes"]) if free_slots else None

    # Human-readable summary
    if len(day_entries) == 1:
        summary_msg = f"You have 1 class scheduled on {day}. No gap between classes."
    elif not free_slots:
        summary_msg = f"You have {len(day_entries)} consecutive classes on {day} with no free time in between."
    else:
        summary_msg = (
            f"You have {format_duration(total_free_minutes)} of free time between classes on {day} "
            f"across {len(free_slots)} slot(s)."
        )

    return {
        "day": day,
        "total_classes": len(day_entries),
        "data_complete": True,
        "busy_slots": merged_busy,
        "free_slots": free_slots,
        "total_free_minutes": total_free_minutes,
        "total_free_display": format_duration(total_free_minutes),
        "best_slot": best_slot,
        "message": summary_msg,
    }
