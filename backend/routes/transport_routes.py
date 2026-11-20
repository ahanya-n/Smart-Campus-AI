import re
from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from pymongo.errors import DuplicateKeyError

from database import students_collection, transport_collection
from dependencies.auth import get_current_user, require_roles, user_role

router = APIRouter(prefix="/transport", tags=["Transport"])

ROUTE_NUMBER_PATTERN = re.compile(r"^[A-Za-z0-9-]+$")
PHONE_PATTERN = re.compile(r"^[+0-9() -]{7,24}$")


class DriverInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    phone: str = Field(min_length=7, max_length=24)

    @field_validator("name", "phone")
    @classmethod
    def clean_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value: str) -> str:
        if not PHONE_PATTERN.fullmatch(value):
            raise ValueError("phone must contain 7-24 valid phone characters")
        digits = sum(character.isdigit() for character in value)
        if not 7 <= digits <= 15:
            raise ValueError("phone must contain 7-15 digits")
        return value


class TransportRouteInput(BaseModel):
    route_number: str = Field(min_length=1, max_length=20)
    bus_number: str = Field(min_length=1, max_length=20)
    registration_number: str = Field(min_length=1, max_length=20)
    pickup_points: list[str] = Field(min_length=1, max_length=30)
    drop_points: list[str] = Field(min_length=1, max_length=30)
    driver: DriverInput
    capacity: int = Field(ge=1, le=100)

    @field_validator("route_number")
    @classmethod
    def validate_route_number(cls, value: str) -> str:
        value = value.strip()
        if not ROUTE_NUMBER_PATTERN.fullmatch(value):
            raise ValueError("route_number may contain letters, digits, and hyphens")
        return value.upper()

    @field_validator("bus_number", "registration_number")
    @classmethod
    def clean_vehicle_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("pickup_points", "drop_points")
    @classmethod
    def validate_points(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values]
        if any(not value or len(value) > 100 for value in cleaned):
            raise ValueError("points must be non-empty and no more than 100 characters")
        normalized = [value.casefold() for value in cleaned]
        if len(set(normalized)) != len(normalized):
            raise ValueError("points must not contain duplicates")
        return cleaned


class AssignmentInput(BaseModel):
    student_id: str = Field(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9-]+$")
    pickup_point: str = Field(min_length=1, max_length=100)
    drop_point: str = Field(min_length=1, max_length=100)

    @field_validator("student_id", "pickup_point", "drop_point")
    @classmethod
    def clean_assignment_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


def _route_id(raw_id: str) -> ObjectId:
    try:
        return ObjectId(raw_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail="Transport route not found")


def _route_output(route: dict, *, admin: bool = False) -> dict:
    assignments = route.get("assignments") or []
    output = {
        "id": str(route["_id"]),
        "route_number": route["route_number"],
        "bus_number": route["bus_number"],
        "registration_number": route["registration_number"],
        "pickup_points": list(route["pickup_points"]),
        "drop_points": list(route["drop_points"]),
        "driver": {"name": route["driver"]["name"]},
        "capacity": route["capacity"],
        "assigned_seats": len(assignments),
        "available_seats": max(0, route["capacity"] - len(assignments)),
        "created_at": route.get("created_at"),
        "updated_at": route.get("updated_at"),
    }
    if admin:
        output["driver"] = dict(route["driver"])
        output["assignments"] = [
            {
                "student_id": item["student_id"],
                "pickup_point": item["pickup_point"],
                "drop_point": item["drop_point"],
                "assigned_at": item.get("assigned_at"),
            }
            for item in assignments
        ]
    return output


def _find_route(route_id: ObjectId) -> dict:
    route = transport_collection.find_one({"_id": route_id})
    if route is None:
        raise HTTPException(status_code=404, detail="Transport route not found")
    return route


def _replace_assignments(route: dict, assignments: list[dict]) -> bool:
    return transport_collection.update_one(
        {"_id": route["_id"], "assignments": route.get("assignments", [])},
        {"$set": {"assignments": assignments, "updated_at": datetime.now(timezone.utc)}},
    ).matched_count == 1


@router.get("/routes")
def list_routes(user: dict = Depends(get_current_user)):
    admin = user_role(user) == "admin"
    routes = transport_collection.find({}).sort("route_number", 1).to_list()
    return [_route_output(route, admin=admin) for route in routes]


@router.get("/routes/{route_id}")
def get_route(route_id: str, user: dict = Depends(get_current_user)):
    route = _find_route(_route_id(route_id))
    return _route_output(route, admin=user_role(user) == "admin")


@router.get("/me")
def get_my_transport(user: dict = Depends(require_roles("student"))):
    student_id = user.get("student_id")
    if not isinstance(student_id, str) or not student_id.strip():
        return {"assigned": False, "route": None, "assignment": None}

    for route in transport_collection.find({"assignments.student_id": student_id}):
        assignment = next(
            (item for item in route.get("assignments", []) if item.get("student_id") == student_id),
            None,
        )
        if assignment:
            return {
                "assigned": True,
                "route": _route_output(route),
                "assignment": {
                    "student_id": student_id,
                    "pickup_point": assignment["pickup_point"],
                    "drop_point": assignment["drop_point"],
                    "assigned_at": assignment.get("assigned_at"),
                },
            }
    return {"assigned": False, "route": None, "assignment": None}


