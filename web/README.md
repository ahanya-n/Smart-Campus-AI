# Smart Campus web application

The React/Vite web client integrates with the Express API for authentication and
the implemented student, attendance, timetable, notifications, assistant, and
admin features. It does not display fabricated campus records. Library,
Transport, Complaints, and Events screens are not presented because the
existing FastAPI source defines no corresponding APIs.

## Run locally

Open separate PowerShell terminals from the project root.

Express API:

```powershell
Set-Location .\backend_node
Copy-Item .env.example .env
npm run dev
```

React client:

```powershell
Set-Location .\web
Copy-Item .env.example .env
npm run dev
```

Open the Vite address shown in the terminal (normally
`http://localhost:5173`). Vite proxies `/api` to
`http://127.0.0.1:4000`. Change `VITE_API_BASE_URL` in the local web `.env`
only when using a different API base. Do not put JWT or MongoDB secrets in the
web environment; secrets belong only in the backend `.env`.

The browser keeps the access token in `sessionStorage` for the current tab and
never stores passwords. The Express API uses a lazy MongoDB connection;
`GET /api/health` does not connect to MongoDB. For development, the backend
example points to the isolated `smart_campus_test` database.

## Link a student account

Student accounts are not matched to student records by email. A college
administrator must issue a one-time code for the student's existing student
ID from **Administration → Issue a student link code**, then provide the code
to that student privately. The student opens **My profile** (or the dashboard's
**Link my student record** action), enters that same student ID and code, and
submits the form. Codes expire after seven days and can be redeemed once.
Successful linking refreshes the student's profile, attendance, timetable,
notifications, and assistant data. No student record is created by linking.

## Quality checks

```powershell
npm run lint
npm run build
```
