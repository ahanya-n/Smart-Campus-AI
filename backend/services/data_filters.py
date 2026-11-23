LOCAL_DEMO_SEED_MARKER = "smart-campus-local-demo-v1"
REALISTIC_DEMO_SEED_MARKER = "smart-campus-realistic-students-v1"
TRUSTED_DEMO_SEED_MARKERS = frozenset({
    LOCAL_DEMO_SEED_MARKER,
    REALISTIC_DEMO_SEED_MARKER,
})


def non_synthetic_filter() -> dict:
    return {
        "is_demo": {"$ne": True},
        "synthetic_demo": {"$ne": True},
    }


def is_local_demo_account(user: dict | None) -> bool:
    if not user:
        return False
    return (
        user.get("local_demo_seed") in TRUSTED_DEMO_SEED_MARKERS
        or user.get("demo_seed_key") in TRUSTED_DEMO_SEED_MARKERS
    )


def is_local_demo_student(student: dict | None) -> bool:
    if not student:
        return False
    return (
        student.get("local_demo_seed") in TRUSTED_DEMO_SEED_MARKERS
        or student.get("demo_seed_key") in TRUSTED_DEMO_SEED_MARKERS
    )


def visible_academic_filter(owner: dict | None) -> dict:
    if is_local_demo_account(owner) or is_local_demo_student(owner):
        marker_values = trusted_demo_owner_markers(owner)
        if marker_values:
            return {
                "is_demo": True,
                "synthetic_demo": True,
                "$and": [
                    {
                        "$or": [
                            {"demo_seed_key": {"$in": sorted(marker_values)}},
                            {"local_demo_seed": {"$in": sorted(marker_values)}},
                        ]
                    }
                ],
            }
        return {"is_demo": True, "synthetic_demo": True}
    return non_synthetic_filter()


def trusted_demo_owner_markers(owner: dict | None) -> frozenset[str]:
    if not owner:
        return frozenset()
    markers = []
    for field in ("local_demo_seed", "demo_seed_key"):
        marker = owner.get(field)
        if marker in TRUSTED_DEMO_SEED_MARKERS:
            markers.append(marker)
    return frozenset(markers)


def trusted_demo_record(record: dict | None) -> bool:
    if not record:
        return False
    if record.get("is_demo") is not True or record.get("synthetic_demo") is not True:
        return False
    return bool(trusted_demo_owner_markers(record))
