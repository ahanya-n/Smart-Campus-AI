# Smart Campus Management System

## Architecture

- `web/` is the React/Vite portal and uses the Express API under `/api`.
- `backend_node/` is the Express API for the portal. It connects lazily to MongoDB.
- `backend/` is the existing FastAPI service, used by the Flutter app.
- `mobile_app/` is the Flutter client. The Android emulator reaches the host FastAPI service at `10.0.2.2:8000`.
- Both backend implementations use MongoDB collections with compatible student, user, attendance, and timetable document shapes. Keep local work isolated to `smart_campus_test`.

## Prerequisites

- Node.js and npm
- MongoDB running locally on port `27017`
- Python and the existing `backend/.venv` dependencies for FastAPI
- Flutter and Dart SDKs for mobile development
- Android Studio or another Flutter-supported device target for running the mobile app

Do not use production database credentials for development. Never put secrets in the web application's environment.

## Safe local setup

The Express example configuration targets the isolated local `smart_campus_test` database. From PowerShell:

```powershell
Set-Location .\backend_node
Copy-Item .env.example .env
```

Set a private `JWT_SECRET` in `backend_node/.env`. Keep `MONGO_URI` on a local MongoDB host and `MONGO_DB_NAME=smart_campus_test`; do not enable `MONGO_ALLOW_PRODUCTION`.

The FastAPI backend reads `MONGO_URL` and `MONGO_DB_NAME`. It defaults to the isolated `smart_campus_test` database; set these variables explicitly in the same PowerShell session before starting it:

```powershell
Set-Location .\backend
$env:MONGO_URL = 'mongodb://127.0.0.1:27017/'
$env:MONGO_DB_NAME = 'smart_campus_test'
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

The existing student sample-data seeder is dry-run by default and is pinned to this local test database:

```powershell
Set-Location .\backend
.\.venv\Scripts\python.exe seed_demo_students.py
```

It reports the planned inserts and does not write unless explicitly run with `--apply`.

The connected MCA Karnataka demo seeder is also dry-run by default and is pinned
to `127.0.0.1:27017/smart_campus_test`:

```powershell
Set-Location .\backend
.\.venv\Scripts\python.exe seed_karnataka_demo_academics.py
.\.venv\Scripts\python.exe seed_karnataka_demo_academics.py --apply
```

It preserves existing student IDs and seeds the next available demo range
(`20260MCA0021`–`20260MCA0040`), with connected faculty, subject, class,
enrollment, timetable, attendance, and assessment records. All seed-owned
records are marked `is_demo: true`. New account passwords are random, hashed,
and never printed; provision sign-in credentials through an approved process.

The approved student integrity maintenance utility also defaults to read-only dry-run:

```powershell
.\.venv\Scripts\python.exe repair_student_integrity.py
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
- FastAPI: `MONGO_URL`, `MONGO_DB_NAME`
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
- Administration: `/admin/users`, `/admin/stats`, user role/subject/link management, and one-time student link codes
- Health: `/health`

The FastAPI service provides the corresponding mobile authentication, student, attendance, timetable, notification, assistant, and administration routes. Student-directory requests require authentication; student-role users receive only their own linked student record, while staff roles retain directory access.

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
.\.venv\Scripts\python.exe -m pytest -q tests\test_library_routes.py tests\test_transport_routes.py

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
.\.venv\Scripts\python.exe -m pytest -q

# Focused student seed tests
.\.venv\Scripts\python.exe -m pytest -q tests\test_seed_demo_students.py
.\.venv\Scripts\python.exe -m pytest -q tests\test_student_integrity.py tests\test_student_route_validation.py

# Web directory search/filter/pagination tests
Set-Location ..\web
npm test

# Flutter
Set-Location ..\mobile_app
flutter analyze
flutter test
```

FastAPI integration tests use `smart_campus_test` and create test users/student fixtures; attendance and timetable integration tests also insert records without automatic cleanup. Run those integration tests only when their database side effects are acceptable. Focused mocked/unit tests do not write to MongoDB.

## Known limitations and manual checks

- Complaints and events CRUD routes are not implemented; their previews do not fabricate functionality.
- The campus assistant is deterministic and grounded in available records; it does not call an external AI service.
- Student search and filters run client-side over the authenticated staff directory response. This is appropriate for the current 900-record demo set; server-side pagination can be added if the directory grows substantially.
- Verify local database connection settings, device-specific Flutter networking, and role-specific workflows manually before a live demonstration.
