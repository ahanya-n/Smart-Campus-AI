from copy import deepcopy
from datetime import datetime

from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient

import routes.library_routes as library_routes
from dependencies.auth import get_current_user


class Cursor:
    def __init__(self, documents):
        self.documents = documents

    def sort(self, field, direction):
        self.documents.sort(key=lambda item: item.get(field), reverse=direction < 0)
        return self

    def to_list(self):
        return self.documents

    def __iter__(self):
        return iter(self.documents)


def matches(document, query):
    for key, expected in query.items():
        if key == "$expr":
            left, right = expected["$lt"]
            if not document[left[1:]] < document[right[1:]]:
                return False
            continue
        actual = document.get(key)
        if isinstance(expected, dict):
            if "$gt" in expected and not actual > expected["$gt"]:
                return False
            continue
        if actual != expected:
            return False
    return True


class Collection:
    def __init__(self, documents=()):
        self.documents = [deepcopy(document) for document in documents]

    def find(self, query):
        return Cursor([document for document in self.documents if matches(document, query)])

    def find_one(self, query):
        return next((document for document in self.documents if matches(document, query)), None)

    def insert_one(self, document):
        if "isbn" in document and any(item.get("isbn") == document["isbn"] for item in self.documents):
            raise library_routes.DuplicateKeyError("duplicate ISBN")
        saved = deepcopy(document)
        saved["_id"] = ObjectId()
        self.documents.append(saved)
        return type("InsertResult", (), {"inserted_id": saved["_id"]})()

    def update_one(self, query, update):
        document = self.find_one(query)
        if document is None:
            return type("UpdateResult", (), {"matched_count": 0})()
        for field, amount in update.get("$inc", {}).items():
            document[field] += amount
        document.update(update.get("$set", {}))
        for field in update.get("$unset", {}):
            document.pop(field, None)
        return type("UpdateResult", (), {"matched_count": 1})()

    def count_documents(self, query):
        return len([item for item in self.documents if matches(item, query)])


def make_client(monkeypatch, user, books=(), loans=()):
    book_collection = Collection(books)
    loan_collection = Collection(loans)
    monkeypatch.setattr(library_routes, "books_collection", book_collection)
    monkeypatch.setattr(library_routes, "book_loans_collection", loan_collection)
    app = FastAPI()
    app.include_router(library_routes.router)
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app), book_collection, loan_collection


def make_book(**overrides):
    return {
        "_id": ObjectId(),
        "title": "The Pragmatic Programmer",
        "author": "Andrew Hunt",
        "isbn": "9780135957059",
        "category": "Software",
        "total_copies": 2,
        "available_copies": 2,
        **overrides,
    }


def test_library_requires_authentication(monkeypatch):
    client, _, _ = make_client(monkeypatch, {"_id": ObjectId(), "role": "student"})
    client.app.dependency_overrides.clear()
    response = client.get("/library/books")
    assert response.status_code == 401


def test_catalog_search_and_admin_book_creation(monkeypatch):
    student = {"_id": ObjectId(), "role": "student"}
    book = make_book()
    client, books, _ = make_client(monkeypatch, student, [book])

    result = client.get("/library/books?search=pragmatic")
    assert result.status_code == 200
    assert len(result.json()) == 1
    assert result.json()[0]["available_copies"] == 2
    assert client.post("/library/books", json={
        "title": "New Book", "author": "A. Writer", "isbn": "123456",
        "category": "Computing", "total_copies": 2,
    }).status_code == 403

    admin = {"_id": ObjectId(), "role": "admin"}
    admin_client, admin_books, _ = make_client(monkeypatch, admin, [book])
    created = admin_client.post("/library/books", json={
        "title": "New Book", "author": "A. Writer", "isbn": "123456",
        "category": "Computing", "total_copies": 2,
    })
    assert created.status_code == 201
    assert created.json()["available_copies"] == 2
    assert len(admin_books.documents) == 2
    invalid = admin_client.post("/library/books", json={
        "title": " ", "author": "A", "isbn": "x", "category": "Other",
        "total_copies": 0,
    })
    assert invalid.status_code == 422
    duplicate = admin_client.post("/library/books", json={
        "title": "Another title", "author": "A. Writer", "isbn": book["isbn"],
        "category": "Computing", "total_copies": 2,
    })
    assert duplicate.status_code == 409


