from datetime import date, timedelta


def test_student_cannot_record_session(client, accounts, test_students):
    student = accounts.make("student")
    sid = test_students["ids"][0]
    res = client.post(
        "/attendance/sessions",
        headers=student["headers"],
        json={
            "subject_code": test_students["subject"],
            "subject_name": "Test Subject",
            "session_date": date.today().isoformat(),
            "start_time": "09:00",
            "records": [{"student_id": sid, "status": "present"}],
        },
    )
    assert res.status_code == 403


def test_faculty_unassigned_subject_forbidden(client, accounts, test_students):
    faculty = accounts.make("faculty", subjects=["OTHER101"])
    sid = test_students["ids"][0]
    res = client.post(
        "/attendance/sessions",
        headers=faculty["headers"],
        json={
            "subject_code": test_students["subject"],
            "subject_name": "Test Subject",
            "session_date": date.today().isoformat(),
            "start_time": "09:00",
            "records": [{"student_id": sid, "status": "present"}],
        },
    )
    assert res.status_code == 403
    assert "not assigned to subject" in res.json()["detail"]


def test_record_session_and_duplicate_prevention(client, accounts, test_students):
    subj = test_students["subject"]
    faculty = accounts.make("faculty", subjects=[subj])
    sid1 = test_students["ids"][0]
    sid2 = test_students["ids"][1]
    today_str = date.today().isoformat()

    # Session 1: Mark attendance
    res1 = client.post(
        "/attendance/sessions",
        headers=faculty["headers"],
        json={
            "subject_code": subj,
            "subject_name": "Test Subject",
            "session_date": today_str,
            "start_time": "09:00",
            "records": [
                {"student_id": sid1, "status": "present"},
                {"student_id": sid2, "status": "absent"},
            ],
        },
    )
    assert res1.status_code == 200
    data1 = res1.json()
    assert data1["created"] == 2
    assert data1["updated"] == 0

    # Resubmit same session with sid2 changed from absent to present
    res2 = client.post(
        "/attendance/sessions",
        headers=faculty["headers"],
        json={
            "subject_code": subj,
            "subject_name": "Test Subject",
            "session_date": today_str,
            "start_time": "09:00",
            "records": [
                {"student_id": sid1, "status": "present"},
                {"student_id": sid2, "status": "present"},
            ],
        },
    )
    assert res2.status_code == 200
    data2 = res2.json()
    assert data2["unchanged"] == 1  # sid1 unchanged
    assert data2["updated"] == 1    # sid2 changed to present
    assert data2["created"] == 0    # no duplicates created


def test_attendance_calculation_and_low_attendance_flag(client, accounts, test_students, make_student):
    subj = f"{test_students['subject']}C"
    faculty = accounts.make("faculty", subjects=[subj])
    sid = make_student()
    student_user = accounts.make("student", student_id=sid)

    # Add 4 sessions: 1 present, 3 absent (25% attendance -> should trigger low_attendance)
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    two_days_ago = (date.today() - timedelta(days=2)).isoformat()
    three_days_ago = (date.today() - timedelta(days=3)).isoformat()
    four_days_ago = (date.today() - timedelta(days=4)).isoformat()

    dates_statuses = [
        (yesterday, "09:00", "present"),
        (two_days_ago, "09:00", "absent"),
        (three_days_ago, "09:00", "absent"),
        (four_days_ago, "09:00", "absent"),
    ]

    for d, t, s in dates_statuses:
        client.post(
            "/attendance/sessions",
            headers=faculty["headers"],
            json={
                "subject_code": subj,
                "subject_name": "Test Calculations",
                "session_date": d,
                "start_time": t,
                "records": [{"student_id": sid, "status": s}],
            },
        )

    # Check student attendance report
    rep = client.get("/attendance/me", headers=student_user["headers"])
    assert rep.status_code == 200
    report = rep.json()
    assert report["linked"] is True
    assert report["is_demo"] is False
    assert len(report["records"]) == 1

    rec = report["records"][0]
    assert rec["total_classes"] == 4
    assert rec["present_classes"] == 1
    assert rec["absent_classes"] == 3
    assert rec["attendance_percentage"] == 25.0
    assert rec["low_attendance"] is True

    # Summary
    summary = report["summary"]
    assert summary["attendance_percentage"] == 25.0
    assert summary["low_attendance_subjects"] == ["Test Calculations"]


def test_attendance_demo_mode_toggle(client, accounts):
    unlinked_student = accounts.make("student")

    # Live call returns linked: false, no records
    live_res = client.get("/attendance/me", headers=unlinked_student["headers"])
    assert live_res.status_code == 200
    assert live_res.json()["linked"] is False

    # Demo call returns is_demo: true with pre-seeded demo records or demo flag
    demo_res = client.get("/attendance/me?demo=true", headers=unlinked_student["headers"])
    assert demo_res.status_code == 200
    assert demo_res.json()["is_demo"] is True


def test_attendance_input_validation(client, admin, test_students):
    sid = test_students["ids"][0]
    tomorrow = (date.today() + timedelta(days=1)).isoformat()

    # Future date rejected
    future_res = client.post(
        "/attendance/sessions",
        headers=admin["headers"],
        json={
            "subject_code": test_students["subject"],
            "subject_name": "Test",
            "session_date": tomorrow,
            "start_time": "09:00",
            "records": [{"student_id": sid, "status": "present"}],
        },
    )
    assert future_res.status_code == 422

    # Duplicate student in same session list rejected
    dup_res = client.post(
        "/attendance/sessions",
        headers=admin["headers"],
        json={
            "subject_code": test_students["subject"],
            "subject_name": "Test",
            "session_date": date.today().isoformat(),
            "start_time": "09:00",
            "records": [
                {"student_id": sid, "status": "present"},
                {"student_id": sid, "status": "absent"},
            ],
        },
    )
    assert dup_res.status_code == 422
