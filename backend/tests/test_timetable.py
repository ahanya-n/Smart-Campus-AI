def test_create_and_query_timetable_entry(client, admin, test_students, run_id):
    dept = test_students["department"]
    sem = test_students["semester"]
    subj = test_students["subject"]
    room = f"R{run_id}1"

    # Admin creates entry
    create_res = client.post(
        "/timetable",
        headers=admin["headers"],
        json={
            "department": dept,
            "semester": sem,
            "day_of_week": "Monday",
            "subject_code": subj,
            "subject_name": "Distributed Systems",
            "start_time": "10:00",
            "end_time": "11:00",
            "faculty_name": "Prof Alan Turing",
            "room_number": room,
        },
    )
    assert create_res.status_code == 201
    entry = create_res.json()
    assert entry["subject_code"] == subj
    entry_id = entry["id"]

    try:
        # Query timetable for Monday
        monday_res = client.get(f"/timetable?day=Monday&department={dept}&semester={sem}", headers=admin["headers"])
        assert monday_res.status_code == 200
        mon_data = monday_res.json()
        assert any(e["id"] == entry_id for e in mon_data["entries"])

        # Query for Tuesday has none of this
        tue_res = client.get(f"/timetable?day=Tuesday&department={dept}&semester={sem}", headers=admin["headers"])
        assert tue_res.status_code == 200
        assert not any(e["id"] == entry_id for e in tue_res.json()["entries"])
    finally:
        client.delete(f"/timetable/{entry_id}", headers=admin["headers"])

def test_sunday_timetable_query_returns_empty_schedule(client, admin):
    response = client.get("/timetable?day=Sunday", headers=admin["headers"])

    assert response.status_code == 200
    assert response.json()["day"] == "Sunday"
    assert response.json()["entries"] == []


def test_timetable_conflict_detection(client, admin, test_students, run_id):
    dept = test_students["department"]
    sem = test_students["semester"]
    subj = test_students["subject"]
    room = f"R{run_id}2"

    # Create slot 14:00 - 15:00
    res1 = client.post(
        "/timetable",
        headers=admin["headers"],
        json={
            "department": dept,
            "semester": sem,
            "day_of_week": "Wednesday",
            "subject_code": subj,
            "subject_name": "Network Security",
            "start_time": "14:00",
            "end_time": "15:00",
            "faculty_name": "Dr Alice",
            "room_number": room,
        },
    )
    assert res1.status_code == 201
    e1_id = res1.json()["id"]

    try:
        # Overlapping slot for same room: 14:30 - 15:30 -> conflict!
        res2 = client.post(
            "/timetable",
            headers=admin["headers"],
            json={
                "department": f"{dept}X",
                "semester": sem,
                "day_of_week": "Wednesday",
                "subject_code": f"S{run_id[:5]}",
                "subject_name": "Other Course",
                "start_time": "14:30",
                "end_time": "15:30",
                "faculty_name": "Dr Bob",
                "room_number": room,
            },
        )
        assert res2.status_code == 409
        assert "Schedule conflict" in res2.json()["detail"]
    finally:
        client.delete(f"/timetable/{e1_id}", headers=admin["headers"])


def test_timetable_update_and_delete(client, admin, test_students, run_id):
    dept = test_students["department"]
    sem = test_students["semester"]
    subj = test_students["subject"]
    room1 = f"R{run_id}3"
    room2 = f"R{run_id}4"

    create_res = client.post(
        "/timetable",
        headers=admin["headers"],
        json={
            "department": dept,
            "semester": sem,
            "day_of_week": "Friday",
            "subject_code": subj,
            "subject_name": "Cloud Computing",
            "start_time": "11:00",
            "end_time": "12:00",
            "faculty_name": "Dr Cloud",
            "room_number": room1,
        },
    )
    assert create_res.status_code == 201
    entry_id = create_res.json()["id"]

    # Update room number
    update_res = client.put(
        f"/timetable/{entry_id}",
        headers=admin["headers"],
        json={
            "department": dept,
            "semester": sem,
            "day_of_week": "Friday",
            "subject_code": subj,
            "subject_name": "Cloud Computing",
            "start_time": "11:00",
            "end_time": "12:00",
            "faculty_name": "Dr Cloud",
            "room_number": room2,
        },
    )
    assert update_res.status_code == 200
    assert update_res.json()["room_number"] == room2

    # Delete entry
    del_res = client.delete(f"/timetable/{entry_id}", headers=admin["headers"])
    assert del_res.status_code == 204


def test_timetable_demo_mode(client, accounts):
    student = accounts.make("student")

    res = client.get("/timetable?demo=true", headers=student["headers"])
    assert res.status_code == 200
    data = res.json()
    assert data["is_demo"] is True


def test_timetable_validation(client, admin, test_students, run_id):
    dept = test_students["department"]
    sem = test_students["semester"]
    subj = test_students["subject"]
    room = f"R{run_id}5"

    # End time before start time
    invalid_time = client.post(
        "/timetable",
        headers=admin["headers"],
        json={
            "department": dept,
            "semester": sem,
            "day_of_week": "Monday",
            "subject_code": subj,
            "subject_name": "Physics",
            "start_time": "11:00",
            "end_time": "10:00",
            "faculty_name": "Dr Strange",
            "room_number": room,
        },
    )
    assert invalid_time.status_code == 422


def test_student_cannot_modify_timetable(client, accounts, test_students, run_id):
    student = accounts.make("student")
    dept = test_students["department"]
    sem = test_students["semester"]
    subj = test_students["subject"]
    room = f"R{run_id}6"

    res = client.post(
        "/timetable",
        headers=student["headers"],
        json={
            "department": dept,
            "semester": sem,
            "day_of_week": "Monday",
            "subject_code": subj,
            "subject_name": "Math",
            "start_time": "09:00",
            "end_time": "10:00",
            "faculty_name": "Prof",
            "room_number": room,
        },
    )
    assert res.status_code == 403
