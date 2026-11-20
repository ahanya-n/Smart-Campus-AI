from dataclasses import dataclass

from fastapi import Depends, Query
from pydantic import BaseModel

from database import students_collection
from dependencies.auth import get_current_user
from services.data_filters import is_local_demo_student

# The student whose records are seeded as clearly-labelled demo data.
DEMO_STUDENT_ID = "MCA001"

NOT_LINKED_MESSAGE = (
    "Your account is not linked to a student record yet. "
    "Ask the college admin for a link code, or view the demo data instead."
)


class StudentInfo(BaseModel):
    student_id: str
    name: str
    department: str
    semester: str


def student_info(student: dict | None) -> StudentInfo | None:
    if student is None:
        return None
    return StudentInfo(
        student_id=str(student.get("student_id", "")),
        name=str(student.get("name", "")),
        department=str(student.get("department", "")),
        semester=str(student.get("semester", "")),
    )


@dataclass
class StudentContext:
    """Which student's data a request may see."""

    student: dict | None
    demo: bool

    @property
    def linked(self) -> bool:
        return self.student is not None and not self.demo

    def info(self) -> StudentInfo | None:
        return student_info(self.student)

    def record_filter(self) -> dict | None:
        """Mongo filter for this context's attendance, or None if nothing may be shown.
        Demo mode only returns demo records; linked mode only official ones."""
        if self.student is None:
            return None
        return {
            "student_id": self.student["student_id"],
            "is_demo": (
                True
                if self.demo or is_local_demo_student(self.student)
                else {"$ne": True}
            ),
            **(
                {"synthetic_demo": True}
                if is_local_demo_student(self.student)
                else {}
            ),
        }


def find_linked_student(user: dict) -> dict | None:
    """The student record explicitly linked to this account (by an admin or a
    verified link code). Emails are no longer used for matching, because anyone
    could register with a student's email address."""
    student_id = user.get("student_id")
    if not student_id:
        return None
    return students_collection.find_one({"student_id": student_id}, {"_id": 0})


def get_student_context(
    demo: bool = Query(
        False,
        description="Show the clearly-labelled DEMO records instead of your own.",
    ),
    current_user: dict = Depends(get_current_user),
) -> StudentContext:
    if demo:
        demo_student = students_collection.find_one({"student_id": DEMO_STUDENT_ID}, {"_id": 0})
        return StudentContext(student=demo_student, demo=True)

    return StudentContext(student=find_linked_student(current_user), demo=False)
