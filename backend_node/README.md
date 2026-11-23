# Smart Campus Express API

The Express service is being expanded alongside the existing FastAPI service
and Flutter application. It uses the existing MongoDB collections and schemas;
it does not create indexes, run migrations, or seed records.

## Local setup

From this folder:

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Set a private `JWT_SECRET` in the untracked local `.env`; do not commit it.
Generate a high-entropy value locally (for example,
`node -p "require('node:crypto').randomBytes(64).toString('hex')"`). Use the
same value in `backend/.env` when running FastAPI, because both services issue
and validate HS256 bearer tokens. The Express server locates
`backend_node/.env` relative to its source file, so startup does not depend on
the shell's current directory.
The example config points to `mongodb://127.0.0.1:27017` and the isolated
`smart_campus_test` database. Keep the URI and database isolated when testing.
The existing `smart_campus` database is refused unless
`MONGO_ALLOW_PRODUCTION=true` is explicitly supplied. Do not set that flag for
development or tests.

## Seed development login accounts

Run this only against the local MongoDB instance. The script is pinned to
`127.0.0.1:27017/smart_campus_test`, checks all three email conflicts before
writing, and creates the linked synthetic student profile. It does not update
existing passwords or print passwords.

From `backend_node`, run:

```powershell
npm run seed:login-demo
```

The script prompts for the administrator, faculty, and student passwords with
hidden terminal input. For automation, set `DEMO_ADMIN_PASSWORD`,
`DEMO_FACULTY_PASSWORD`, and `DEMO_STUDENT_PASSWORD` only in the current
process environment. Do not put these credentials in source files or command
history.

MongoDB is connected lazily on the first database-backed request. Importing
the app or requesting `GET /api/health` does not connect to MongoDB. No
collections are dropped and no index creation is performed by this API.

If a database-backed request reports that MongoDB is not configured, confirm
that `backend_node/.env` exists and contains `MONGO_URI` and `MONGO_DB_NAME`.
Without those settings, registration cannot reach the `users` collection.
Database configuration and connection failures are returned as safe `503`
responses; their internal details are not sent to the browser.

## Provision the first isolated test administrator

Admin provisioning is an explicit, one-time command. It is never run during
server startup or public registration. The script refuses to continue unless
the configured database is exactly `smart_campus_test`, the MongoDB URI uses
only local hosts (`localhost`, `127.0.0.1`, or `::1`), and no admin account
already exists. It also refuses any email already used by an account; it does
not promote or overwrite student/faculty accounts.

From `backend_node`, run:

```powershell
npm run provision:admin
```

The script prompts for the admin name and email, then prompts for the password
with terminal input hidden. Alternatively, set `ADMIN_NAME`, `ADMIN_EMAIL`,
and `ADMIN_PASSWORD` in the process environment before running the command.
Do not place credentials in command-line arguments or commit them. The script
uses the existing Argon2id password hasher and the existing `users` document
schema, and reports no password, JWT secret, or database URI. It does not
create indexes, seed data, or modify existing users. **Do not run this command
until you intend to create the administrator account.**

## Set up an additional local development administrator

Use this separate command when `smart_campus_test` already contains admin
accounts. Unlike `provision:admin`, it allows adding a distinct development
account, but never edits or promotes an existing account. It refuses to run
unless the configured database is exactly `smart_campus_test` and every host
in the MongoDB URI is `localhost`, `127.0.0.1`, or `::1`.

From `backend_node`, run:

```powershell
npm run setup:dev-admin
```

Enter the administrator name and email when prompted, then enter the password
at the hidden prompt. The command checks that the email is unused, hashes the
password with the existing Argon2id helper, and displays a proposal containing
only the database target, local-host indicator, operation, name, email, and
role. No document is written unless you then type exactly `CREATE ADMIN` at
the confirmation prompt. Any other response cancels without inserting.

