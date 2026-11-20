from tests.conftest import PASSWORD


def test_admin_list_users(client, admin, accounts):
    accounts.make("student")
    res = client.get("/admin/users", headers=admin["headers"])
    assert res.status_code == 200
    users = res.json()
    assert isinstance(users, list)
    assert any(u["role"] == "admin" for u in users)


def test_admin_create_account(client, admin, run_id):
    res = client.post(
        "/admin/users",
        headers=admin["headers"],
        json={
            "name": "Prof Smith",
            "email": f"faculty.{run_id}@test.local",
            "password": PASSWORD,
            "role": "faculty",
        },
    )
    assert res.status_code == 201
    body = res.json()
    assert body["role"] == "faculty"
    assert body["assigned_subject_codes"] == []


def test_admin_set_role(client, admin, accounts):
    student = accounts.make("student")
    user_id = student["id"]

    # Promote to faculty
    res = client.patch(
        f"/admin/users/{user_id}/role",
        headers=admin["headers"],
        json={"role": "faculty"},
    )
    assert res.status_code == 200
    assert res.json()["role"] == "faculty"

    # Cannot remove own admin role
    self_demote = client.patch(
        f"/admin/users/{admin['id']}/role",
        headers=admin["headers"],
        json={"role": "student"},
    )
    assert self_demote.status_code == 409


def test_admin_assign_subjects(client, admin, accounts):
    faculty = accounts.make("faculty")
    student = accounts.make("student")

    # Success for faculty
    res = client.put(
        f"/admin/users/{faculty['id']}/subjects",
        headers=admin["headers"],
        json={"subject_codes": ["MCA401", "MCA402"]},
    )
    assert res.status_code == 200
    assert res.json()["assigned_subject_codes"] == ["MCA401", "MCA402"]

    # Fails for student account
    fail_res = client.put(
        f"/admin/users/{student['id']}/subjects",
        headers=admin["headers"],
        json={"subject_codes": ["MCA401"]},
    )
    assert fail_res.status_code == 409


def test_admin_direct_student_link_and_unlink(client, admin, accounts, test_students):
    student = accounts.make("student")
    sid = test_students["ids"][1]

    # Link student
    link_res = client.put(
        f"/admin/users/{student['id']}/student-link",
        headers=admin["headers"],
        json={"student_id": sid},
    )
    assert link_res.status_code == 200
    assert link_res.json()["student_id"] == sid

    # Unlink student
    unlink_res = client.put(
        f"/admin/users/{student['id']}/student-link",
        headers=admin["headers"],
        json={"student_id": None},
    )
    assert unlink_res.status_code == 200
    assert unlink_res.json()["student_id"] is None


def test_admin_stats(client, admin, accounts):
    student = accounts.make("student")

    # Student forbidden
    bad_res = client.get("/admin/stats", headers=student["headers"])
    assert bad_res.status_code == 403

    # Admin success
    res = client.get("/admin/stats", headers=admin["headers"])
    assert res.status_code == 200
    data = res.json()
    assert "total_users" in data
    assert "total_students" in data
    assert "total_faculty" in data
    assert "total_subjects" in data
    assert "total_classes" in data
    assert data["total_users"] > 0
