# Smart Campus AI

## Project overview

Smart Campus AI is a campus-management project with a React web portal, two
API implementations (Express and FastAPI), and a Flutter mobile client. The
web portal uses Express; the Flutter app uses FastAPI. Both APIs use MongoDB
collections for application data.

### Problem statement

Campus services such as student records, attendance, timetables, notices, and
support workflows are often split across separate tools. This project brings
the implemented student, faculty, and administrator workflows into a shared
campus application.

### Objectives

- Provide role-aware web and mobile access to campus services.
- Support student, faculty, and administrator workflows through authenticated
  APIs.
- Surface attendance and academic information with clear data scope and
  explainable rules.
- Keep local development and test data isolated from production databases.

## Technologies

- Web: React, Vite, JavaScript
- Express API: Node.js, Express, MongoDB driver, JWT, Argon2
- FastAPI: Python, FastAPI, PyMongo
- Mobile: Flutter, Dart, HTTP client, secure token storage
- Database: MongoDB
- Tests: Node's built-in test runner, pytest, and Flutter test

## Main campus modules

The source includes authentication and student linking, profiles and staff
student-directory access, attendance, timetables, notifications, library
catalog and loans, transport routes and assignments, complaints, and
lost-and-found reports and matching. Administrative workflows include account
and role management, student linking, and academic interventions.

Academic Intelligence provides explainable, rule-based attendance and academic
indicators; it is not a trained predictive model. The campus assistant has
record-grounded chat, timetable/free-time support, study and placement tools,
and optional external AI-provider adapters. Assistant document, mood
check-in/analytics, and lost-and-found workflows are implemented in the source;
availability varies by client and configuration.

## Folder structure

```text
backend/       FastAPI API, services, seed/maintenance scripts, and tests
backend_node/  Express API, scripts, and tests
web/           React/Vite web portal and tests
mobile_app/    Flutter application, Android configuration, and tests
```

## Architecture

- `web/` is the React/Vite portal and uses the Express API under `/api`.
- `backend_node/` is the Express API for the portal. It connects lazily to MongoDB.
- `backend/` is the FastAPI service used by the Flutter app and also exposes
  additional assistant and academic workflows.
- `mobile_app/` is the Flutter client. The Android emulator reaches the host
  FastAPI service at `10.0.2.2:8000`.
- Both backend implementations use MongoDB collections with compatible student, user, attendance, and timetable document shapes. Keep local work isolated to `smart_campus_test`.

### Web frontend

The React portal provides role-based student, faculty, and admin views for
profiles, attendance, timetables, academic reports, directory access, library,
transport, complaints, lost-and-found, notifications, and assistant workflows.
Vite proxies `/api` requests to Express during local development.

### Backend services and database

Express serves the web API under `/api`; FastAPI serves the mobile API and
additional assistant, study-document, mood, and lost-and-found analysis routes.
Both connect to MongoDB, with local examples configured for the isolated
`smart_campus_test` database. They do not automatically share one running
process; start the API that the chosen client is configured to use.

### Flutter mobile application

`mobile_app/` contains the Flutter/Dart client, Android project configuration,
authentication and secure token storage, API services, role-aware dashboards,
and screens for the implemented campus workflows. Its API URL is configurable
with `API_BASE_URL`; Android emulators use the host alias `10.0.2.2`.

## Prerequisites

- Node.js and npm
- MongoDB running locally on port `27017`
- Python 3.10 or later and the FastAPI runtime dependencies. The repository
  currently contains only an optional `backend/requirements-assistant-documents.txt`
  manifest (PDF support), not a complete FastAPI dependency lock/manifest.
- Flutter with Dart SDK `3.13.3` or later for mobile development
- Android Studio or another Flutter-supported device target for running the mobile app

Do not use production database credentials for development. Never put secrets in the web application's environment.

## Safe local setup

The Express example configuration targets the isolated local `smart_campus_test` database. From PowerShell:

```powershell
Set-Location .\backend_node
Copy-Item .env.example .env
```

Set a private `JWT_SECRET` in `backend_node/.env`. Keep `MONGO_URI` on a local MongoDB host and `MONGO_DB_NAME=smart_campus_test`; do not enable `MONGO_ALLOW_PRODUCTION`.
Use that same locally generated secret in `backend/.env`: Express and FastAPI
both issue and validate HS256 bearer tokens. The example file intentionally
leaves `JWT_SECRET` blank so a copied example cannot become a signing key.

The FastAPI backend reads `JWT_SECRET`, `JWT_ALGORITHM`, `TOKEN_EXPIRE_MINUTES`,
`MONGO_URL` and `MONGO_DB_NAME` from `backend/.env`. It defaults to the isolated
`smart_campus_test` database; set these values in that ignored local file before
starting it:

