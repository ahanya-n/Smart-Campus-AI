import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from pymongo import ASCENDING, MongoClient
from pymongo.errors import PyMongoError

load_dotenv(Path(__file__).resolve().parent / ".env")

# Both can be overridden in .env. Local runs default to the isolated test database.
MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27017/")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "smart_campus_test")

client = MongoClient(MONGO_URL)

database = client[MONGO_DB_NAME]

users_collection = database["users"]
students_collection = database["students"]
subjects_collection = database["subjects"]
classes_collection = database["classes"]
attendance_collection = database["attendance"]
attendance_entries_collection = database["attendance_entries"]
timetable_collection = database["timetable"]
link_codes_collection = database["student_link_codes"]
books_collection = database["books"]
book_loans_collection = database["book_loans"]
complaints_collection = database["complaints"]
events_collection = database["events"]
transport_collection = database["transport_routes"]
notifications_collection = database["notifications"]

logger = logging.getLogger("smart_campus")


def _create_index(collection, keys, name, replaces=None, **options):
    """Creates an index (idempotent). Optionally drops an older index first.
    Only index definitions are changed; no documents are touched."""
    try:
        if replaces and replaces in collection.index_information():
            collection.drop_index(replaces)
        collection.create_index(keys, name=name, **options)
    except PyMongoError as error:
        logger.warning("Could not create index %s on %s: %s", name, collection.name, error)


def ensure_indexes() -> None:
    _create_index(users_collection, [("email", ASCENDING)], "email_unique", unique=True)
    # One user per student record; only applies to users that are linked.
    _create_index(
        users_collection,
        [("student_id", ASCENDING)],
        "student_link_unique",
        unique=True,
        partialFilterExpression={"student_id": {"$type": "string"}},
    )

    # Demo and official aggregates for the same student/subject are kept apart.
    _create_index(
        attendance_collection,
        [("student_id", ASCENDING), ("subject_code", ASCENDING), ("is_demo", ASCENDING)],
        "student_subject_demo_unique",
        replaces="student_subject_unique",
        unique=True,
    )
    # One mark per student, subject and class session.
    _create_index(
        attendance_entries_collection,
        [("student_id", ASCENDING), ("subject_code", ASCENDING),
         ("session_date", ASCENDING), ("start_time", ASCENDING)],
        "student_session_unique",
        unique=True,
    )
    _create_index(
        attendance_entries_collection,
        [("subject_code", ASCENDING), ("session_date", ASCENDING)],
        "subject_date",
    )

    _create_index(
        timetable_collection,
        [("department", ASCENDING), ("semester", ASCENDING), ("day_of_week", ASCENDING),
         ("start_time", ASCENDING), ("is_demo", ASCENDING)],
        "slot_demo_unique",
        replaces="slot_unique",
        unique=True,
    )

    _create_index(link_codes_collection, [("student_id", ASCENDING)], "student_unique", unique=True)
    # MongoDB removes link codes automatically once they expire.
    _create_index(link_codes_collection, [("expires_at", ASCENDING)], "expiry_ttl", expireAfterSeconds=0)

    _create_index(books_collection, [("isbn", ASCENDING)], "isbn_unique", unique=True, partialFilterExpression={"isbn": {"$type": "string"}})
    _create_index(books_collection, [("title", ASCENDING)], "book_title")
    _create_index(
        book_loans_collection,
        [("user_id", ASCENDING), ("borrowing_slot", ASCENDING)],
        "library_active_borrowing_slot_unique",
        unique=True,
        partialFilterExpression={
            "status": "borrowed",
            "borrowing_slot": {"$type": "int"},
        },
    )
    _create_index(
        book_loans_collection,
        [("user_id", ASCENDING), ("borrowed_at", -1)],
        "library_user_history",
    )
    _create_index(complaints_collection, [("user_id", ASCENDING)], "complaint_user")
    _create_index(complaints_collection, [("status", ASCENDING)], "complaint_status")
    _create_index(events_collection, [("date", ASCENDING)], "event_date")
    _create_index(transport_collection, [("route_number", ASCENDING)], "route_number_unique", unique=True)
    _create_index(
        transport_collection,
        [("assignments.student_id", ASCENDING)],
        "transport_student_assignment_unique",
        unique=True,
        partialFilterExpression={"assignments.student_id": {"$type": "string"}},
    )
    _create_index(
        notifications_collection,
        [("student_id", ASCENDING), ("subject_code", ASCENDING), ("week_id", ASCENDING)],
        "student_subject_week_unique",
        unique=True,
    )
    _create_index(notifications_collection, [("student_id", ASCENDING), ("created_at", ASCENDING)], "student_notifications")