@router.post("/routes", status_code=201)
def create_route(
    data: TransportRouteInput,
    _admin: dict = Depends(require_roles("admin")),
):
    now = datetime.now(timezone.utc)
    document = {
        **data.model_dump(),
        "assignments": [],
        "created_at": now,
        "updated_at": now,
    }
    try:
        result = transport_collection.insert_one(document)
    except DuplicateKeyError as error:
        raise HTTPException(status_code=409, detail="Route number already exists") from error
    return _route_output({**document, "_id": result.inserted_id}, admin=True)


@router.patch("/routes/{route_id}")
def update_route(
    route_id: str,
    data: TransportRouteInput,
    _admin: dict = Depends(require_roles("admin")),
):
    object_id = _route_id(route_id)
    route = _find_route(object_id)
    assignments = route.get("assignments") or []
    if data.capacity < len(assignments):
        raise HTTPException(
            status_code=409,
            detail="Capacity cannot be lower than the number of assigned students",
        )
    pickup_points = {point.casefold(): point for point in data.pickup_points}
    drop_points = {point.casefold(): point for point in data.drop_points}
    for assignment in assignments:
        if (
            assignment["pickup_point"].casefold() not in pickup_points
            or assignment["drop_point"].casefold() not in drop_points
        ):
            raise HTTPException(
                status_code=409,
                detail="Existing student pickup and drop points must be retained",
            )
    updated_assignments = [
        {
            **assignment,
            "pickup_point": pickup_points[assignment["pickup_point"].casefold()],
            "drop_point": drop_points[assignment["drop_point"].casefold()],
        }
        for assignment in assignments
    ]
    try:
        result = transport_collection.update_one(
            {"_id": object_id, "updated_at": route.get("updated_at")},
            {"$set": {
                **data.model_dump(),
                "assignments": updated_assignments,
                "updated_at": datetime.now(timezone.utc),
            }},
        )
    except DuplicateKeyError as error:
        raise HTTPException(status_code=409, detail="Route number already exists") from error
    if result.matched_count != 1:
        raise HTTPException(status_code=409, detail="Route changed during the update. Please retry.")
    return _route_output({**route, **data.model_dump(), "updated_at": datetime.now(timezone.utc)}, admin=True)


@router.delete("/routes/{route_id}", status_code=204)
def delete_route(route_id: str, _admin: dict = Depends(require_roles("admin"))):
    object_id = _route_id(route_id)
    route = _find_route(object_id)
    if route.get("assignments"):
        raise HTTPException(status_code=409, detail="Remove assigned students before deleting this route")
    deleted = transport_collection.delete_one({
        "_id": object_id,
        "assignments": route.get("assignments", []),
        "updated_at": route.get("updated_at"),
    })
    if deleted.deleted_count != 1:
        raise HTTPException(status_code=409, detail="Route changed during deletion. Please retry.")


@router.post("/routes/{route_id}/assignments", status_code=201)
def assign_student(
    route_id: str,
    data: AssignmentInput,
    _admin: dict = Depends(require_roles("admin")),
):
    object_id = _route_id(route_id)
    student_id = data.student_id
    if students_collection.find_one({"student_id": student_id}, {"_id": 1}) is None:
        raise HTTPException(status_code=404, detail="Student record not found")

    for _attempt in range(3):
        route = _find_route(object_id)
        assignments = route.get("assignments") or []
        if any(item.get("student_id") == student_id for item in assignments):
            raise HTTPException(status_code=409, detail="Student is already assigned to this route")
        pickup_point = next(
            (
                point for point in route.get("pickup_points", [])
                if data.pickup_point.casefold() == point.casefold()
            ),
            None,
        )
        if pickup_point is None:
            raise HTTPException(status_code=422, detail="Pickup point is not on this route")
        drop_point = next(
            (
                point for point in route.get("drop_points", [])
                if data.drop_point.casefold() == point.casefold()
            ),
            None,
        )
        if drop_point is None:
            raise HTTPException(status_code=422, detail="Drop point is not on this route")
        if len(assignments) >= route["capacity"]:
            raise HTTPException(status_code=409, detail="This route is at capacity")
        if transport_collection.find_one({"assignments.student_id": student_id}):
            raise HTTPException(status_code=409, detail="Student is already assigned to another route")

        assignment = {
            **data.model_dump(),
            "pickup_point": pickup_point,
            "drop_point": drop_point,
            "assigned_at": datetime.now(timezone.utc),
        }
        try:
            updated = _replace_assignments(route, [*assignments, assignment])
        except DuplicateKeyError as error:
            raise HTTPException(
                status_code=409,
                detail="Student is already assigned to another route",
            ) from error
        if updated:
            return {
                "route_id": str(object_id),
                **{key: assignment[key] for key in ("student_id", "pickup_point", "drop_point")},
                "assigned_at": assignment["assigned_at"],
            }
    raise HTTPException(status_code=409, detail="Route changed during assignment. Please retry.")


@router.delete("/routes/{route_id}/assignments/{student_id}", status_code=204)
def remove_student(
    route_id: str,
    student_id: str,
    _admin: dict = Depends(require_roles("admin")),
):
    object_id = _route_id(route_id)
    for _attempt in range(3):
        route = _find_route(object_id)
        assignments = route.get("assignments") or []
        updated_assignments = [
            item for item in assignments if item.get("student_id") != student_id
        ]
        if len(updated_assignments) == len(assignments):
            raise HTTPException(status_code=404, detail="Student assignment not found")
        if _replace_assignments(route, updated_assignments):
            return
    raise HTTPException(status_code=409, detail="Route changed during removal. Please retry.")
