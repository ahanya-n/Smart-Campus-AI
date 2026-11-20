"""Adds clearly-labelled DEMO attendance and timetable records for student MCA001.

Safe to run any number of times:
- Uses upserts with $setOnInsert, so existing records are never changed or duplicated.
- Never touches the users or students collections (students are only read).
- Every inserted document has is_demo: true and a demo_note.

Run from the backend folder:
    .venv\\Scripts\\python.exe seed_demo_data.py
"""

from database import (
    attendance_collection,
    ensure_indexes,
    students_collection,
    timetable_collection,
)
from dependencies.student import DEMO_STUDENT_ID
from routes.attendance_routes import AttendanceInput, build_attendance_document
from routes.timetable_routes import TimetableInput, build_timetable_document

DEMO_NOTE = "DEMO DATA - illustrative sample for demonstration, not official college records"

# (subject_code, subject_name, total_classes, present_classes)
DEMO_ATTENDANCE = [
    ("MCA401", "Advanced Java Programming", 42, 38),
    ("MCA402", "Machine Learning", 40, 33),
    ("MCA403", "Cloud Computing", 36, 26),
    ("MCA404", "Mobile Application Development", 38, 34),
    ("MCA405", "Software Project Management", 30, 21),
    ("MCA406", "Data Science Lab", 24, 22),
]

SUBJECTS = {code: name for code, name, _, _ in DEMO_ATTENDANCE}

FACULTY = {
    "MCA401": "Dr. Ananya Rao",
    "MCA402": "Prof. Karthik Menon",
    "MCA403": "Dr. Priya Sharma",
    "MCA404": "Prof. Suresh Kumar",
    "MCA405": "Dr. Meera Iyer",
    "MCA406": "Prof. Karthik Menon",
}

ROOMS = {
    "MCA401": "MCA-201",
    "MCA402": "MCA-202",
    "MCA403": "MCA-201",
    "MCA404": "Lab-2",
    "MCA405": "MCA-203",
    "MCA406": "Lab-3",
}

# (day, start, end, subject_code)
DEMO_TIMETABLE = [
    ("Monday", "09:00", "10:00", "MCA401"),
    ("Monday", "10:00", "11:00", "MCA402"),
    ("Monday", "11:15", "12:15", "MCA403"),
    ("Monday", "13:30", "14:30", "MCA405"),
    ("Tuesday", "09:00", "10:00", "MCA402"),
    ("Tuesday", "10:00", "11:00", "MCA404"),
    ("Tuesday", "11:15", "12:15", "MCA401"),
    ("Tuesday", "13:30", "15:30", "MCA406"),
    ("Wednesday", "09:00", "10:00", "MCA403"),
    ("Wednesday", "10:00", "11:00", "MCA405"),
    ("Wednesday", "11:15", "12:15", "MCA402"),
    ("Wednesday", "13:30", "15:30", "MCA404"),
    ("Thursday", "09:00", "10:00", "MCA401"),
    ("Thursday", "10:00", "11:00", "MCA403"),
    ("Thursday", "11:15", "12:15", "MCA404"),
    ("Thursday", "13:30", "14:30", "MCA402"),
    ("Friday", "09:00", "10:00", "MCA405"),
    ("Friday", "10:00", "11:00", "MCA401"),
    ("Friday", "11:15", "12:15", "MCA403"),
    ("Friday", "13:30", "15:30", "MCA406"),
    ("Saturday", "09:00", "10:00", "MCA404"),
    ("Saturday", "10:00", "11:00", "MCA402"),
]


def insert_if_missing(collection, key: dict, doc: dict) -> bool:
    """Inserts doc only if no document matches key. Returns True if inserted."""
    on_insert = {k: v for k, v in doc.items() if k not in key}
    result = collection.update_one(key, {"$setOnInsert": on_insert}, upsert=True)
    return result.upserted_id is not None


def main() -> tuple[int, int]:
    student = students_collection.find_one({"student_id": DEMO_STUDENT_ID}, {"_id": 0})
    if student is None:
        print(f"Student {DEMO_STUDENT_ID} not found. Nothing was seeded.")
        return 0, 0

    department = str(student.get("department", ""))
    semester = int(student.get("semester"))

    ensure_indexes()

    added_attendance = 0
    for code, name, total, present in DEMO_ATTENDANCE:
        data = AttendanceInput(
            student_id=DEMO_STUDENT_ID,
            subject_code=code,
            subject_name=name,
            total_classes=total,
            present_classes=present,
        )
        doc = {**build_attendance_document(data, is_demo=True), "demo_note": DEMO_NOTE}
        # is_demo is part of the key, so official records are never matched or changed.
        key = {"student_id": DEMO_STUDENT_ID, "subject_code": code, "is_demo": True}
        added_attendance += insert_if_missing(attendance_collection, key, doc)

    added_timetable = 0
    for day, start, end, code in DEMO_TIMETABLE:
        data = TimetableInput(
            department=department,
            semester=semester,
            day_of_week=day,
            subject_code=code,
            subject_name=SUBJECTS[code],
            start_time=start,
            end_time=end,
            faculty_name=FACULTY[code],
            room_number=ROOMS[code],
        )
        doc = {**build_timetable_document(data, is_demo=True), "demo_note": DEMO_NOTE}
        key = {"department": department, "semester": semester,
               "day_of_week": day, "start_time": start, "is_demo": True}
        added_timetable += insert_if_missing(timetable_collection, key, doc)

    print(f"Attendance: {added_attendance} new demo records "
          f"({len(DEMO_ATTENDANCE) - added_attendance} already present)")
    print(f"Timetable:  {added_timetable} new demo entries "
          f"({len(DEMO_TIMETABLE) - added_timetable} already present)")
    return added_attendance, added_timetable


if __name__ == "__main__":
    main()
