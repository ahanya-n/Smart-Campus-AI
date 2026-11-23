import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

from fastapi import FastAPI, HTTPException
from database import client, ensure_indexes
from pymongo.errors import PyMongoError
from routes.student_routes import router as student_router
from routes.auth_routes import router as auth_router
from routes.attendance_routes import router as attendance_router
from routes.timetable_routes import router as timetable_router
from routes.admin_routes import router as admin_router
from routes.assistant_routes import router as assistant_router
from routes.assistant_private_routes import router as assistant_private_router
from routes.notification_routes import router as notification_router
from routes.library_routes import router as library_router
from routes.transport_routes import router as transport_router
from routes.complaint_routes import router as complaint_router
from routes.academic_intelligence_routes import router as academic_intelligence_router
from routes.lost_found_routes import router as lost_found_router
from services.attendance_warning_service import check_weekly_low_attendance

logger = logging.getLogger("smart_campus")


def _seconds_until_next_weekly_run(now: datetime | None = None) -> float:
    current = now or datetime.now().astimezone()
    next_run = current.replace(hour=0, minute=5, second=0, microsecond=0)
    next_run += timedelta(days=(7 - current.weekday()) % 7)
    if next_run <= current:
        next_run += timedelta(days=7)
    return (next_run - current).total_seconds()


async def _attendance_warning_scheduler():
    """Run once each Monday shortly after midnight, retrying failed scans hourly."""
    while True:
        await asyncio.sleep(_seconds_until_next_weekly_run())
        while True:
            try:
                await asyncio.to_thread(check_weekly_low_attendance)
                break
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("Scheduled weekly attendance check encountered error: %s", e)
                await asyncio.sleep(3600)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Idempotent: creates missing indexes, never touches documents.
    ensure_indexes()
    try:
        await asyncio.to_thread(check_weekly_low_attendance)
    except Exception as e:
        logger.warning("Initial weekly attendance check encountered error: %s", e)

    # Launch background scheduler in server mode (not during pytest test sessions)
    scheduler_task = None
    if os.getenv("MONGO_DB_NAME") != "smart_campus_test":
        scheduler_task = asyncio.create_task(_attendance_warning_scheduler())

    try:
        yield
    finally:
        if scheduler_task:
            scheduler_task.cancel()
            try:
                await scheduler_task
            except asyncio.CancelledError:
                pass


app = FastAPI(
    title="Smart Campus API",
    description="Backend API for Smart Campus Management App",
    version="1.2.0",
    lifespan=lifespan,
)


@app.get("/health")
def health():
    return {"status": "ok", "service": "smart-campus-api"}


# Student APIs
app.include_router(student_router)

# Authentication APIs
app.include_router(auth_router)

# Attendance and timetable APIs
app.include_router(attendance_router)
app.include_router(timetable_router)

# Admin APIs
app.include_router(admin_router)

# AI Campus Assistant & Free-Time APIs
app.include_router(assistant_router)
app.include_router(assistant_private_router)

# Weekly Attendance Warnings & Notification APIs
app.include_router(notification_router)

# Library catalog and borrowing APIs
app.include_router(library_router)

# Transport routes and student assignments
app.include_router(transport_router)

# Student complaints and admin case management
app.include_router(complaint_router)
app.include_router(academic_intelligence_router)
app.include_router(lost_found_router)


@app.get("/")
def home():
    return {
        "message": "Smart Campus Backend is Running!"
    }


@app.get("/test-db")
def test_database():
    try:
        client.admin.command("ping")
        return {
            "message": "MongoDB Connected Successfully!"
        }
    except PyMongoError as error:
        logger.warning("MongoDB connectivity check failed: %s", type(error).__name__)
        raise HTTPException(
            status_code=503,
            detail="MongoDB is unavailable",
        ) from error
