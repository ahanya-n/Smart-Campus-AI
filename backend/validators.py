"""Shared validation rules for request models."""

from typing import Literal

# 24-hour "HH:MM", zero-padded, so values also compare correctly as text.
TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"

# Letters, digits and dashes, e.g. "MCA401".
CODE_PATTERN = r"^[A-Za-z0-9-]{1,20}$"

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
DayOfWeek = Literal["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

Role = Literal["student", "faculty", "admin"]
ROLES = ("student", "faculty", "admin")