```powershell
Set-Location .\backend
Copy-Item .env.example .env
..\.venv\Scripts\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

For optional PDF study-document extraction, install the additional dependency
from the backend environment with
`python -m pip install -r requirements-assistant-documents.txt`.

The existing student sample-data seeder is dry-run by default and is pinned to this local test database:

```powershell
Set-Location .\backend
..\.venv\Scripts\python.exe seed_demo_students.py
```

It reports the planned inserts and does not write unless explicitly run with `--apply`.

The connected MCA Karnataka demo seeder is also dry-run by default and is pinned
to `127.0.0.1:27017/smart_campus_test`:

```powershell
Set-Location .\backend
..\.venv\Scripts\python.exe seed_karnataka_demo_academics.py
..\.venv\Scripts\python.exe seed_karnataka_demo_academics.py --apply
```

It preserves existing student IDs and seeds the next available demo range
(`20260MCA0021`–`20260MCA0040`), with connected faculty, subject, class,
enrollment, timetable, attendance, and assessment records. All seed-owned
records are marked `is_demo: true`. New account passwords are random, hashed,
and never printed; provision sign-in credentials through an approved process.

The approved student integrity maintenance utility also defaults to read-only dry-run:

```powershell
..\.venv\Scripts\python.exe repair_student_integrity.py
```

Only after reviewing its report and approving the changes, run it with `--apply`.
It is pinned to `localhost:27017/smart_campus_test` and modifies only approved
student names and student indexes; it does not touch user, attendance, or timetable
collections.

## Start the Express API and web portal

Start the API in one PowerShell terminal:

```powershell
Set-Location .\backend_node
npm install
npm run dev
```

Start the web client in another:

```powershell
Set-Location .\web
npm install
npm run dev
```

Open the Vite URL shown in the terminal (normally `http://localhost:5173`). Vite proxies `/api` to the Express API at `http://127.0.0.1:4000`. `VITE_API_BASE_URL` can override the API base.

## Start the Flutter application

Run the FastAPI service with the local environment described above, then:

```powershell
Set-Location .\mobile_app
flutter pub get
flutter run
```

The mobile API URL can be overridden with `--dart-define=API_BASE_URL=http://<host>:8000`. For the Android emulator, the default is `http://10.0.2.2:8000`.

## Environment variable names

- Express: `PORT`, `NODE_ENV`, `JWT_SECRET`, `JWT_ALGORITHM`, `TOKEN_EXPIRE_MINUTES`, `MONGO_URI`, `MONGO_DB_NAME`, `MONGO_ALLOW_PRODUCTION`
- FastAPI: `JWT_SECRET`, `JWT_ALGORITHM`, `TOKEN_EXPIRE_MINUTES`, `MONGO_URL`, `MONGO_DB_NAME`
- Optional FastAPI assistant providers: `AI_PROVIDER`, `AI_API_KEY`, `AI_API_BASE`, `AI_MODEL`, and optionally `TAVILY_API_KEY` for consent-based placement research
- Lost-and-found integration: `LOST_FOUND_AI_BASE_URL`, `LOST_FOUND_INTERNAL_KEY`, and match thresholds in `backend_node/.env.example`; configure the matching internal key privately for the FastAPI service too
- Express academic-intelligence gateway: `FASTAPI_BASE_URL` (defaults to `http://127.0.0.1:8000`)
- Web: `VITE_API_BASE_URL`
- Flutter: `API_BASE_URL` (Dart define)

Example files contain placeholders only. Do not copy secret values into source control, support messages, or the web build.

## API overview

The Express API is mounted at `/api`:

- Authentication: `/auth/register`, `/auth/login`, `/auth/me`
- Library: `/library/books`, `/library/loans`, borrow/return actions, and admin catalog/inventory management
- Transport: `/transport/routes`, `/transport/me`, route management, and admin-managed student assignments
- Students: `/students`, `/students/me`
- Attendance: `/attendance/me`, `/attendance/summary`, `/attendance/sessions`, `/attendance/records`
- Timetable: `/timetable`, `/timetable/today`
- Notifications: `/notifications`, `/notifications/check-weekly`
- Campus assistant: `/assistant/chat`, `/assistant/free-time`
- Academic intelligence: `/academic-intelligence/overview`, `/academic-intelligence/students/{student_id}`, `/academic-intelligence/interventions`, `/academic-intelligence/mentor`
- Complaints and case management: `/complaints`
- Lost-and-found reports, matches, claims, and status actions: `/lost-found`
- Administration: `/admin/users`, `/admin/stats`, user role/subject/link management, and one-time student link codes
- Health: `/health`

The FastAPI service also exposes authentication, student, attendance,
timetable, notifications, assistant and assistant-document/mood workflows,
academic intelligence, library, transport, complaints, and lost-and-found
routes for supported clients. Student-directory requests require
authentication; student-role users receive only their own linked student
record, while staff roles retain directory access.

Assistant document text is processed locally by the document tools. Optional
AI-provider chat and explicitly consented placement research have separate
external-service configuration; review the data sent to any provider before
enabling it.

### Academic Intelligence

