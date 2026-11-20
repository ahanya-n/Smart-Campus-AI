def test_get_students_unauthenticated(client):
    response = client.get("/students")
    assert response.status_code == 401
    assert response.json()["detail"] == "Not authenticated"


def test_get_students_admin_can_list_directory(client, admin, test_students):
    response = client.get("/students", headers=admin["headers"])
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    student_ids = [s.get("student_id") for s in data]
    for sid in test_students["ids"]:
        assert sid in student_ids


def test_get_students_faculty_with_no_classes_sees_no_directory(client, accounts, test_students):
    faculty = accounts.make("faculty")

    response = client.get("/students", headers=faculty["headers"])

    assert response.status_code == 200
    assert response.json() == []


def test_get_students_student_sees_only_linked_record(client, accounts, test_students):
    student_user = accounts.make("student", student_id=test_students["ids"][0])

    response = client.get("/students", headers=student_user["headers"])

    assert response.status_code == 200
    assert [row["student_id"] for row in response.json()] == [test_students["ids"][0]]


def test_get_students_unlinked_student_sees_no_directory(client, accounts, test_students):
    student_user = accounts.make("student")

    response = client.get("/students", headers=student_user["headers"])

    assert response.status_code == 200
    assert response.json() == []


def test_post_students_requires_admin(client, accounts):
    student_user = accounts.make("student")
    response = client.post(
        "/students",
        headers=student_user["headers"],
        json={
            "student_id": "X1",
            "name": "Unauthorized Student",
            "email": "unauthorized@student.test",
            "department": "MCA",
            "semester": 1,
        },
    )
    assert response.status_code == 403