The script inserts one new user document with the existing schema and does
not create indexes or modify other records. It does not print credentials,
password hashes, JWT secrets, or the MongoDB URI. Do not put the password in
command-line arguments or commit it in a file.

## Authentication and API routes

All routes below are mounted under `/api`. Protected routes accept an HS256
bearer token from `POST /auth/login`.

### Authentication and student

| Method | Route | Access |
| --- | --- | --- |
| GET | `/health` | Public; MongoDB-independent |
| POST | `/auth/register` | Public; always creates student |
| POST | `/auth/login` | Public |
| GET | `/auth/me` | Authenticated |
| POST | `/auth/me/link-student` | Student; one-time link code |
| GET | `/students/me` | Student; linked profile |
| GET | `/students` | Authenticated; student gets only own linked record, staff get directory |

### Attendance

| Method | Route | Access |
| --- | --- | --- |
| GET | `/attendance/me` | Authenticated student; `?demo=true` for labelled demo data |
| GET | `/attendance/summary` | Authenticated student; same demo option |
| POST | `/attendance/sessions` | Faculty assigned to subject, or admin |
| GET | `/attendance/sessions` | Faculty assigned to subject, or admin |
| PATCH | `/attendance/entries/:entry_id` | Faculty assigned to entry subject, or admin |
| GET | `/attendance/records` | Faculty assigned subjects, or admin |
| GET | `/attendance/students/:student_id` | Faculty assigned subjects, or admin |

Attendance entry uniqueness follows the student, subject, date, and start-time
key used by FastAPI. Re-submitting a session updates changed statuses without
creating duplicate marks. Aggregates are recomputed from official entries.

### Timetable

| Method | Route | Access |
| --- | --- | --- |
| GET | `/timetable` | Authenticated; student group, faculty scope, or admin scope |
| GET | `/timetable/today` | Authenticated |
| POST | `/timetable` | Faculty assigned to subject, or admin |
| PUT | `/timetable/:entry_id` | Faculty assigned to existing and new subject, or admin |
| DELETE | `/timetable/:entry_id` | Faculty assigned to existing subject, or admin |

Writes reject overlapping class-group, room, or faculty schedules. Demo entries
are read-only.

### Notifications

| Method | Route | Access |
| --- | --- | --- |
| GET | `/notifications` | Authenticated; derives the linked student from the token |
| POST | `/notifications/check-weekly` | Faculty or admin; threshold and week may be queried |
| PATCH | `/notifications/:notification_id/read` | Authenticated linked student; own notification only |

### Assistant

| Method | Route | Access |
| --- | --- | --- |
| POST | `/assistant/chat` | Authenticated; grounded rule-based answers |
| GET | `/assistant/free-time` | Authenticated; verified timetable-derived intervals |

The Express assistant uses a deterministic rule engine over the authenticated
student's records. It does not call an external LLM provider.

### Admin and faculty management

| Method | Route | Access |
| --- | --- | --- |
| GET | `/admin/users` | Admin |
| POST | `/admin/users` | Admin |
| PATCH | `/admin/users/:user_id/role` | Admin; protects self and last admin |
| PUT | `/admin/users/:user_id/subjects` | Admin; faculty accounts only |
| PUT | `/admin/users/:user_id/student-link` | Admin |
| POST | `/admin/students/:student_id/link-code` | Admin; one-time code |
| GET | `/admin/stats` | Admin |

The source FastAPI application defines no dedicated Library, Transport,
Complaints, or Events CRUD routes. Their collections are used only for the
existing admin statistics, so the Express API does not invent those operations.

## Web application

From the project root, run the Express server in one terminal and the web app
in another:

```powershell
Set-Location .\backend_node
npm run dev
```

```powershell
Set-Location .\web
npm run dev
```

Vite proxies `/api` to `http://127.0.0.1:4000`. Set
`VITE_API_BASE_URL` to override the API base; `.env.example` uses `/api`.

## Verification

```powershell
npm test
npm audit
```

`npm test` uses mocked collections and does not connect to MongoDB.
