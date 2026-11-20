"""Account administration for Smart Campus (run on the server machine).

This is the safe way to create the first admin: it needs direct access to this
computer and its database, which a public API caller never has. Passwords are
typed hidden (or piped with --password-stdin) and are never printed.

Run from the backend folder, for example:
    .venv\\Scripts\\python.exe manage_users.py create --role admin --name "Campus Admin" --email admin@college.edu
    .venv\\Scripts\\python.exe manage_users.py set-role --email someone@college.edu --role faculty
    .venv\\Scripts\\python.exe manage_users.py assign-subjects --email faculty@college.edu --subjects MCA401,MCA402
    .venv\\Scripts\\python.exe manage_users.py link-student --email student@college.edu --student-id MCA001
    .venv\\Scripts\\python.exe manage_users.py list
"""

import argparse
import getpass
import sys

from database import ensure_indexes, users_collection
from services.user_service import (
    UserError,
    create_user,
    find_user_by_email,
    link_student,
    set_assigned_subjects,
    set_role,
    validate_password,
)
from validators import ROLES


def read_password(from_stdin: bool) -> str:
    if from_stdin:
        password = sys.stdin.readline().rstrip("\r\n")
    else:
        password = getpass.getpass("New password (hidden): ")
        if getpass.getpass("Repeat password: ") != password:
            raise UserError(422, "Passwords do not match")
    validate_password(password)
    return password


def require_user(email: str) -> dict:
    user = find_user_by_email(email)
    if user is None:
        raise UserError(404, f"No account with email {email}")
    return user


def describe(user: dict) -> str:
    parts = [f"{user['name']} <{user['email']}> role={user['role']}"]
    if user.get("student_id"):
        parts.append(f"student_id={user['student_id']}")
    if user.get("assigned_subject_codes"):
        parts.append("subjects=" + ",".join(user["assigned_subject_codes"]))
    return " ".join(parts)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Smart Campus account administration")
    sub = parser.add_subparsers(dest="command", required=True)

    create = sub.add_parser("create", help="Create an account")
    create.add_argument("--role", choices=ROLES, required=True)
    create.add_argument("--name", required=True)
    create.add_argument("--email", required=True)
    create.add_argument("--password-stdin", action="store_true",
                        help="Read the password from standard input instead of a hidden prompt")

    role = sub.add_parser("set-role", help="Change an existing account's role")
    role.add_argument("--email", required=True)
    role.add_argument("--role", choices=ROLES, required=True)

    subjects = sub.add_parser("assign-subjects", help="Set a faculty member's subject codes")
    subjects.add_argument("--email", required=True)
    subjects.add_argument("--subjects", required=True, help="Comma-separated, e.g. MCA401,MCA402")

    link = sub.add_parser("link-student", help="Link a student account to a student record")
    link.add_argument("--email", required=True)
    link.add_argument("--student-id", help="Omit together with --unlink to remove the link")
    link.add_argument("--unlink", action="store_true")

    sub.add_parser("list", help="List accounts (no passwords)")

    args = parser.parse_args(argv)
    ensure_indexes()

    try:
        if args.command == "create":
            password = read_password(args.password_stdin)
            user = create_user(args.name, args.email, password, args.role)
            print(f"Created: {describe(user)}")
        elif args.command == "set-role":
            user = require_user(args.email)
            print(f"Updated: {describe(set_role(str(user['_id']), args.role))}")
        elif args.command == "assign-subjects":
            user = require_user(args.email)
            codes = [c for c in args.subjects.split(",") if c.strip()]
            print(f"Updated: {describe(set_assigned_subjects(str(user['_id']), codes))}")
        elif args.command == "link-student":
            if not args.unlink and not args.student_id:
                raise UserError(422, "Give --student-id, or --unlink")
            user = require_user(args.email)
            student_id = None if args.unlink else args.student_id.strip()
            print(f"Updated: {describe(link_student(str(user['_id']), student_id))}")
        elif args.command == "list":
            for user in users_collection.find({}, {"password": 0}).sort("role", 1):
                user.setdefault("role", "student")
                print(describe(user))
    except UserError as error:
        print(f"Error: {error.detail}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
