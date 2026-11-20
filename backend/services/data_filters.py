LOCAL_DEMO_SEED_MARKER = "smart-campus-local-demo-v1"


def non_synthetic_filter() -> dict:
    return {
        "is_demo": {"$ne": True},
        "synthetic_demo": {"$ne": True},
    }


def is_local_demo_account(user: dict | None) -> bool:
    return bool(user and user.get("local_demo_seed") == LOCAL_DEMO_SEED_MARKER)


def is_local_demo_student(student: dict | None) -> bool:
    return bool(student and student.get("local_demo_seed") == LOCAL_DEMO_SEED_MARKER)


def visible_academic_filter(owner: dict | None) -> dict:
    if is_local_demo_account(owner) or is_local_demo_student(owner):
        return {"is_demo": True, "synthetic_demo": True}
    return non_synthetic_filter()