The module is an explainable rule-based baseline, not a trained machine-learning model. It flags attendance below 75% for review and below 60% as high-priority, identifies supported internal-mark indicators, and compares recent with earlier attendance only when at least four dated sessions exist. Each report includes the reasons and data limitations behind its classification. The React API forwards authenticated `/api/academic-intelligence/*` requests to FastAPI using the same bearer token; FastAPI remains the single source of analysis and authorization.

Available routes:

- `GET /academic-intelligence/me` and `POST /academic-intelligence/mentor`: the authenticated student's linked record only.
- `GET /academic-intelligence/overview`: admin view, or faculty view restricted to scheduled/assigned subjects and student IDs with non-demo academic records in those subjects.
- `GET /academic-intelligence/students/{student_id}`: admin access, faculty class/subject-scope access, or the student's own record. Faculty reports include only their assigned subjects.
- `GET|POST /academic-intelligence/interventions` and `PATCH /academic-intelligence/interventions/{id}`: staff mentoring notes and follow-up status, checked against the same class scope.

The synthetic MCA demo cohort includes sections, enrollments, internal assessment marks, and attendance suitable for checking the portal flows. It is not labelled predictive-outcome data: model evaluation remains `not_evaluated` and the assistant does not claim trained predictions. Faculty access is limited to assigned subjects/classes and authorized student records. The student mentor returns guidance based on the linked student's database report and identifies missing information instead of inventing it. Use only `smart_campus_test` for local work and synthetic demonstrations.

Administrators may omit `student_id` when creating a FastAPI student with `POST /students`. The API assigns the next `YYYY0<department-code><sequence>` ID (`B.Tech` uses `BTECH`) through an atomic counter and returns it in the response. Explicit IDs remain supported.

Library catalog and borrowing requests require authentication. Students and faculty can search the catalog, borrow available copies, return their own loans, and view their borrowing history. Administrators can add catalog books and update copy counts; inventory cannot be reduced below active loans. Each account may have at most five active loans, with a 14-day loan period. Express serves React at `/api/library`; FastAPI serves Flutter at `/library`.

Transport routes use the existing `transport_routes` collection. Route records hold bus and registration numbers, pickup/drop points, driver details, capacity, and embedded student assignments. Authenticated users can view routes; only administrators can create, edit, delete, or assign students. Students can view only their own transport assignment. Driver contact details and assigned student rosters are restricted to administrators. Route assignments require an existing student record and a seat, and routes with assignments cannot be deleted or reduced below their assignment count. Express serves React at `/api/transport`; FastAPI serves Flutter at `/transport`. No bus or student assignments are seeded automatically.

Students can redeem an admin-issued one-time link code from the React Profile page or the Flutter Profile screen. The web client uses `/auth/me/link-student` through Express; Flutter uses `/me/link-student` on FastAPI.

## Tests and checks

Run from the relevant project directory:

```powershell
# Express API (tests use mocked collections)
Set-Location .\backend_node
npm test

# FastAPI route tests use mocked collections; integration tests remain pinned to smart_campus_test
Set-Location ..\backend
..\.venv\Scripts\python.exe -m pytest -q tests\test_library_routes.py tests\test_transport_routes.py

# Express transport route tests use mocked collections
Set-Location ..\backend_node
node --test tests\transport.test.js

# React transport validation tests
Set-Location ..\web
node --test tests\transport.test.js

# React
Set-Location ..\web
npm run lint
npm run build

# FastAPI
Set-Location ..\backend
..\.venv\Scripts\python.exe -m pytest -q

# Focused student seed tests
..\.venv\Scripts\python.exe -m pytest -q tests\test_seed_demo_students.py
..\.venv\Scripts\python.exe -m pytest -q tests\test_student_integrity.py tests\test_student_route_validation.py

# Web directory search/filter/pagination tests
Set-Location ..\web
npm test

# Flutter
Set-Location ..\mobile_app
flutter analyze
flutter test
```

FastAPI integration tests use `smart_campus_test` and create test users/student fixtures; attendance and timetable integration tests also insert records without automatic cleanup. Run those integration tests only when their database side effects are acceptable. Focused mocked/unit tests do not write to MongoDB.

## Known limitations and future enhancements

- Events are not backed by a campus API; any event preview is not a live events
  workflow. Some mobile feature previews may be less complete than the web
  portal and APIs.
- The FastAPI base runtime dependencies are not yet captured in a complete
  requirements manifest; only the optional PDF dependency has a requirements
  file.
- Without an AI provider configured, the assistant uses its grounded fallback
  behavior. Optional provider calls require private credentials and may send
  the relevant prompt/context to that provider.
- Student search and filters run client-side over the authenticated staff directory response. This is appropriate for the current 900-record demo set; server-side pagination can be added if the directory grows substantially.
- Verify local database connection settings, device-specific Flutter networking, and role-specific workflows manually before a live demonstration.
- Evaluate academic-intelligence rules against reviewed data before making
  predictive claims, add server-side directory pagination if needed, and
  complete any remaining preview-only mobile workflows. Add a complete,
  maintained FastAPI dependency manifest for reproducible fresh installations.