def test_borrowing_checks_availability_and_creates_history(monkeypatch):
    student = {"_id": ObjectId(), "role": "student", "name": "Student"}
    book = make_book(available_copies=1)
    client, books, loans = make_client(monkeypatch, student, [book])

    borrowed = client.post(f"/library/books/{book['_id']}/borrow")
    assert borrowed.status_code == 201
    assert books.documents[0]["available_copies"] == 0
    assert borrowed.json()["status"] == "borrowed"
    assert datetime.fromisoformat(borrowed.json()["due_at"]) - datetime.fromisoformat(
        borrowed.json()["borrowed_at"]
    ) == library_routes.timedelta(days=14)
    assert client.get("/library/loans").json()[0]["id"] == borrowed.json()["id"]
    assert client.post(f"/library/books/{book['_id']}/borrow").status_code == 409

    other_book = make_book(available_copies=0)
    books.documents.append(other_book)
    assert client.post(f"/library/books/{other_book['_id']}/borrow").status_code == 409
    assert len(loans.documents) == 1


def test_active_loan_limit_cannot_be_exceeded(monkeypatch):
    student_id = ObjectId()
    student = {"_id": student_id, "role": "student"}
    book = make_book()
    loans = [{
        "_id": ObjectId(),
        "user_id": student_id,
        "book_id": ObjectId(),
        "status": "borrowed",
        "borrowing_slot": slot,
    } for slot in range(5)]
    client, books, _ = make_client(monkeypatch, student, [book], loans)

    response = client.post(f"/library/books/{book['_id']}/borrow")
    assert response.status_code == 409
    assert "at most 5" in response.json()["detail"]
    assert books.documents[0]["available_copies"] == 2


def test_return_is_owner_scoped_and_restores_inventory(monkeypatch):
    student_id = ObjectId()
    book = make_book(available_copies=1)
    loan = {
        "_id": ObjectId(),
        "book_id": book["_id"],
        "user_id": student_id,
        "book_title": book["title"],
        "book_isbn": book["isbn"],
        "status": "borrowed",
        "borrowing_slot": 0,
        "borrowed_at": datetime.now(),
        "due_at": datetime.now(),
        "returned_at": None,
    }
    client, _, _ = make_client(
        monkeypatch, {"_id": ObjectId(), "role": "student"}, [book], [loan]
    )
    loan_id = str(loan["_id"])

    assert client.post(f"/library/loans/{loan_id}/return").status_code == 404
    client, books, loans = make_client(
        monkeypatch, {"_id": student_id, "role": "student"}, [book], [loan]
    )
    returned = client.post(f"/library/loans/{loan_id}/return")
    assert returned.status_code == 200
    assert returned.json()["status"] == "returned"
    assert books.documents[0]["available_copies"] == 2
    assert loans.documents[0]["status"] == "returned"


def test_admin_inventory_update_preserves_available_copies(monkeypatch):
    admin = {"_id": ObjectId(), "role": "admin"}
    book = make_book(total_copies=2, available_copies=1)
    loan = {
        "_id": ObjectId(),
        "book_id": book["_id"],
        "status": "borrowed",
    }
    client, books, _ = make_client(monkeypatch, admin, [book], [loan])

    updated = client.patch(f"/library/books/{book['_id']}", json={"total_copies": 4})
    assert updated.status_code == 200
    assert updated.json()["available_copies"] == 3
    assert books.documents[0]["available_copies"] == 3
