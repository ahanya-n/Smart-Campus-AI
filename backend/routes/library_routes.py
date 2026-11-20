from datetime import datetime, timedelta, timezone

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from pymongo.errors import DuplicateKeyError

from database import book_loans_collection, books_collection
from dependencies.auth import get_current_user, require_roles

router = APIRouter(prefix="/library", tags=["Library"])

MAX_ACTIVE_LOANS = 5
LOAN_PERIOD_DAYS = 14


class BookInput(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    author: str = Field(min_length=1, max_length=120)
    isbn: str = Field(min_length=1, max_length=30)
    category: str = Field(min_length=1, max_length=60)
    total_copies: int = Field(ge=1, le=10000)

    @field_validator("title", "author", "isbn", "category")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


class BookInventoryUpdate(BaseModel):
    total_copies: int = Field(ge=1, le=10000)


def _object_id(raw_id: str, resource: str) -> ObjectId:
    try:
        return ObjectId(raw_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail=f"{resource} not found")


def _book_output(book: dict) -> dict:
    return {
        "id": str(book["_id"]),
        "title": book["title"],
        "author": book["author"],
        "isbn": book["isbn"],
        "category": book["category"],
        "total_copies": book["total_copies"],
        "available_copies": book["available_copies"],
    }


def _loan_output(loan: dict) -> dict:
    def as_iso(value):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()

    return {
        "id": str(loan["_id"]),
        "book_id": str(loan["book_id"]),
        "book_title": loan["book_title"],
        "book_isbn": loan["book_isbn"],
        "status": loan["status"],
        "borrowed_at": as_iso(loan["borrowed_at"]),
        "due_at": as_iso(loan["due_at"]),
        "returned_at": as_iso(loan.get("returned_at")),
    }


def _restore_copy(book_id: ObjectId) -> None:
    result = books_collection.update_one(
        {
            "_id": book_id,
            "$expr": {"$lt": ["$available_copies", "$total_copies"]},
        },
        {"$inc": {"available_copies": 1}},
    )
    if result.matched_count != 1:
        raise RuntimeError("Could not restore the reserved library copy.")


@router.get("/books")
def list_books(
    search: str | None = Query(None, max_length=100),
    _user: dict = Depends(get_current_user),
):
    books = books_collection.find({}).sort("title", 1).to_list()
    term = search.strip().casefold() if search else ""
    if term:
        books = [
            book for book in books
            if any(term in str(book.get(field, "")).casefold()
                   for field in ("title", "author", "isbn", "category"))
        ]
    return [_book_output(book) for book in books]


@router.post("/books", status_code=201)
def create_book(
    data: BookInput,
    _admin: dict = Depends(require_roles("admin")),
):
    document = {
        **data.model_dump(),
        "available_copies": data.total_copies,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    try:
        result = books_collection.insert_one(document)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="A book with this ISBN already exists")
    return _book_output({**document, "_id": result.inserted_id})


@router.patch("/books/{book_id}")
def update_book_inventory(
    book_id: str,
    data: BookInventoryUpdate,
    _admin: dict = Depends(require_roles("admin")),
):
    object_id = _object_id(book_id, "Book")
    for _attempt in range(3):
        book = books_collection.find_one({"_id": object_id})
        if not book:
            raise HTTPException(status_code=404, detail="Book not found")
        active_loans = book_loans_collection.count_documents(
            {"book_id": object_id, "status": "borrowed"}
        )
        available = book["available_copies"] + data.total_copies - book["total_copies"]
        if data.total_copies < active_loans or available < 0:
            raise HTTPException(
                status_code=409,
                detail="total_copies cannot be less than active loans",
            )
        updated = books_collection.update_one(
            {
                "_id": object_id,
                "total_copies": book["total_copies"],
                "available_copies": book["available_copies"],
            },
            {"$set": {
                "total_copies": data.total_copies,
                "available_copies": available,
                "updated_at": datetime.now(timezone.utc),
            }},
        )
        if updated.matched_count == 1:
            return _book_output({
                **book,
                "total_copies": data.total_copies,
                "available_copies": available,
            })
    raise HTTPException(
        status_code=409,
        detail="Inventory changed during the update. Please retry.",
    )


@router.get("/loans")
def list_loans(user: dict = Depends(get_current_user)):
    loans = book_loans_collection.find({"user_id": user["_id"]}).sort("borrowed_at", -1).to_list()
    return [_loan_output(loan) for loan in loans]


@router.post("/books/{book_id}/borrow", status_code=201)
def borrow_book(book_id: str, user: dict = Depends(get_current_user)):
    object_id = _object_id(book_id, "Book")
    book = books_collection.find_one({"_id": object_id})
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    active = list(book_loans_collection.find({
        "user_id": user["_id"],
        "status": "borrowed",
    }))
    if len(active) >= MAX_ACTIVE_LOANS:
        raise HTTPException(
            status_code=409,
            detail=f"You may borrow at most {MAX_ACTIVE_LOANS} books at a time",
        )

    reserved = books_collection.update_one(
        {"_id": object_id, "available_copies": {"$gt": 0}},
        {"$inc": {"available_copies": -1}, "$set": {"updated_at": datetime.now(timezone.utc)}},
    )
    if reserved.matched_count != 1:
        raise HTTPException(status_code=409, detail="This book is currently unavailable")

    used_slots = {
        loan["borrowing_slot"] for loan in active
        if isinstance(loan.get("borrowing_slot"), int)
    }
    now = datetime.now(timezone.utc)
    loan = {
        "book_id": object_id,
        "user_id": user["_id"],
        "book_title": book["title"],
        "book_isbn": book["isbn"],
        "status": "borrowed",
        "borrowing_slot": None,
        "borrowed_at": now,
        "due_at": now + timedelta(days=LOAN_PERIOD_DAYS),
        "returned_at": None,
    }
    saved = None
    try:
        for slot in range(MAX_ACTIVE_LOANS):
            if slot in used_slots:
                continue
            loan["borrowing_slot"] = slot
            try:
                result = book_loans_collection.insert_one(loan)
                saved = {**loan, "_id": result.inserted_id}
                break
            except DuplicateKeyError:
                used_slots.add(slot)
    except Exception:
        _restore_copy(object_id)
        raise

    if saved is None:
        _restore_copy(object_id)
        raise HTTPException(
            status_code=409,
            detail=f"You may borrow at most {MAX_ACTIVE_LOANS} books at a time",
        )
    return _loan_output(saved)


@router.post("/loans/{loan_id}/return")
def return_book(loan_id: str, user: dict = Depends(get_current_user)):
    object_id = _object_id(loan_id, "Active loan")
    filter_query = {"_id": object_id, "status": "borrowed"}
    if user.get("role") != "admin":
        filter_query["user_id"] = user["_id"]
    loan = book_loans_collection.find_one(filter_query)
    if not loan:
        raise HTTPException(status_code=404, detail="Active loan not found")

    returned_at = datetime.now(timezone.utc)
    updated = book_loans_collection.update_one(
        filter_query,
        {"$set": {"status": "returned", "returned_at": returned_at}},
    )
    if updated.matched_count != 1:
        raise HTTPException(status_code=409, detail="This book has already been returned")
    try:
        inventory = books_collection.update_one(
            {
                "_id": loan["book_id"],
                "$expr": {"$lt": ["$available_copies", "$total_copies"]},
            },
            {"$inc": {"available_copies": 1}, "$set": {"updated_at": returned_at}},
        )
        if inventory.matched_count != 1:
            raise RuntimeError("Could not restore returned library inventory.")
    except Exception:
        book_loans_collection.update_one(
            {"_id": object_id, "status": "returned"},
            {"$set": {"status": "borrowed"}, "$unset": {"returned_at": ""}},
        )
        raise
    return _loan_output({**loan, "status": "returned", "returned_at": returned_at})
