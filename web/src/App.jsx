import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE_URL, apiRequest } from './api'
import ComplaintsPage from './ComplaintsPage'
import LostAndFoundPage from './LostAndFoundPage'
import { canBorrowLibraryBook, validateBookForm } from './library'
import { filterStudentRecords, paginateStudentRecords } from './studentDirectory'
import {
  availableTransportSeats,
  parseTransportPoints,
  validateTransportAssignment,
  validateTransportRoute,
} from './transport'
import {
  availableAssistantModes,
  calculateStudyStreak,
  safeAssistantSourceUrl,
  validateAssistantFile,
} from './assistant'
import './Portal.css'

const NAV_ITEMS = [
  ['overview', 'Overview', 'OV', ['student', 'faculty', 'admin']],
  ['profile', 'My profile', 'PR', ['student']],
  ['academic-report', 'Academic report', 'AR', ['student']],
  ['students', 'Students', 'ST', ['faculty', 'admin']],
  ['attendance', 'Attendance', 'AT', ['student', 'faculty', 'admin']],
  ['timetable', 'Timetable', 'TT', ['student', 'faculty', 'admin']],
  ['library', 'Library', 'LB', ['student', 'faculty', 'admin']],
  ['transport', 'Transport', 'TR', ['student', 'faculty', 'admin']],
  ['complaints', 'Complaints', 'CM', ['student', 'admin']],
  ['lost-found', 'Lost and Found', 'LF', ['student', 'admin']],
  ['notifications', 'Notifications', 'NO', ['student', 'faculty', 'admin']],
  ['assistant', 'Campus assistant', 'AI', ['student', 'faculty']],
  ['mood-check-in', 'Mood check-in', 'MC', ['student']],
  ['mood-insights', 'Wellbeing insights', 'WI', ['faculty', 'admin']],
  ['intelligence', 'Academic intelligence', 'AC', ['faculty', 'admin']],
  ['admin', 'Administration', 'AD', ['admin']],
]

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const STATUSES = ['present', 'absent']
const DEFAULT_SESSION_DATE = new Date().toISOString().slice(0, 10)
const ASSISTANT_SUGGESTIONS = [
  'What is my attendance percentage?',
  'Which subjects have low attendance?',
  'Which subjects need improvement?',
  'Create a 7-day study plan.',
  'Explain my academic risk report.',
  'Analyze my internal marks.',
  'What should I focus on before exams?',
  'What is my timetable for today?',
  'When is my next class?',
  'When am I free today?',
  'How much free time do I have between classes?',
]
const FACULTY_ASSISTANT_SUGGESTIONS = [
  'What is my next class?',
  'Where is my next classroom?',
  'What is my timetable today?',
  'Today which hour am I free?',
  'Show my assigned subjects.',
  'Which students have attendance below 75%?',
  'Show attendance for my assigned subject.',
  'Which students need academic attention?',
  'Generate a summary of my class performance.',
]

function displayDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString()
}

function Loading({ label = 'Loading data…' }) {
  return <p className="state-message" role="status">{label}</p>
}

function ErrorMessage({ error }) {
  if (!error) return null
  const message = typeof error === 'string'
    ? error
    : error?.message || 'The request could not be completed.'
  return <div className="alert error" role="alert">{message}</div>
}

function Empty({ children }) {
  return <div className="empty-state">{children}</div>
}

const EMPTY_TRANSPORT_FORM = {
  route_number: '',
  bus_number: '',
  registration_number: '',
  pickup_points: '',
  drop_points: '',
  driver_name: '',
  driver_phone: '',
  capacity: '1',
}

function transportFormFromRoute(route) {
  return {
    route_number: route.route_number,
    bus_number: route.bus_number,
    registration_number: route.registration_number,
    pickup_points: route.pickup_points.join(', '),
    drop_points: route.drop_points.join(', '),
    driver_name: route.driver.name,
    driver_phone: route.driver.phone || '',
    capacity: String(route.capacity),
  }
}
function transportPayload(form) {
  return {
    route_number: form.route_number.trim(),
    bus_number: form.bus_number.trim(),
    registration_number: form.registration_number.trim(),
    pickup_points: parseTransportPoints(form.pickup_points),
    drop_points: parseTransportPoints(form.drop_points),
    driver: { name: form.driver_name.trim(), phone: form.driver_phone.trim() },
    capacity: Number(form.capacity),
  }
}

function TransportRouteForm({ initialValue, submitLabel, busy, onSubmit, onCancel }) {
  const [form, setForm] = useState(initialValue)
  const [error, setError] = useState('')

  function change(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }))
  }

  async function submit(event) {
    event.preventDefault()
    const validationError = validateTransportRoute(form)
    if (validationError) {
      setError(validationError)
      return
    }
    setError('')
    await onSubmit(transportPayload(form))
  }

  return (
    <form className="form-grid library-book-form" onSubmit={submit}>
      <ErrorMessage error={error} />
      {[
        ['route_number', 'Route number', 20],
        ['bus_number', 'Bus number', 20],
        ['registration_number', 'Registration number', 20],
        ['driver_name', 'Driver name', 100],
        ['driver_phone', 'Driver phone', 24],
      ].map(([field, label, maxLength]) => (
        <label key={field}>{label}
          <input
            maxLength={maxLength}
            name={field}
            onChange={change}
            required
            value={form[field]}
          />
        </label>
      ))}
      <label>Pickup points (comma-separated)
        <input maxLength="3000" name="pickup_points" onChange={change} required value={form.pickup_points} />
      </label>
      <label>Drop points (comma-separated)
        <input maxLength="3000" name="drop_points" onChange={change} required value={form.drop_points} />
      </label>
      <label>Capacity
        <input max="100" min="1" name="capacity" onChange={change} required type="number" value={form.capacity} />
      </label>
      <div className="form-actions">
        <button className="button primary" disabled={busy} type="submit">{busy ? 'Saving…' : submitLabel}</button>
        {onCancel && <button className="button secondary" disabled={busy} onClick={onCancel} type="button">Cancel</button>}
      </div>
    </form>
  )
}

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login')
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  function change(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }))
  }

  async function submit(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      if (mode === 'register') {
        await apiRequest('/auth/register', {
          method: 'POST',
          body: { name: form.name, email: form.email, password: form.password },
        })
        setMode('login')
        setForm((current) => ({ ...current, password: '' }))
        setNotice('Account created. Sign in with your new credentials.')
      } else {
        const result = await apiRequest('/auth/login', {
          method: 'POST',
          body: { email: form.email, password: form.password },
        })
        setForm((current) => ({ ...current, password: '' }))
        await onAuthenticated(result.access_token)
      }
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-intro">
        <a className="brand" href="/" aria-label="Smart Campus home">
          <span className="brand-mark">SC</span>
          <span><strong>Smart Campus</strong><small>Management portal</small></span>
        </a>
        <div className="auth-copy">
          <p className="eyebrow">SMART CAMPUS MANAGEMENT SYSTEM</p>
          <h1>Campus services, connected.</h1>
          <p>Sign in to access the academic records associated with your account.</p>
          <div className="auth-points">
            <span>Attendance and schedules</span>
            <span>Student notifications</span>
            <span>Role-based access</span>
          </div>
        </div>
        <p className="auth-footnote">Student, faculty, and administrator access</p>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <p className="eyebrow">{mode === 'login' ? 'WELCOME BACK' : 'GET STARTED'}</p>
          <h2>{mode === 'login' ? 'Sign in to your account' : 'Create a student account'}</h2>
          <p className="muted">
            {mode === 'login'
              ? 'Use your Smart Campus account credentials.'
              : 'Public registration creates a student account.'}
          </p>
          <ErrorMessage error={error} />
          {notice && <div className="alert success" role="status">{notice}</div>}
          <form className="form-stack" onSubmit={submit}>
            {mode === 'register' && (
              <label>
                Full name
                <input
                  autoComplete="name"
                  maxLength="100"
                  name="name"
                  onChange={change}
                  required
                  value={form.name}
                />
              </label>
            )}
            <label>
              Email address
              <input
                autoComplete="email"
                maxLength="254"
                name="email"
                onChange={change}
                required
                type="email"
                value={form.email}
              />
            </label>
            <label>
              Password
              <input
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                maxLength="128"
                minLength={mode === 'register' ? '8' : undefined}
                name="password"
                onChange={change}
                required
                type="password"
                value={form.password}
              />
            </label>
            <button className="button primary full" disabled={busy} type="submit">
              {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>
          <p className="auth-switch">
            {mode === 'login' ? 'New to Smart Campus?' : 'Already have an account?'}
            {' '}
            <button
              className="text-button"
              onClick={() => {
                setError('')
                setNotice('')
                setMode(mode === 'login' ? 'register' : 'login')
              }}
              type="button"
            >
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        </div>
      </section>
    </main>
  )
}

function DataTable({ columns, rows, emptyText = 'No records are available.' }) {
  if (!rows?.length) return <Empty>{emptyText}</Empty>
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{columns.map((column) => <th key={column.label}>{column.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id || row.student_id || row.subject_code || index}>
              {columns.map((column) => <td key={column.label}>{column.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Metric({ label, value, detail }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value ?? '—'}</strong>
      {detail && <small>{detail}</small>}
    </article>
  )
}

function DashboardPage({ profile, health, setPage, data, busy, error }) {
  const summary = data?.attendance?.summary
  const hasAttendanceData = summary?.total_classes > 0
  const schedule = data?.timetable?.entries || []
  const dashboard = data?.studentDashboard
  const dashboardProfile = dashboard?.profile || profile
  const dashboardAttendance = dashboard?.attendance || summary
  const attendancePercentage = dashboardAttendance?.percentage
    ?? (hasAttendanceData ? dashboardAttendance?.attendance_percentage : null)
  const todayEntries = dashboard?.timetable?.entries || schedule
  const upcomingAssignments = dashboard?.assignments?.upcoming || []
  const notifications = dashboard?.notifications || []
  const marks = dashboard?.marks || []
  const subjectPerformance = new Map()
  for (const mark of marks) {
    const score = Number(mark.score)
    const maxScore = Number(mark.max_score)
    if (!mark.subject_code || !Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) continue
    const values = subjectPerformance.get(mark.subject_code) || []
    values.push((score / maxScore) * 100)
    subjectPerformance.set(mark.subject_code, values)
  }
  const performanceRows = [...subjectPerformance.entries()].map(([code, values]) => ({
    code,
    name: marks.find((mark) => mark.subject_code === code)?.subject_name || code,
    value: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
  })).slice(0, 6)
  const firstName = dashboardProfile.name?.trim().split(/\s+/)[0] || 'Student'
  const dateLabel = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date())
  return (
    <>
      <ErrorMessage error={error} />
      {!busy && profile.role === 'student' && !dashboardProfile.student_id && (
        <section className="panel action-panel" aria-labelledby="link-profile-heading">
          <span className="icon-tile">PR</span>
          <div>
            <h2 id="link-profile-heading">Your student record is not linked</h2>
            <p>Ask your college administrator for a one-time link code, then enter it with your student ID in your profile.</p>
          </div>
          <button className="button primary" onClick={() => setPage('profile')} type="button">Link my student record</button>
        </section>
      )}
      {busy ? <Loading /> : profile.role === 'student' ? (
        <div className="student-dashboard">
          <section className="student-welcome">
            <div className="student-welcome-copy">
              <p className="eyebrow">STUDENT WORKSPACE</p>
              <h1>Good morning, {firstName} <span aria-hidden="true">☀</span></h1>
              <p>{dateLabel} · Semester {dashboardProfile.semester || '—'}</p>
            </div>
            <div className="student-profile-compact">
              <div className="profile-avatar">{firstName.slice(0, 1).toUpperCase()}</div>
              <div>
                <strong>{dashboardProfile.name || profile.name || 'Student'}</strong>
                <span>{dashboardProfile.roll_number || dashboardProfile.student_id || 'Roll number unavailable'}</span>
              </div>
            </div>
            <span className={`status-badge ${health === 'online' ? 'good' : 'muted-badge'}`}>
              <i /> API {health === 'online' ? 'online' : 'unavailable'}
            </span>
          </section>

          <section className="student-focus-banner">
            <div>
              <p>MAKE TODAY A STEP FORWARD</p>
              <h2>{todayEntries.length > 0 ? `${todayEntries.length} classes and ${dashboard?.assignments?.pending || 0} assignment(s) due.` : 'Plan today’s study time.'}</h2>
              <span>{todayEntries.length > 0 ? 'Review your schedule and keep the day moving.' : 'No classes are listed for today.'}</span>
            </div>
            <div className="focus-orb" aria-hidden="true">SC</div>
          </section>

          <section className="student-kpi-grid" aria-label="Student academic overview">
            <article className="student-kpi-card">
              <span>Attendance</span>
              <strong>{attendancePercentage == null ? '—' : `${attendancePercentage}%`}</strong>
              <small>{dashboard?.is_demo ? 'Synthetic demo data' : 'Official attendance'}</small>
            </article>
            <article className="student-kpi-card">
              <span>CGPA</span>
              <strong>{dashboard?.cgpa == null ? '—' : dashboard.cgpa}</strong>
              <small>Calculated demo equivalent</small>
            </article>
            <article className="student-kpi-card">
              <span>Assignments</span>
              <strong>{dashboard?.assignments?.pending ?? '—'}</strong>
              <small>{dashboard?.assignments?.submitted ?? 0} submitted</small>
            </article>
            <article className="student-kpi-card">
              <span>Study streak</span>
              <strong>{dashboard?.study_streak ?? 0} days</strong>
              <small>Recent present records</small>
            </article>
          </section>

          <div className="student-dashboard-grid">
            <section className="student-dashboard-card">
              <div className="section-heading">
                <div><p className="eyebrow">TODAY</p><h2>Today’s timetable</h2></div>
                <button className="text-button" onClick={() => setPage('timetable')} type="button">View all</button>
              </div>
              {todayEntries.length === 0 ? (
                <Empty>No classes are available today.</Empty>
              ) : (
                <div className="student-timetable-list">
                  {todayEntries.map((entry, index) => (
                    <article className="student-timetable-row" key={`${entry.subject_code}-${entry.start_time}-${index}`}>
                      <div className="time-marker"><strong>{entry.start_time}</strong><span>{entry.end_time}</span></div>
                      <div><strong>{entry.subject_name}</strong><span>{entry.faculty_name || 'Faculty unavailable'} · {entry.room_number || 'Room unavailable'}</span></div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="student-dashboard-card">
              <div className="section-heading">
                <div><p className="eyebrow">PERFORMANCE</p><h2>Subject performance</h2></div>
              </div>
              {performanceRows.length === 0 ? (
                <Empty>No marks are available for this student.</Empty>
              ) : (
                <div className="student-performance-chart">
                  {performanceRows.map((row) => (
                    <div className="student-performance-row" key={row.code}>
                      <div><span>{row.name}</span><strong>{row.value}%</strong></div>
                      <div className="performance-track"><span style={{ width: `${Math.max(0, Math.min(100, row.value))}%` }} /></div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="student-dashboard-card">
              <div className="section-heading">
                <div><p className="eyebrow">ASSIGNMENTS</p><h2>Upcoming work</h2></div>
              </div>
              {upcomingAssignments.length === 0 ? (
                <Empty>No upcoming assignments.</Empty>
              ) : (
                <div className="student-assignment-list">
                  {upcomingAssignments.map((assignment, index) => (
                    <article key={`${assignment.subject_code}-${assignment.title}-${index}`}>
                      <div><strong>{assignment.title}</strong><span>{assignment.subject_name || assignment.subject_code}</span></div>
                      <time>{assignment.due_date ? new Date(assignment.due_date).toLocaleDateString() : 'No due date'}</time>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="student-dashboard-card">
              <div className="section-heading">
                <div><p className="eyebrow">UPDATES</p><h2>Notifications</h2></div>
                <button className="text-button" onClick={() => setPage('notifications')} type="button">View all</button>
              </div>
              {notifications.length === 0 ? (
                <Empty>No notifications.</Empty>
              ) : (
                <div className="student-notification-list">
                  {notifications.slice(0, 4).map((notice, index) => (
                    <article key={`${notice.title}-${index}`}>
                      <strong>{notice.title}</strong>
                      <span>{notice.message}</span>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      ) : (
        <section className="metric-grid" aria-label="Campus overview">
          {profile.role === 'admin' ? (
            Object.entries(data?.stats || {}).map(([key, value]) => (
              <Metric key={key} label={key.replaceAll('_', ' ')} value={value} />
            ))
          ) : (
            <>
              <Metric label="Assigned subjects" value={profile.assigned_subject_codes?.length || 0} />
              <Metric label="Scheduled classes" value={schedule.length} detail="Visible to your account" />
            </>
          )}
        </section>
      )}
      <div className="section-heading">
        <div><h2>Today’s timetable</h2><p>Schedule returned by your account’s permitted scope.</p></div>
        <button className="button secondary" onClick={() => setPage('timetable')} type="button">Open timetable</button>
      </div>
      {busy ? <Loading /> : (
        <DataTable
          columns={[
            { label: 'Time', render: (entry) => `${entry.start_time}–${entry.end_time}` },
            { label: 'Subject', render: (entry) => `${entry.subject_name} (${entry.subject_code})` },
            { label: 'Group', render: (entry) => `${entry.department} · Semester ${entry.semester}` },
            { label: 'Room', render: (entry) => entry.room_number },
          ]}
          emptyText={data?.timetable?.message || 'No schedule entries are available.'}
          rows={schedule}
        />
      )}
    </>
  )
}

function AttendancePage({ profile, data, busy, error, reload, students }) {
  const [form, setForm] = useState({
    subject_code: profile.assigned_subject_codes?.[0] || '',
    subject_name: '',
    session_date: DEFAULT_SESSION_DATE,
    start_time: '09:00',
  })
  const [marks, setMarks] = useState({})
  const [submitError, setSubmitError] = useState('')
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const isStudent = profile.role === 'student'
  const records = isStudent ? data?.records : data
  const hasAttendanceData = data?.summary?.total_classes > 0

  async function submit(event) {
    event.preventDefault()
    setSubmitError('')
    setNotice('')
    setSubmitting(true)
    try {
      const selected = Object.entries(marks)
        .filter(([, status]) => status)
        .map(([student_id, status]) => ({ student_id, status }))
      if (!selected.length) throw new Error('Select attendance for at least one student.')
      const result = await apiRequest('/attendance/sessions', {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
        body: { ...form, records: selected },
      })
      setNotice(`Session saved: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged.`)
      setMarks({})
      await reload()
    } catch (requestError) {
      setSubmitError(requestError.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <ErrorMessage error={error} />
      {busy ? <Loading /> : isStudent ? (
        <>
          {data?.is_demo && <div className="alert success" role="status">DEMO DATA: synthetic attendance records, not official records.</div>}
          <section className="metric-grid">
            <Metric label="Attendance" value={hasAttendanceData ? `${data.summary.attendance_percentage}%` : data?.summary ? 'Insufficient Data' : '—'} />
            <Metric label="Present" value={hasAttendanceData ? data.summary.present_classes : '—'} />
            <Metric label="Absent" value={hasAttendanceData ? data.summary.absent_classes : '—'} />
            <Metric label="Subjects" value={hasAttendanceData ? data.summary.subject_count : '—'} />
          </section>
          <DataTable
            columns={[
              { label: 'Subject', render: (row) => `${row.subject_name} (${row.subject_code})` },
              { label: 'Present', render: (row) => row.present_classes },
              { label: 'Absent', render: (row) => row.absent_classes },
              { label: 'Attendance', render: (row) => `${row.attendance_percentage}%` },
              { label: 'Status', render: (row) => row.low_attendance ? 'Below 75%' : 'On track' },
            ]}
            emptyText={data?.message || 'No attendance records are available.'}
            rows={records}
          />
        </>
      ) : (
        <>
          {records?.some((record) => record.is_demo) && <div className="alert success" role="status">DEMO DATA: synthetic attendance records, not official records.</div>}
          <p className="muted">Official attendance totals visible under your role and subject permissions.</p>
          <DataTable
            columns={[
              { label: 'Student', render: (row) => `${row.student_name} (${row.student_id})` },
              { label: 'Subject', render: (row) => `${row.subject_name} (${row.subject_code})` },
              { label: 'Present / Total', render: (row) => `${row.present_classes} / ${row.total_classes}` },
              { label: 'Attendance', render: (row) => `${row.attendance_percentage}%` },
              { label: 'Status', render: (row) => row.low_attendance ? 'Below 75%' : 'On track' },
            ]}
            rows={records}
          />
          <section className="panel form-panel">
            <div className="section-heading"><div><h2>Record a class session</h2><p>Only assigned subjects are available to faculty.</p></div></div>
            <ErrorMessage error={submitError} />
            {notice && <div className="alert success" role="status">{notice}</div>}
            <form className="form-grid" onSubmit={submit}>
              <label>Subject code
                {profile.role === 'faculty' ? (
                  <select
                    onChange={(event) => setForm({ ...form, subject_code: event.target.value })}
                    required
                    value={form.subject_code}
                  >
                    <option value="">Choose a subject</option>
                    {(profile.assigned_subject_codes || []).map((code) => <option key={code}>{code}</option>)}
                  </select>
                ) : <input maxLength="20" onChange={(event) => setForm({ ...form, subject_code: event.target.value })} required value={form.subject_code} />}
              </label>
              <label>Subject name<input maxLength="120" onChange={(event) => setForm({ ...form, subject_name: event.target.value })} required value={form.subject_name} /></label>
              <label>Session date<input onChange={(event) => setForm({ ...form, session_date: event.target.value })} required type="date" value={form.session_date} /></label>
              <label>Start time<input onChange={(event) => setForm({ ...form, start_time: event.target.value })} required type="time" value={form.start_time} /></label>
              <fieldset className="mark-list">
                <legend>Student attendance</legend>
                {students?.length ? students.map((student) => (
                  <label className="mark-row" key={student.student_id}>
                    <span>{student.name} <small>{student.student_id}</small></span>
                    <select
                      aria-label={`Attendance for ${student.name}`}
                      onChange={(event) => setMarks({ ...marks, [student.student_id]: event.target.value })}
                      value={marks[student.student_id] || ''}
                    >
                      <option value="">Not marked</option>
                      {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                  </label>
                )) : <p className="muted">Student directory is unavailable or empty.</p>}
              </fieldset>
              <button className="button primary" disabled={submitting} type="submit">
                {submitting ? 'Saving…' : 'Save attendance session'}
              </button>
            </form>
          </section>
        </>
      )}
    </>
  )
}

function TimetablePage({ profile, data, busy, error, reload }) {
  const [form, setForm] = useState({
    department: '', semester: 1, day_of_week: 'Monday', subject_code: '',
    subject_name: '', start_time: '09:00', end_time: '10:00',
    faculty_name: profile.role === 'faculty' ? profile.name : '',
    faculty_user_id: '', room_number: '',
  })
  const [message, setMessage] = useState('')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const staff = profile.role !== 'student'

  async function createEntry(event) {
    event.preventDefault()
    setMessage('')
    setFormError('')
    setSubmitting(true)
    try {
      const body = { ...form, semester: Number(form.semester) }
      if (!body.faculty_user_id) delete body.faculty_user_id
      await apiRequest('/timetable', {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
        body,
      })
      setMessage('Timetable entry created.')
      await reload()
    } catch (requestError) {
      setFormError(requestError.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function removeEntry(id) {
    setFormError('')
    setMessage('')
    try {
      await apiRequest(`/timetable/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        token: sessionStorage.getItem('smart-campus-token'),
      })
      setMessage('Timetable entry removed.')
      await reload()
    } catch (requestError) {
      setFormError(requestError.message)
    }
  }

  return (
    <>
      <ErrorMessage error={error} />
      {busy ? <Loading /> : (
        <>
          {data?.is_demo && <div className="alert success" role="status">DEMO DATA: synthetic sample timetable, not an official schedule.</div>}
          <div className="panel schedule-panel">
            <p className="muted">{data?.message || `Showing ${data?.scope || 'permitted'} schedule entries.`}</p>
            <DataTable
              columns={[
                { label: 'Day', render: (row) => row.day_of_week },
                { label: 'Time', render: (row) => `${row.start_time}–${row.end_time}` },
                { label: 'Subject', render: (row) => `${row.subject_name} (${row.subject_code})` },
                { label: 'Department / semester', render: (row) => `${row.department} · ${row.semester}` },
                { label: 'Faculty', render: (row) => row.faculty_name || '—' },
                { label: 'Room', render: (row) => row.room_number },
                ...(staff ? [{
                  label: 'Actions',
                  render: (row) => row.is_demo
                    ? <span className="muted">Demo</span>
                    : <button className="button danger small" onClick={() => removeEntry(row.id)} type="button">Delete</button>,
                }] : []),
              ]}
              emptyText={data?.message || 'No timetable entries are available.'}
              rows={data?.entries}
            />
          </div>
          {staff && (
            <section className="panel form-panel">
              <div className="section-heading"><div><h2>Publish a timetable entry</h2><p>Conflicting class group, room, or faculty schedules are rejected by the API.</p></div></div>
              <ErrorMessage error={formError} />
              {message && <div className="alert success" role="status">{message}</div>}
              <form className="form-grid" onSubmit={createEntry}>
                <label>Department<input maxLength="50" onChange={(event) => setForm({ ...form, department: event.target.value })} required value={form.department} /></label>
                <label>Semester<input max="12" min="1" onChange={(event) => setForm({ ...form, semester: event.target.value })} required type="number" value={form.semester} /></label>
                <label>Day<select onChange={(event) => setForm({ ...form, day_of_week: event.target.value })} value={form.day_of_week}>{DAYS.map((day) => <option key={day}>{day}</option>)}</select></label>
                <label>Subject code<input maxLength="20" onChange={(event) => setForm({ ...form, subject_code: event.target.value })} required value={form.subject_code} /></label>
                <label>Subject name<input maxLength="120" onChange={(event) => setForm({ ...form, subject_name: event.target.value })} required value={form.subject_name} /></label>
                <label>Start time<input onChange={(event) => setForm({ ...form, start_time: event.target.value })} required type="time" value={form.start_time} /></label>
                <label>End time<input onChange={(event) => setForm({ ...form, end_time: event.target.value })} required type="time" value={form.end_time} /></label>
                {profile.role === 'admin' && (
                  <>
                    <label>Faculty name<input maxLength="100" onChange={(event) => setForm({ ...form, faculty_name: event.target.value })} required={!form.faculty_user_id} value={form.faculty_name} /></label>
                    <label>Faculty account ID (optional)<input maxLength="24" onChange={(event) => setForm({ ...form, faculty_user_id: event.target.value })} value={form.faculty_user_id} /></label>
                  </>
                )}
                <label>Room<input maxLength="30" onChange={(event) => setForm({ ...form, room_number: event.target.value })} required value={form.room_number} /></label>
                <button className="button primary" disabled={submitting} type="submit">{submitting ? 'Publishing…' : 'Publish timetable entry'}</button>
              </form>
            </section>
          )}
        </>
      )}
    </>
  )
}

function NotificationsPage({ profile, data, busy, error, reload, openLostFoundClaim }) {
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [checking, setChecking] = useState(false)
  async function markRead(id) {
    setActionError('')
    try {
      await apiRequest(`/notifications/${encodeURIComponent(id)}/read`, {
        method: 'PATCH',
        token: sessionStorage.getItem('smart-campus-token'),
      })
      await reload()
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }
  async function weeklyCheck() {
    setChecking(true)
    setActionError('')
    setNotice('')
    try {
      const result = await apiRequest('/notifications/check-weekly', {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
      })
      setNotice(`${result.generated_warnings} warning(s) created; ${result.duplicates_skipped} duplicate(s) skipped.`)
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setChecking(false)
    }
  }
  return (
    <>
      <ErrorMessage error={error || actionError} />
      {notice && <div className="alert success" role="status">{notice}</div>}
      {busy ? <Loading /> : profile.role === 'student' ? (
        <>
          <p className="muted">{data?.unread_count || 0} unread notification(s)</p>
          {data?.notifications?.length ? (
            <div className="notification-list">
              {data.notifications.map((item) => (
                <article className={`notification-card ${item.is_read ? 'read' : ''}`} key={item.id}>
                  <div><span className="notification-meta">{item.week_id || 'Notification'} · {displayDate(item.reporting_date || item.created_at?.slice(0, 10))}</span><h2>{item.title}</h2><p>{item.message}</p></div>
                  <div className="notification-actions">
                    {item.action_type === 'lost_found_claim' && (
                      <button className="button primary small" onClick={() => openLostFoundClaim(item.claim_id)} type="button">
                        {item.claim_id ? 'Review claim' : 'Review requests'}
                      </button>
                    )}
                    {!item.is_read && <button className="button secondary small" onClick={() => markRead(item.id)} type="button">Mark as read</button>}
                  </div>
                </article>
              ))}
            </div>
          ) : <Empty>{data?.linked ? 'You have no attendance notifications.' : 'Link your student profile to receive notifications.'}</Empty>}
        </>
      ) : (
        <section className="panel action-panel">
          <span className="icon-tile">NO</span>
          <div><h2>Weekly attendance check</h2><p>This runs the existing low-attendance scan and skips duplicate warnings for the same week.</p></div>
          <button className="button primary" disabled={checking} onClick={weeklyCheck} type="button">{checking ? 'Checking…' : 'Run weekly check'}</button>
        </section>
      )}
    </>
  )
}

function StudentsPage({ data, busy, error }) {
  const [search, setSearch] = useState('')
  const [department, setDepartment] = useState('')
  const [semester, setSemester] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const pageSize = 25
  const filteredStudents = useMemo(
    () => filterStudentRecords(data, { search, department, semester }),
    [data, search, department, semester],
  )
  const { page, totalPages, rows: pageRows } = paginateStudentRecords(
    filteredStudents,
    currentPage,
    pageSize,
  )
  const pageNumbers = totalPages <= 7
    ? Array.from({ length: totalPages }, (_, index) => index + 1)
    : page <= 4
      ? [1, 2, 3, 4, 5, '…', totalPages]
      : page >= totalPages - 3
        ? [1, '…', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages]
        : [1, '…', page - 1, page, page + 1, '…', totalPages]

  function resetToFirstPage(updateFilter) {
    setCurrentPage(1)
    updateFilter()
  }

  return (
    <>
      <ErrorMessage error={error} />
      {busy ? <Loading /> : (
        <>
          <section aria-label="Filter students" className="student-controls">
            <label>
              Search students
              <input
                autoComplete="off"
                onChange={(event) => resetToFirstPage(() => setSearch(event.target.value))}
                placeholder="Name, registration number, student ID, or email"
                type="search"
                value={search}
              />
            </label>
            <label>
              Department
              <select
                onChange={(event) => resetToFirstPage(() => setDepartment(event.target.value))}
                value={department}
              >
                <option value="">All Departments</option>
                <option value="MCA">MCA</option>
                <option value="MBA">MBA</option>
                <option value="B.Tech">B.Tech</option>
              </select>
            </label>
            <label>
              Semester
              <select
                onChange={(event) => resetToFirstPage(() => setSemester(event.target.value))}
                value={semester}
              >
                <option value="">All Semesters</option>
                <option value="1">Semester 1</option>
                <option value="2">Semester 2</option>
                <option value="3">Semester 3</option>
              </select>
            </label>
          </section>
          <p aria-live="polite" className="student-result-count">
            {filteredStudents.length} matching student{filteredStudents.length === 1 ? '' : 's'}
          </p>
          {pageRows.length ? (
            <DataTable
              columns={[
                { label: 'Registration number', render: (row) => row.registration_number || row.student_id },
                { label: 'Name', render: (row) => row.name },
                { label: 'Email', render: (row) => row.email },
                { label: 'Course / department', render: (row) => row.course || row.department },
                { label: 'Semester', render: (row) => `Semester ${row.semester}` },
                { label: 'Section', render: (row) => row.section || '—' },
                { label: 'Academic year', render: (row) => row.academic_year || '—' },
              ]}
              rows={pageRows}
            />
          ) : (
            <Empty>
              {data?.length
                ? 'No students match your search and filters.'
                : 'No student records are available.'}
            </Empty>
          )}
          {filteredStudents.length > 0 && (
            <nav aria-label="Student results pages" className="student-pagination">
              <span>Page {page} of {totalPages}</span>
              <div className="student-page-buttons">
                <button
                  aria-label="Previous page"
                  className="button secondary small"
                  disabled={page === 1}
                  onClick={() => setCurrentPage(page - 1)}
                  type="button"
                >
                  Previous
                </button>
                {pageNumbers.map((pageNumber, index) => (
                  pageNumber === '…'
                    ? <span aria-hidden="true" className="page-ellipsis" key={`ellipsis-${index}`}>…</span>
                    : (
                      <button
                        aria-current={pageNumber === page ? 'page' : undefined}
                        aria-label={`Page ${pageNumber}`}
                        className={`button small ${pageNumber === page ? 'primary' : 'secondary'}`}
                        key={pageNumber}
                        onClick={() => setCurrentPage(pageNumber)}
                        type="button"
                      >
                        {pageNumber}
                      </button>
                    )
                ))}
                <button
                  aria-label="Next page"
                  className="button secondary small"
                  disabled={page === totalPages}
                  onClick={() => setCurrentPage(page + 1)}
                  type="button"
                >
                  Next
                </button>
              </div>
            </nav>
          )}
        </>
      )}
    </>
  )
}

function ProfilePage({ profile, data, busy, error, onLinked }) {
  const [form, setForm] = useState({ student_id: '', link_code: '' })
  const [linkError, setLinkError] = useState('')
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  async function linkStudent(event) {
    event.preventDefault()
    setLinkError('')
    setNotice('')
    setSubmitting(true)
    try {
      await apiRequest('/auth/me/link-student', {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
        body: form,
      })
      setForm({ student_id: '', link_code: '' })
      setNotice('Student record linked. Refreshing your profile and campus data…')
      try {
        await onLinked()
        setNotice('Student record linked successfully. Your profile, attendance, timetable, and assistant context are refreshed.')
      } catch {
        setNotice('Student record linked successfully, but some campus data could not be refreshed. Use Refresh to try again.')
      }
    } catch (requestError) {
      setLinkError(requestError.message)
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <>
      <ErrorMessage error={error} />
      <ErrorMessage error={linkError} />
      {notice && <div className="alert success" role="status">{notice}</div>}
      {busy ? <Loading /> : data ? (
        <section className="profile-card">
          <div className="profile-avatar">{(data.name || profile.name || 'SC').slice(0, 2).toUpperCase()}</div>
          <div><p className="eyebrow">LINKED STUDENT RECORD</p><h2>{data.name}</h2><p>{data.department} · Semester {data.semester}</p><p className="muted">Student ID: {data.student_id}</p></div>
        </section>
      ) : (
        <section className="panel form-panel">
          <Empty>{error || 'No linked student profile is available for this account.'}</Empty>
          {profile.role === 'student' && (
            <>
              <div className="section-heading"><div><h2>Link your student record</h2><p>Enter the one-time code provided by your college administrator.</p></div></div>
              <form className="form-grid" onSubmit={linkStudent}>
                <label>Student ID<input autoComplete="off" maxLength="50" onChange={(event) => setForm({ ...form, student_id: event.target.value })} required value={form.student_id} /></label>
                <label>One-time link code<input autoComplete="off" maxLength="32" onChange={(event) => setForm({ ...form, link_code: event.target.value })} required value={form.link_code} /></label>
                <button className="button primary" disabled={submitting} type="submit">{submitting ? 'Linking…' : 'Link student record'}</button>
              </form>
            </>
          )}
        </section>
      )}
    </>
  )
}

function StudentAcademicReportPage({ data, busy, error }) {
  return (
    <>
      <ErrorMessage error={error} />
      {busy && !data ? <Loading /> : data?.linked ? (
        <>
          {data.is_demo && <div className="alert success" role="status">DEMO DATA: synthetic academic records, not official student results.</div>}
          <section className="panel">
            <p className="eyebrow">PERSONAL ACADEMIC REPORT</p>
            <h2>{data.student.name} · {data.student.student_id}</h2>
            <p className="muted">{data.student.department} · Semester {data.student.semester}</p>
            <div className="metric-grid" aria-label="Academic risk summary">
              <Metric
                label="Risk level"
                value={data.risk_level === 'insufficient_data' ? 'Insufficient Data' : data.risk_level.replaceAll('_', ' ')}
              />
              <Metric
                label="Attendance"
                value={data.attendance.overall_percentage == null ? 'No data' : `${data.attendance.overall_percentage}%`}
              />
              <Metric label="Attendance trend" value={data.attendance_trend.direction.replaceAll('_', ' ')} />
              <Metric
                label="Internal marks average"
                value={data.internal_marks.average_percentage == null ? 'Not available' : `${data.internal_marks.average_percentage}%`}
              />
            </div>
          </section>
          <section className="panel">
            <h2>Subject performance</h2>
            {data.subjects.length ? (
              <div className="table-scroll"><table><thead><tr><th>Subject</th><th>Attendance</th><th>Internal marks</th></tr></thead>
                <tbody>{data.subjects.map((subject) => (
                  <tr key={subject.subject_code}>
                    <td>{subject.subject_name} ({subject.subject_code})</td>
                    <td>{subject.attendance_percentage == null ? 'No data' : `${subject.attendance_percentage}%`}</td>
                    <td>{subject.marks_average == null ? 'Not available' : `${subject.marks_average}%`}</td>
                  </tr>
                ))}</tbody></table></div>
            ) : <Empty>No subject attendance or marks are available in your linked records.</Empty>}
          </section>
          <section className="panel">
            <h2>Reasons and recommendations</h2>
            <h3>Risk reasons</h3>
            {data.risk_reasons.length ? <ul>{data.risk_reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : <p>No risk threshold was triggered by available records.</p>}
            <h3>Recommendations</h3>
            {data.recommendations.length ? <ul>{data.recommendations.map((item) => <li key={item}>{item}</li>)}</ul> : <p>No additional recommendations are available.</p>}
            {data.data_limitations.length > 0 && <><h3>Missing information</h3><ul>{data.data_limitations.map((item) => <li key={item}>{item}</li>)}</ul></>}
            <p className="muted">Explainable rule-based indicators only; educational guidance is not a guaranteed prediction.</p>
          </section>
        </>
      ) : (
        <section className="panel"><Empty>Your student record is not linked, so an academic report is unavailable.</Empty></section>
      )}
    </>
  )
}

function AdminPage({ data, busy, error, reload }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'faculty' })
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [working, setWorking] = useState(false)
  const [subjectInputs, setSubjectInputs] = useState({})
  const [linkStudentId, setLinkStudentId] = useState('')
  const [issuedCode, setIssuedCode] = useState(null)

  async function createUser(event) {
    event.preventDefault()
    setActionError('')
    setNotice('')
    setWorking(true)
    try {
      await apiRequest('/admin/users', {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
        body: form,
      })
      setForm({ name: '', email: '', password: '', role: 'faculty' })
      setNotice('Account created.')
      await reload()
    } catch (requestError) {
      setActionError(requestError.message)
      if (mode === 'study') setStudyUploading(false)
    } finally {
      setWorking(false)
    }
  }

  async function updateRole(userId, role) {
    setActionError('')
    setNotice('')
    try {
      await apiRequest(`/admin/users/${encodeURIComponent(userId)}/role`, {
        method: 'PATCH',
        token: sessionStorage.getItem('smart-campus-token'),
        body: { role },
      })
      setNotice('User role updated.')
      await reload()
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function updateSubjects(user) {
    setActionError('')
    setNotice('')
    try {
      const subjectCodes = (subjectInputs[user.id] ?? user.assigned_subject_codes?.join(',') ?? '')
        .split(',')
        .map((code) => code.trim())
        .filter(Boolean)
      await apiRequest(`/admin/users/${encodeURIComponent(user.id)}/subjects`, {
        method: 'PUT',
        token: sessionStorage.getItem('smart-campus-token'),
        body: { subject_codes: subjectCodes },
      })
      setNotice('Faculty subject assignments updated.')
      await reload()
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function issueLinkCode(event) {
    event.preventDefault()
    setActionError('')
    setNotice('')
    setIssuedCode(null)
    try {
      const result = await apiRequest(`/admin/students/${encodeURIComponent(linkStudentId)}/link-code`, {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
      })
      setIssuedCode(result)
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  return (
    <>
      <ErrorMessage error={error || actionError} />
      {notice && <div className="alert success" role="status">{notice}</div>}
      <section className="metric-grid">
        {busy ? <Loading /> : Object.entries(data?.stats || {}).map(([key, value]) => (
          <Metric key={key} label={key.replaceAll('_', ' ')} value={value} />
        ))}
      </section>
      <section className="panel form-panel">
        <div className="section-heading"><div><h2>Create an account</h2><p>Creates a role-specific account through the admin API.</p></div></div>
        <form className="form-grid" onSubmit={createUser}>
          <label>Name<input maxLength="100" onChange={(event) => setForm({ ...form, name: event.target.value })} required value={form.name} /></label>
          <label>Email<input maxLength="254" onChange={(event) => setForm({ ...form, email: event.target.value })} required type="email" value={form.email} /></label>
          <label>Initial password<input minLength="8" maxLength="128" onChange={(event) => setForm({ ...form, password: event.target.value })} required type="password" value={form.password} /></label>
          <label>Role<select onChange={(event) => setForm({ ...form, role: event.target.value })} value={form.role}><option value="student">Student</option><option value="faculty">Faculty</option><option value="admin">Admin</option></select></label>
          <button className="button primary" disabled={working} type="submit">{working ? 'Creating…' : 'Create account'}</button>
        </form>
      </section>
      <section className="panel form-panel">
        <div className="section-heading"><div><h2>Issue a student link code</h2><p>The code is shown once and expires after seven days.</p></div></div>
        <form className="inline-form" onSubmit={issueLinkCode}>
          <label>Student ID<input maxLength="50" onChange={(event) => setLinkStudentId(event.target.value)} required value={linkStudentId} /></label>
          <button className="button secondary" type="submit">Issue one-time code</button>
        </form>
        {issuedCode && <div className="alert success" role="status">Code for {issuedCode.student_id}: <strong>{issuedCode.link_code}</strong> · expires {displayDate(issuedCode.expires_at)}. Share this privately with the student.</div>}
      </section>
      <section className="panel">
        <div className="section-heading"><div><h2>Accounts</h2><p>Password hashes are never returned by the API.</p></div></div>
        {busy ? <Loading /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Student / faculty ID</th><th>Department / designation</th><th>Assigned subjects / classes</th></tr></thead>
              <tbody>{(data?.users || []).map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td><td>{user.email}</td>
                  <td><select aria-label={`Role for ${user.name}`} onChange={(event) => updateRole(user.id, event.target.value)} value={user.role}>
                    {['student', 'faculty', 'admin'].map((role) => <option key={role} value={role}>{role}</option>)}
                  </select></td>
                  <td>{user.student_id || user.registration_number || user.faculty_id || '—'}</td>
                  <td>{user.role === 'faculty'
                    ? [user.department, user.designation].filter(Boolean).join(' · ') || '—'
                    : user.department || '—'}</td>
                  <td>
                    {user.role === 'faculty' ? (
                      <>
                        <div className="assignment-control">
                          <input
                            aria-label={`Assigned subjects for ${user.name}`}
                            onChange={(event) => setSubjectInputs({ ...subjectInputs, [user.id]: event.target.value })}
                            placeholder="e.g. MCA401, CS202"
                            value={subjectInputs[user.id] ?? user.assigned_subject_codes?.join(',') ?? ''}
                          />
                          <button className="button secondary small" onClick={() => updateSubjects(user)} type="button">Save</button>
                        </div>
                        <small>Classes: {user.assigned_class_ids?.join(', ') || '—'}</small>
                      </>
                    ) : user.assigned_subject_codes?.join(', ') || '—'}
                  </td>
                </tr>
              ))}</tbody>
            </table>
            {!data?.users?.length && <Empty>No accounts are available.</Empty>}
          </div>
        )}
      </section>
    </>
  )
}

function AcademicIntelligencePage({ data, busy, error, profile }) {
  const [overview, setOverview] = useState(data || null)
  const [filters, setFilters] = useState({ department: '', semester: '', section: '', search: '' })
  const [selected, setSelected] = useState(null)
  const [note, setNote] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [working, setWorking] = useState(false)
  const token = () => sessionStorage.getItem('smart-campus-token')

  // Keep the local filter result synchronized when the parent explicitly refreshes.
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => setOverview(data || null), [data])

  async function loadOverview(query = filters, clearSelected = true) {
    const params = new URLSearchParams()
    Object.entries(query).forEach(([key, value]) => {
      if (value) params.set(key, value)
    })
    const encodedFilters = params.toString()
    const suffix = encodedFilters ? `?${encodedFilters}` : ''
    const result = await apiRequest(`/academic-intelligence/overview${suffix}`, { token: token() })
    setOverview(result)
    if (clearSelected) setSelected(null)
    return result
  }

  async function applyFilters(event) {
    event.preventDefault()
    setWorking(true)
    setActionError('')
    try {
      await loadOverview(filters)
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }

  async function openReport(student) {
    setActionError('')
    setWorking(true)
    try {
      const report = await apiRequest(
        `/academic-intelligence/students/${encodeURIComponent(student.student.student_id)}`,
        { token: token() },
      )
      setSelected({ ...report, latest_intervention: student.latest_intervention })
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }

  async function recordMentoring(event) {
    event.preventDefault()
    if (!selected) return
    setWorking(true)
    setActionError('')
    setNotice('')
    try {
      await apiRequest('/academic-intelligence/interventions', {
        method: 'POST',
        token: token(),
        body: {
          student_id: selected.student.student_id,
          note,
          follow_up_status: 'pending',
        },
      })
      setNote('')
      setNotice('Mentoring action recorded.')
      const updatedOverview = await loadOverview(filters, false)
      const updatedRow = updatedOverview.students?.find(
        (item) => item.student.student_id === selected.student.student_id,
      )
      const report = await apiRequest(
        `/academic-intelligence/students/${encodeURIComponent(selected.student.student_id)}`,
        { token: token() },
      )
      setSelected({ ...report, latest_intervention: updatedRow?.latest_intervention })
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }

  async function updateFollowUp(intervention, followUpStatus) {
    setWorking(true)
    setActionError('')
    setNotice('')
    try {
      await apiRequest(`/academic-intelligence/interventions/${encodeURIComponent(intervention.id)}`, {
        method: 'PATCH',
        token: token(),
        body: { follow_up_status: followUpStatus },
      })
      setNotice('Follow-up status updated.')
      await loadOverview(filters, false)
      setSelected((current) => current && ({
        ...current,
        latest_intervention: { ...current.latest_intervention, follow_up_status: followUpStatus },
      }))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }

  const report = overview || data
  const riskCounts = report?.risk_counts || {}

  return (
    <>
      <ErrorMessage error={error || actionError} />
      {notice && <div className="alert success" role="status">{notice}</div>}
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{profile.role === 'faculty' ? 'ASSIGNED CLASSES' : 'ADMIN OVERVIEW'}</p>
            <h2>Explainable academic risk baseline</h2>
            <p className="muted">Rule-based indicators only; no labelled outcome dataset is available for ML training or evaluation.</p>
          </div>
        </div>
        <form className="form-grid" onSubmit={applyFilters}>
          <label>Department<input maxLength="50" onChange={(event) => setFilters({ ...filters, department: event.target.value })} value={filters.department} /></label>
          <label>Semester
            <select onChange={(event) => setFilters({ ...filters, semester: event.target.value })} value={filters.semester}>
              <option value="">All</option>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((semester) => <option key={semester} value={semester}>{semester}</option>)}
            </select>
          </label>
          <label>Section<input maxLength="30" onChange={(event) => setFilters({ ...filters, section: event.target.value })} value={filters.section} /></label>
          <label>Search student<input maxLength="100" onChange={(event) => setFilters({ ...filters, search: event.target.value })} value={filters.search} /></label>
          <button className="button primary" disabled={working} type="submit">{working ? 'Loading…' : 'Apply filters'}</button>
        </form>
        {report?.filters?.section_filter_supported === false && (
          <p className="muted" role="status">Section filtering is unavailable because section values are not present in the current student records.</p>
        )}
      </section>
      {busy && !report ? <Loading /> : report && (
        <>
          <section className="metric-grid" aria-label="Academic risk summary">
            <Metric label="Students analyzed" value={report.total_students_analyzed} detail="Within your authorized scope" />
            <Metric label="High risk" value={riskCounts.high || 0} detail="Immediate review recommended" />
            <Metric label="Medium risk" value={riskCounts.medium || 0} detail="Monitor and support" />
            <Metric label="Low risk" value={riskCounts.low || 0} detail="No current threshold triggered" />
            <Metric label="Insufficient data" value={riskCounts.insufficient_data || 0} detail="Not enough academic records" />
          </section>
          <section className="panel">
            <h2>Attendance risk and academic trends</h2>
            <div className="metric-grid">
              <Metric label="Below 75% attendance" value={report.attendance_risk_distribution?.below_75_percent || 0} />
              <Metric label="Below 60% attendance" value={report.attendance_risk_distribution?.below_60_percent || 0} />
              <Metric label="No attendance totals" value={report.attendance_risk_distribution?.no_attendance_data || 0} />
              <Metric label="Declining trend" value={report.academic_trends?.declining || 0} detail="Requires at least four dated sessions per student" />
            </div>
            <p className="muted">Trend counts: improving {report.academic_trends?.improving || 0}, stable {report.academic_trends?.stable || 0}, insufficient history {report.academic_trends?.insufficient_data || 0}.</p>
          </section>
          <section className="panel">
            <h2>Subject performance overview</h2>
            {report.subject_performance_overview?.length ? (
              <div className="table-scroll"><table><thead><tr><th>Subject</th><th>Students with data</th><th>Avg attendance</th><th>Avg internal marks</th></tr></thead>
                <tbody>{report.subject_performance_overview.map((subject) => (
                  <tr key={subject.subject_code}>
                    <td>{subject.subject_name} ({subject.subject_code})</td>
                    <td>{subject.students_with_attendance} attendance · {subject.students_with_marks} marks</td>
                    <td>{subject.average_attendance == null ? 'No data' : `${subject.average_attendance}%`}</td>
                    <td>{subject.average_marks == null ? 'No data' : `${subject.average_marks}%`}</td>
                  </tr>
                ))}</tbody></table></div>
            ) : <Empty>No subject attendance or marks are available in this scope.</Empty>}
          </section>
          <section className="panel">
            <h2>Students requiring intervention</h2>
            {report.students_requiring_intervention?.length ? (
              <div className="table-scroll"><table><thead><tr><th>Student</th><th>Department / semester</th><th>Risk</th><th>Attendance</th><th>Reasons</th><th>Action</th></tr></thead>
                <tbody>{report.students_requiring_intervention.map((student) => (
                  <tr key={student.student.student_id}>
                    <td>{student.student.name}<br /><span className="muted">{student.student.student_id}</span></td>
                    <td>{student.student.department} · Semester {student.student.semester}</td>
                    <td>{student.risk_level}</td>
                    <td>{student.attendance.overall_percentage == null ? 'No data' : `${student.attendance.overall_percentage}%`}</td>
                    <td>{student.risk_reasons.join(' ') || 'No threshold reasons.'}</td>
                    <td><button className="button secondary small" disabled={working} onClick={() => openReport(student)} type="button">View report</button></td>
                  </tr>
                ))}</tbody></table></div>
            ) : <Empty>No high- or medium-risk students in this scope.</Empty>}
          </section>
          <section className="panel">
            <h2>All analyzed students</h2>
            {report.students?.length ? (
              <div className="table-scroll"><table><thead><tr><th>Student</th><th>Class</th><th>Risk</th><th>Attendance</th><th>Action</th></tr></thead>
                <tbody>{report.students.map((student) => (
                  <tr key={student.student.student_id}>
                    <td>{student.student.name}<br /><span className="muted">{student.student.student_id}</span></td>
                    <td>{student.student.department} · Semester {student.student.semester}</td>
                    <td>{student.risk_level}</td>
                    <td>{student.attendance.overall_percentage == null ? 'No data' : `${student.attendance.overall_percentage}%`}</td>
                    <td><button className="button secondary small" disabled={working} onClick={() => openReport(student)} type="button">View report</button></td>
                  </tr>
                ))}</tbody></table></div>
            ) : <Empty>No students are available in this authorized scope.</Empty>}
          </section>
          {selected && (
            <section className="panel" aria-live="polite">
              <div className="section-heading">
                <div><p className="eyebrow">INDIVIDUAL REPORT</p><h2>{selected.student.name} · {selected.student.student_id}</h2></div>
                <button className="button secondary small" onClick={() => setSelected(null)} type="button">Close</button>
              </div>
              <p><strong>{selected.risk_level === 'insufficient_data' ? 'INSUFFICIENT DATA' : selected.risk_level.toUpperCase()}</strong> · {selected.classification_type.replaceAll('_', ' ')}</p>
              <p>Attendance: {selected.attendance.overall_percentage == null ? 'No official totals' : `${selected.attendance.overall_percentage}%`} · Trend: {selected.attendance_trend.direction}</p>
              <p>Internal marks: {selected.internal_marks.average_percentage == null ? 'Insufficient Data' : `${selected.internal_marks.average_percentage}% average`}</p>
              <h3>Reasons</h3>
              {selected.risk_reasons.length ? <ul>{selected.risk_reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : <p>No risk threshold reasons.</p>}
              <h3>Subject indicators</h3>
              {selected.subjects.length ? <ul>{selected.subjects.map((subject) => (
                <li key={subject.subject_code}>
                  {subject.subject_name}: attendance {subject.attendance_percentage == null ? 'Insufficient Data' : `${subject.attendance_percentage}%`},
                  {' '}marks {subject.marks_average == null ? 'Insufficient Data' : `${subject.marks_average}%`}
                </li>
              ))}</ul> : <p>Insufficient Data: no subject records are available.</p>}
              <h3>Recommendations and data limits</h3>
              <ul>{selected.recommendations.map((item) => <li key={item}>{item}</li>)}{selected.data_limitations.map((item) => <li key={item}>{item}</li>)}</ul>
              <h3>Mentoring follow-up</h3>
              {selected.latest_intervention ? (
                <div>
                  <p>{selected.latest_intervention.note} · Status: {selected.latest_intervention.follow_up_status}</p>
                  <label>Update follow-up status
                    <select
                      disabled={working}
                      onChange={(event) => updateFollowUp(selected.latest_intervention, event.target.value)}
                      value={selected.latest_intervention.follow_up_status}
                    >
                      {['pending', 'in_progress', 'completed'].map((status) => <option key={status} value={status}>{status.replace('_', ' ')}</option>)}
                    </select>
                  </label>
                </div>
              ) : <Empty>No mentoring action is recorded.</Empty>}
              <form className="form-stack" onSubmit={recordMentoring}>
                <label htmlFor="mentoring-note">Record mentoring note</label>
                <textarea id="mentoring-note" maxLength="2000" onChange={(event) => setNote(event.target.value)} required rows="3" value={note} />
                <button className="button primary" disabled={working || !note.trim()} type="submit">Save mentoring action</button>
              </form>
            </section>
          )}
        </>
      )}
    </>
  )
}

function MoodCheckInPage({ busy, data, error, reload, token }) {
  const [mood, setMood] = useState('neutral')
  const [reflection, setReflection] = useState('')
  const [working, setWorking] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [urgentSupport, setUrgentSupport] = useState(false)
  const [selfCareSuggestions, setSelfCareSuggestions] = useState([])
  const checkIns = data?.check_ins || []

  async function submit(event) {
    event.preventDefault()
    setWorking(true)
    setActionError('')
    setNotice('')
    setUrgentSupport(false)
    try {
      const result = await apiRequest('/assistant/mood/check-ins', {
        method: 'POST',
        token,
        body: { mood, reflection: reflection.trim() },
      })
      setReflection('')
      setNotice(result.support_message || 'Your private check-in was saved.')
      setSelfCareSuggestions(result.self_care_suggestions || [])
      setUrgentSupport(result.urgent_support === true || result.risk_level === 'urgent')
      await reload()
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }

  return (
    <section className="panel mood-page">
      <p className="eyebrow">PRIVATE WELLBEING</p>
      <h2>Mood check-in</h2>
      <p className="muted">This is a private, optional reflection separate from Assistant conversations. It is not a diagnosis.</p>
      <ErrorMessage error={error || actionError} />
      {notice && <div className={`alert ${urgentSupport ? 'error' : 'success'}`} role={urgentSupport ? 'alert' : 'status'}>{notice}</div>}
      {selfCareSuggestions.length > 0 && (
        <section className="mood-support-list" aria-label="Optional self-care suggestions">
          <strong>Optional next steps</strong>
          <ul>{selfCareSuggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul>
        </section>
      )}
      {busy ? <Loading label="Loading your private check-ins…" /> : (
        <>
          <form className="form-grid mood-form" onSubmit={submit}>
            <label>How are you feeling?
              <select onChange={(event) => setMood(event.target.value)} value={mood}>
                {['very_good', 'good', 'neutral', 'low', 'very_low'].map((value) => (
                  <option key={value} value={value}>
                    {value === 'very_good' ? 'Very good'
                      : value === 'very_low' ? 'Very low'
                        : value[0].toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="mood-reflection">Optional private reflection
              <textarea maxLength="2000" onChange={(event) => setReflection(event.target.value)} rows="4" value={reflection} />
            </label>
            <button className="button primary" disabled={working} type="submit">{working ? 'Saving…' : 'Save private check-in'}</button>
          </form>
          <h3>Your recent check-ins</h3>
          {checkIns.length ? (
            <div className="mood-history">
              {checkIns.map((entry) => (
                <article className="mood-entry" key={entry.id || entry.created_at}>
                  <div><strong>{entry.mood || entry.sentiment || 'Check-in'}</strong><small>{displayDate(entry.created_at)}</small></div>
                  {entry.reflection && <p>{entry.reflection}</p>}
                  {entry.sentiment && <small>Language signal: {entry.sentiment}{entry.score != null ? ` · ${entry.score}%` : ''}</small>}
                  {entry.support_message && <p className="mood-support">{entry.support_message}</p>}
                  {entry.self_care_suggestions?.length > 0 && <ul>{entry.self_care_suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul>}
                </article>
              ))}
            </div>
          ) : <Empty>No check-ins yet. Your history is private to your account.</Empty>}
        </>
      )}
    </section>
  )
}

function MoodInsightsPage({ busy, data, error }) {
  const minimum = data?.minimum_group_size || 5
  const groups = (data?.groups || []).filter((group) => group.count >= minimum)
  return (
    <section className="panel mood-page">
      <p className="eyebrow">AGGREGATE WELLBEING</p>
      <h2>Campus wellbeing trends</h2>
      <p className="muted">Only group-level counts are shown. Individual check-ins and reflections are never available here. Trends are not diagnoses.</p>
      <ErrorMessage error={error} />
      {busy ? <Loading label="Loading anonymous aggregate trends…" /> : data?.suppressed ? (
        <Empty>Trends are hidden until a group reaches at least {minimum} check-ins.</Empty>
      ) : groups.length ? (
        <div className="mood-groups">
          {groups.map((group) => (
            <article className="mood-entry" key={`${group.department || 'campus'}-${group.semester || 'all'}`}>
              <div>
                <strong>{group.department || 'Campus'}{group.semester ? ` · Semester ${group.semester}` : ''}</strong>
                <small>{group.count} check-ins</small>
              </div>
              <ul>
                {Object.entries(group.sentiment_counts || {}).map(([sentiment, count]) => (
                  <li key={sentiment}>{sentiment}: {count}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      ) : <Empty>No sufficiently large aggregate groups are available yet.</Empty>}
    </section>
  )
}

function AssistantPage({ data, busy, error, reload, profile }) {
  const [referenceTime] = useState(() => Date.now())
  const historyRef = useRef(null)
  const [mode, setMode] = useState('general')
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [day, setDay] = useState('')
  const [freeTime, setFreeTime] = useState(null)
  const [working, setWorking] = useState(false)
  const [conversationId, setConversationId] = useState('')
  const [conversations, setConversations] = useState([])
  const [listening, setListening] = useState(false)
  const [lastFailedRequest, setLastFailedRequest] = useState(null)
  const [pendingConfirmation, setPendingConfirmation] = useState(null)
  const [placementPractice, setPlacementPractice] = useState(null)
  const [placementAnswer, setPlacementAnswer] = useState('')
  const [placementTopic, setPlacementTopic] = useState('Java')
  const [placementDifficulty, setPlacementDifficulty] = useState('beginner')
  const [studyDocument, setStudyDocument] = useState(null)
  const [studyActivities, setStudyActivities] = useState([])
  const [selectedStudyFile, setSelectedStudyFile] = useState(null)
  const [studyUploading, setStudyUploading] = useState(false)
  const [studyAnalyzing, setStudyAnalyzing] = useState(false)
  const [studyAnalysis, setStudyAnalysis] = useState(null)
  const [studyQuiz, setStudyQuiz] = useState([])
  const [studyQuizIndex, setStudyQuizIndex] = useState(0)
  const [studyQuizScore, setStudyQuizScore] = useState(0)
  const [studyQuizAnswer, setStudyQuizAnswer] = useState('')
  const [studyQuizFeedback, setStudyQuizFeedback] = useState('')
  const [studyQuizAnswered, setStudyQuizAnswered] = useState(false)
  const [moodValue, setMoodValue] = useState('neutral')
  const [moodReflection, setMoodReflection] = useState('')
  const [moodSaving, setMoodSaving] = useState(false)
  const [recentMoodCheckIns, setRecentMoodCheckIns] = useState([])
  const [moodStatus, setMoodStatus] = useState('')
  const [placementDocument, setPlacementDocument] = useState(null)
  const [selectedPlacementFile, setSelectedPlacementFile] = useState(null)
  const [placementUploading, setPlacementUploading] = useState(false)
  const [placementAnalyzing, setPlacementAnalyzing] = useState(false)
  const [placementAnalysis, setPlacementAnalysis] = useState(null)
  const [careerGoal, setCareerGoal] = useState('')
  const [targetCompany, setTargetCompany] = useState('')
  const [targetRole, setTargetRole] = useState('')
  const [expectedSalary, setExpectedSalary] = useState('')
  const [currentSkills, setCurrentSkills] = useState('')
  const [skillsToImprove, setSkillsToImprove] = useState('')
  const [preparationLevel, setPreparationLevel] = useState('')
  const [applicationTimeline, setApplicationTimeline] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [externalResearchConsent, setExternalResearchConsent] = useState(false)
  const [researchResult, setResearchResult] = useState(null)
  const [studyMinutes, setStudyMinutes] = useState('25')
  const [studySubjectCode, setStudySubjectCode] = useState('')
  const [studyProgress, setStudyProgress] = useState(null)
  const [complaintAction, setComplaintAction] = useState({
    category: 'other',
    title: '',
    description: '',
  })
  const isStudent = profile.role === 'student'
  const historyKey = `smart-campus-assistant-${profile.role}-${profile.id}-${mode}`
  const legacyHistoryKey = `smart-campus-assistant-${profile.role}-${profile.id}`
  const [messages, setMessages] = useState(() => {
    const saved = sessionStorage.getItem(historyKey)
      || (mode === 'general' ? sessionStorage.getItem(legacyHistoryKey) : null)
    if (!saved) {
      return [{
        role: 'assistant',
        content: "Hi! I'm your Campus Assistant. Ask about your timetable, attendance, studies, or placements.",
        intent: 'general',
      }]
    }
    try {
      const parsed = JSON.parse(saved)
      return Array.isArray(parsed)
        ? parsed.filter((turn) => ['user', 'assistant'].includes(turn.role) && typeof turn.content === 'string').slice(-40)
        : []
    } catch (parseError) {
      if (!(parseError instanceof SyntaxError)) throw parseError
      sessionStorage.removeItem(historyKey)
      return []
    }
  })
  const academicReport = data?.academicReport
  const lowAttendanceCount = academicReport?.subjects?.filter(
    (subject) => subject.attendance_percentage != null && subject.attendance_percentage < 75,
  ).length
  const timetableEntries = data?.timetable?.entries || []
  const assignedSubjects = [...new Set(timetableEntries.map((entry) => entry.subject_code).filter(Boolean))]

  useEffect(() => {
    sessionStorage.setItem(historyKey, JSON.stringify(messages.slice(-40)))
    if (mode === 'general') sessionStorage.setItem(legacyHistoryKey, JSON.stringify(messages.slice(-40)))
  }, [historyKey, legacyHistoryKey, messages, mode])

  useEffect(() => {
    const history = historyRef.current
    if (history) history.scrollTo({ top: history.scrollHeight, behavior: 'smooth' })
  }, [messages, working])

  useEffect(() => {
    let active = true
    apiRequest(`/assistant/conversations?mode=${encodeURIComponent(mode)}`, {
      token: sessionStorage.getItem('smart-campus-token'),
    }).then((items) => {
      if (active) setConversations(items)
    }).catch((requestError) => {
      if (active) setActionError(requestError.message)
    })
    return () => { active = false }
  }, [mode])

  useEffect(() => {
    if (mode !== 'study' || !isStudent) return undefined
    let active = true
    apiRequest('/assistant/academic-progress', {
      token: sessionStorage.getItem('smart-campus-token'),
    }).then((progress) => {
      if (active) setStudyProgress(progress)
    }).catch((requestError) => {
      if (active) setActionError(requestError.message)
    })
    return () => { active = false }
  }, [isStudent, mode])

  useEffect(() => {
    if (!isStudent || !['study', 'placement'].includes(mode)) return undefined
    let active = true
    const documentType = mode === 'study' ? 'study' : 'placement'
    apiRequest(`/assistant/${documentType}/documents`, {
      token: sessionStorage.getItem('smart-campus-token'),
    }).then((result) => {
      if (!active) return
      const documents = result.documents || []
      if (documentType === 'study') setStudyDocument(documents[0] || null)
      else setPlacementDocument(documents[0] || null)
    }).catch((requestError) => {
      if (active) setActionError(requestError.message)
    })
    return () => { active = false }
  }, [isStudent, mode])

  useEffect(() => {
    if (!isStudent || mode !== 'mood') return undefined
    let active = true
    apiRequest('/assistant/mood/check-ins?limit=5', {
      token: sessionStorage.getItem('smart-campus-token'),
    }).then((result) => {
      if (active) setRecentMoodCheckIns(result.check_ins || [])
    }).catch((requestError) => {
      if (active) setActionError(requestError.message)
    })
    return () => { active = false }
  }, [isStudent, mode])

  function changeMode(nextMode) {
    if (nextMode === mode) return
    sessionStorage.setItem(historyKey, JSON.stringify(messages.slice(-40)))
    setMode(nextMode)
    setConversationId('')
    setMessage('')
    setFreeTime(null)
    setActionError('')
    setPendingConfirmation(null)
    setResearchResult(null)
    setExternalResearchConsent(false)
    setPlacementPractice(null)
    setStudyDocument(null)
    setSelectedStudyFile(null)
    setStudyUploading(false)
    setStudyAnalyzing(false)
    setStudyAnalysis(null)
    setStudyActivities([])
    setStudyQuiz([])
    setStudyQuizIndex(0)
    setStudyQuizScore(0)
    setStudyQuizAnswer('')
    setStudyQuizFeedback('')
    setStudyQuizAnswered(false)
    setPlacementDocument(null)
    setSelectedPlacementFile(null)
    setPlacementUploading(false)
    setPlacementAnalyzing(false)
    setPlacementAnalysis(null)
    const saved = sessionStorage.getItem(
      `smart-campus-assistant-${profile.role}-${profile.id}-${nextMode}`,
    )
    if (!saved) {
      setMessages([{
        role: 'assistant',
        content: nextMode === 'study'
          ? 'Upload your course material or ask for help with a subject. Your study content stays separate from other Assistant modes.'
          : nextMode === 'placement'
            ? 'Practice interview questions or research a career goal using cited sources when live search is available.'
            : nextMode === 'mood'
              ? 'How are you feeling after your last lecture or today? You can also share an academic factor, but mood details are kept on the private Mood check-in page.'
              : "Hi! I'm your Campus Assistant. Ask about your timetable, attendance, studies, or placements.",
        intent: nextMode,
      }])
      return
    }
    try {
      const parsed = JSON.parse(saved)
      setMessages(Array.isArray(parsed)
        ? parsed.filter((turn) => ['user', 'assistant'].includes(turn.role) && typeof turn.content === 'string').slice(-40)
        : [])
    } catch (parseError) {
      if (!(parseError instanceof SyntaxError)) throw parseError
      sessionStorage.removeItem(`smart-campus-assistant-${profile.role}-${profile.id}-${nextMode}`)
      setMessages([])
    }
  }

  async function submitMessage(value) {
    const query = value.trim()
    if (!query || working) return
    const userTurn = { role: 'user', content: query }
    const history = [...messages, userTurn].slice(-8).map(({ role, content, intent }) => ({
      role,
      content,
      ...(intent ? { intent } : {}),
    }))
    setMessages((current) => [...current, userTurn].slice(-40))
    setWorking(true)
    setActionError('')
    try {
      const answer = await apiRequest('/assistant/chat', {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
        body: {
          message: query,
          mode,
          ...(mode === 'study' && studyDocument?.id ? { document_id: studyDocument.id } : {}),
          ...(mode === 'placement' && placementDocument?.id ? { document_id: placementDocument.id } : {}),
          history,
          ...(conversationId ? { conversation_id: conversationId } : {}),
          ...(day ? { day } : {}),
        },
      })
      if (answer.conversation_id) setConversationId(answer.conversation_id)
      if (answer.confirmation_id && answer.action?.summary) {
        setPendingConfirmation({
          confirmation_id: answer.confirmation_id,
          summary: answer.action.summary,
        })
      }
      setMessages((current) => [...current, {
        role: 'assistant',
        content: answer.reply,
        intent: answer.intent,
        provider: answer.provider,
        study_plan: answer.study_plan || [],
        recommendations: answer.recommendations || [],
        data_limitations: answer.data_limitations || [],
        disclaimer: answer.disclaimer,
        suggestions: answer.suggestions || [],
        action: answer.action,
        requires_confirmation: answer.requires_confirmation,
        confirmation_id: answer.confirmation_id,
        sources: answer.sources || [],
      }].slice(-40))
      setMessage('')
      setLastFailedRequest(null)
    } catch (requestError) {
      setActionError(requestError.message)
      setLastFailedRequest({ message: query })
    } finally {
      setWorking(false)
    }
  }
  async function ask(event) {
    event.preventDefault()
    await submitMessage(message)
  }
  async function findFreeTime() {
    setWorking(true)
    setActionError('')
    try {
      setFreeTime(await apiRequest(`/assistant/free-time${day ? `?day=${encodeURIComponent(day)}` : ''}`, {
        token: sessionStorage.getItem('smart-campus-token'),
      }))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }
  async function createPlacementPractice(topic = 'Java', difficulty = 'beginner') {
    setWorking(true)
    setActionError('')
    try {
      const result = await apiRequest('/assistant/placement/practice', {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
        body: { topic, difficulty },
      })
      setPlacementPractice(result)
      setPlacementAnswer('')
      setMessages((current) => [...current, {
        role: 'assistant',
        content: `${result.topic} practice (${result.difficulty}): ${result.question}`,
        intent: 'placement_preparation',
        provider: 'grounded_rule_engine',
      }].slice(-40))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }
  async function submitPlacementAnswer(event) {
    event.preventDefault()
    if (!placementPractice?.id || !placementAnswer.trim()) return
    setWorking(true)
    setActionError('')
    try {
      const result = await apiRequest(
        `/assistant/placement/practice/${encodeURIComponent(placementPractice.id)}/evaluate`,
        {
          method: 'POST',
          token: sessionStorage.getItem('smart-campus-token'),
          body: { answer: placementAnswer.trim() },
        },
      )
      setMessages((current) => [...current, {
        role: 'assistant',
        content: `Practice feedback (${result.score ?? 'not scored'}): ${result.evaluation || 'Feedback is unavailable.'}`,
        intent: 'placement_preparation',
        provider: result.provider || 'grounded_rule_engine',
      }].slice(-40))
      setPlacementPractice(null)
      setPlacementAnswer('')
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }
  async function loadPlacementProgress() {
    setWorking(true)
    setActionError('')
    try {
      const progress = await apiRequest('/assistant/placement/progress', {
        token: sessionStorage.getItem('smart-campus-token'),
      })
      setMessages((current) => [...current, {
        role: 'assistant',
        content: `Placement progress: ${progress.completed_sessions} sessions, average ${progress.average_score ?? 'not available'}, next topic ${progress.next_topic}.`,
        intent: 'placement_preparation',
        provider: 'grounded_rule_engine',
      }].slice(-40))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }
  async function uploadAssistantDocument(event) {
    const file = event.target.files?.[0]
    const validationError = validateAssistantFile(file)
    if (validationError) {
      setActionError(validationError)
      return
    }
    if (mode === 'study') {
      setSelectedStudyFile(file)
      setStudyUploading(true)
      setStudyDocument(null)
      setStudyAnalysis(null)
    } else {
      setSelectedPlacementFile(file)
      setPlacementUploading(true)
      setPlacementDocument(null)
      setPlacementAnalysis(null)
    }
    const formData = new FormData()
    formData.append('file', file)
    setWorking(true)
    setActionError('')
    try {
      const path = mode === 'study'
        ? '/assistant/study/documents'
        : '/assistant/placement/documents'
      const result = await apiRequest(path, {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
        body: formData,
      })
      if (mode === 'study') {
        setStudyDocument({ ...result, id: result.id || result.document_id })
        setStudyActivities([])
        setStudyUploading(false)
        setStudyAnalysis(null)
      } else {
        setPlacementDocument({ ...result, id: result.id || result.document_id })
        setPlacementUploading(false)
        setPlacementAnalysis(null)
      }
    } catch (requestError) {
      setActionError(requestError.message)
      if (mode === 'study') setStudyUploading(false)
      else setPlacementUploading(false)
    } finally {
      setWorking(false)
    }
  }
    async function analyzePlacementDocument() {
      if (!placementDocument?.id) return
      setPlacementAnalyzing(true)
      setActionError('')
      try {
        const result = await apiRequest(
          `/assistant/placement/documents/${encodeURIComponent(placementDocument.id)}/analysis`,
          { method: 'POST', token: sessionStorage.getItem('smart-campus-token') },
        )
        setPlacementAnalysis(result)
      } catch (requestError) {
        setActionError(requestError.message)
      } finally {
        setPlacementAnalyzing(false)
      }
    }
    async function analyzePastedJobDescription() {
      const text = jobDescription.trim()
      if (text.length < 30) {
        setActionError('Paste at least 30 characters of job description text before analysis.')
        return
      }
      setWorking(true)
      setActionError('')
      try {
        const result = await apiRequest('/assistant/placement/job-description/analysis', {
          method: 'POST',
          token: sessionStorage.getItem('smart-campus-token'),
          body: { job_description: text },
        })
        setPlacementAnalysis(result)
      } catch (requestError) {
        setActionError(requestError.message)
      } finally {
        setWorking(false)
      }
    }
  async function saveMoodCheckIn(event) {
    event.preventDefault()
    setMoodSaving(true)
    setActionError('')
    setMoodStatus('')
    try {
      await apiRequest('/assistant/mood/check-ins', {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
        body: {
          mood: moodValue,
          ...(moodReflection.trim() ? { reflection: moodReflection.trim() } : {}),
        },
      })
      const result = await apiRequest('/assistant/mood/check-ins?limit=5', {
        token: sessionStorage.getItem('smart-campus-token'),
      })
      setRecentMoodCheckIns(result.check_ins || [])
      setMoodReflection('')
      setMoodStatus('Your private check-in was saved and recent check-ins were refreshed.')
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setMoodSaving(false)
    }
  }
  async function analyzeStudyDocument() {
    if (!studyDocument?.id) return
    setStudyAnalyzing(true)
    setActionError('')
    try {
      const result = await apiRequest(
        `/assistant/study/documents/${encodeURIComponent(studyDocument.id)}/analysis`,
        {
          method: 'POST',
          token: sessionStorage.getItem('smart-campus-token'),
        },
      )
      setStudyAnalysis(result)
      setMessages((current) => [...current, {
        role: 'assistant',
        content: `Document analysed successfully.\n\nSubject: ${result.document?.main_subject}\nSummary: ${result.document?.summary}\n\nMain topics:\n${(result.chapter_topic_analysis?.main_topics || []).map((topic, index) => `${index + 1}. ${topic}`).join('\n')}`,
        intent: 'document_analysis',
        provider: 'extractive_document_context',
      }].slice(-40))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setStudyAnalyzing(false)
    }
  }

  function removeSelectedStudyFile() {
    setSelectedStudyFile(null)
    setStudyDocument(null)
    setStudyAnalysis(null)
  }

  async function generateStudyQuiz() {
    if (!studyDocument?.id) return
    setWorking(true)
    setActionError('')
    try {
      const token = sessionStorage.getItem('smart-campus-token')
      const documentPath = `/assistant/study/documents/${encodeURIComponent(studyDocument.id)}`
      const [quizResult, flashcardResult] = await Promise.all([
        apiRequest(`${documentPath}/quiz`, { method: 'POST', token }),
        apiRequest(`${documentPath}/flashcards`, { method: 'POST', token }),
      ])
      const questions = quizResult.questions || []
      const flashcards = flashcardResult.flashcards || []
      setStudyQuiz(questions)
      setStudyQuizIndex(0)
      setStudyQuizScore(0)
      setStudyQuizAnswer('')
      setStudyQuizFeedback('')
      setStudyQuizAnswered(false)
      const activities = [
        ...questions.map((question) => `Quiz: ${question.question || question}`),
        ...flashcards.map((card) => `Flashcard: ${card.front || card.question || 'Review'} — ${card.back || card.answer || ''}`),
      ]
      setStudyActivities(activities.length
        ? activities
        : ['No quiz questions or flashcards could be generated from this document.'])
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }
  function submitStudyQuizAnswer(event) {
    event.preventDefault()
    const question = studyQuiz[studyQuizIndex]
    if (!question || !studyQuizAnswer.trim() || studyQuizAnswered) return
    const correct = studyQuizAnswer.trim().toLowerCase() === String(question.answer || '').trim().toLowerCase()
    if (correct) setStudyQuizScore((score) => score + 1)
    setStudyQuizFeedback(correct
      ? 'Correct.'
      : `Not quite. The document-based answer is: ${question.answer}`)
    setStudyQuizAnswered(true)
  }
  function advanceStudyQuiz() {
    if (studyQuizIndex + 1 >= studyQuiz.length) {
      setStudyQuizIndex(studyQuiz.length)
      return
    }
    setStudyQuizIndex((index) => index + 1)
    setStudyQuizAnswer('')
    setStudyQuizFeedback('')
    setStudyQuizAnswered(false)
  }
  async function deletePrivateDocument(documentType, documentId) {
    if (!documentId) return
    setWorking(true)
    setActionError('')
    try {
      await apiRequest(
        `/assistant/${documentType}/documents/${encodeURIComponent(documentId)}`,
        {
          method: 'DELETE',
          token: sessionStorage.getItem('smart-campus-token'),
        },
      )
      if (documentType === 'study') {
        setStudyDocument(null)
        setStudyActivities([])
      } else {
        setPlacementDocument(null)
        setSelectedPlacementFile(null)
        setPlacementAnalysis(null)
      }
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }
  async function recordStudySession() {
    const subject = academicReport?.subjects?.find((item) => item.subject_code === studySubjectCode)
      || academicReport?.subjects?.[0]
    if (!subject?.subject_code) {
      setActionError('A linked subject is required before study time can be saved.')
      return
    }
    setWorking(true)
    setActionError('')
    try {
      await apiRequest('/assistant/academic-progress/sessions', {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
        body: {
          subject_code: subject.subject_code,
          subject_name: subject.subject_name,
          completed_minutes: Number(studyMinutes),
          activity: 'Study Buddy session',
        },
      })
      const progress = await apiRequest('/assistant/academic-progress', {
        token: sessionStorage.getItem('smart-campus-token'),
      })
      setStudyProgress(progress)
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }
  async function researchCareer(event) {
    event.preventDefault()
    const placementContext = {
      ...(targetCompany.trim() ? { company: targetCompany.trim() } : {}),
      ...(targetRole.trim() ? { role: targetRole.trim() } : {}),
      ...(expectedSalary.trim() ? { salary: expectedSalary.trim() } : {}),
      ...(currentSkills.trim() ? { current_skills: currentSkills.trim() } : {}),
      ...(skillsToImprove.trim() ? { skills_to_improve: skillsToImprove.trim() } : {}),
      ...(preparationLevel.trim() ? { preparation_level: preparationLevel.trim() } : {}),
      ...(applicationTimeline.trim() ? { application_timeline: applicationTimeline.trim() } : {}),
    }
    if (!careerGoal.trim()) return
    setWorking(true)
    setActionError('')
    setResearchResult(null)
    try {
      const userTurn = { role: 'user', content: `Career goal: ${careerGoal.trim()}` }
      const history = [...messages, userTurn].slice(-8).map(({ role, content, intent }) => ({
        role,
        content,
        ...(intent ? { intent } : {}),
      }))
      const plan = await apiRequest('/assistant/chat', {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
        body: {
          message: userTurn.content,
          mode: 'placement',
          placement_context: placementContext,
          history,
          ...(conversationId ? { conversation_id: conversationId } : {}),
        },
      })
      if (plan.conversation_id) setConversationId(plan.conversation_id)
      setMessages((current) => [...current, userTurn, {
        role: 'assistant',
        content: plan.reply,
        intent: plan.intent,
        provider: plan.provider,
        recommendations: plan.recommendations || [],
        data_limitations: plan.data_limitations || [],
      }].slice(-40))
      const result = await apiRequest('/assistant/placement/research', {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
        body: {
          career_goal: [
            careerGoal.trim(),
            targetCompany.trim() ? `Company: ${targetCompany.trim()}` : '',
            targetRole.trim() ? `Role: ${targetRole.trim()}` : '',
          ].filter(Boolean).join('. '),
          allow_external_processing: externalResearchConsent,
        },
      })
      setResearchResult(result)
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }
  async function newConversation() {
    try {
      const created = await apiRequest(`/assistant/conversations?mode=${encodeURIComponent(mode)}`, {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
      })
      setConversationId(created.id)
      setMessages([{
        role: 'assistant',
        content: "Hi! I'm your Campus Assistant. Ask about your campus records, studies, or placement preparation.",
        intent: 'general',
      }])
      setConversations((current) => [
        { id: created.id, title: created.title, updated_at: created.updated_at, message_count: 0 },
        ...current,
      ])
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function loadConversation(conversationIdToLoad) {
    try {
      setWorking(true)
      const conversation = await apiRequest(`/assistant/conversations/${encodeURIComponent(conversationIdToLoad)}`, {
        token: sessionStorage.getItem('smart-campus-token'),
      })
      setConversationId(conversation.id)
      setMessages(conversation.messages.length
        ? conversation.messages
        : [{
          role: 'assistant',
          content: 'Conversation loaded. Ask about campus information or placement preparation.',
          intent: 'general',
        }])
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }

  async function clearConversation() {
    if (!globalThis.confirm('Clear this conversation? This removes the saved chat history.')) return
    if (mode !== 'general') {
      if (conversationId) {
        try {
          await apiRequest(`/assistant/conversations/${encodeURIComponent(conversationId)}`, {
            method: 'DELETE',
            token: sessionStorage.getItem('smart-campus-token'),
          })
        } catch (requestError) {
          setActionError(requestError.message)
          return
        }
      }
      setConversationId('')
      setMessages([])
      sessionStorage.removeItem(historyKey)
      return
    }
    if (conversationId) {
      try {
        await apiRequest(`/assistant/conversations/${encodeURIComponent(conversationId)}`, {
          method: 'DELETE',
          token: sessionStorage.getItem('smart-campus-token'),
        })
      } catch (requestError) {
        setActionError(requestError.message)
        return
      }
    }
    await newConversation()
  }

  function startVoiceInput() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      setActionError('Voice input is not supported by this browser.')
      return
    }
    const recognition = new SpeechRecognition()
    recognition.lang = 'en-IN'
    recognition.interimResults = true
    recognition.continuous = false
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript || '')
        .join(' ')
        .trim()
      setMessage(transcript)
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => {
      setListening(false)
      setActionError('Microphone voice recognition was unavailable or denied.')
    }
    setListening(true)
    recognition.start()
  }

  function speakLatestResponse() {
    if (!('speechSynthesis' in window)) {
      setActionError('Text-to-speech is not supported by this browser.')
      return
    }
    const latest = [...messages].reverse().find((turn) => turn.role === 'assistant')
    if (!latest) return
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(latest.content))
  }

  async function prepareComplaintAction() {
    if (!complaintAction.title.trim() || !complaintAction.description.trim()) {
      setActionError('Enter a complaint title and description before confirmation.')
      return
    }
    try {
      setWorking(true)
      const prepared = await apiRequest('/assistant/actions/prepare', {
        method: 'POST',
        token: sessionStorage.getItem('smart-campus-token'),
        body: complaintAction,
      })
      setPendingConfirmation(prepared)
      setActionError('')
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }

  async function confirmPendingAction() {
    if (!pendingConfirmation) return
    try {
      setWorking(true)
      const result = await apiRequest(
        `/assistant/actions/${encodeURIComponent(pendingConfirmation.confirmation_id)}/confirm`,
        { method: 'POST', token: sessionStorage.getItem('smart-campus-token') },
      )
      setPendingConfirmation(null)
      setComplaintAction({ category: 'other', title: '', description: '' })
      setMessages((current) => [...current, {
        role: 'assistant',
        content: `Complaint submitted successfully. Status: ${result.result.status}.`,
        intent: 'create_complaint',
      }].slice(-40))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWorking(false)
    }
  }

  async function cancelPendingAction() {
    if (!pendingConfirmation) return
    try {
      await apiRequest(
        `/assistant/actions/${encodeURIComponent(pendingConfirmation.confirmation_id)}/cancel`,
        { method: 'POST', token: sessionStorage.getItem('smart-campus-token') },
      )
      setPendingConfirmation(null)
      setActionError('')
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }
  const suggestions = messages.slice().reverse().find((turn) => turn.role === 'assistant')?.suggestions
    || (mode === 'placement'
      ? ['Create a placement preparation plan.', 'What skills should I build for this role?', 'Give me a technical interview practice question.']
      : mode === 'study'
        ? ['Explain this topic at my current level.', 'Create a 7-day study plan.', 'Quiz me on the material I uploaded.']
        : (isStudent ? ASSISTANT_SUGGESTIONS : FACULTY_ASSISTANT_SUGGESTIONS))
  const visibleConversations = conversations.filter((conversation) => (conversation.mode || 'general') === mode)
  const weekStart = referenceTime - 7 * 24 * 60 * 60 * 1000
  const computedWeeklyMinutes = (studyProgress?.sessions || [])
    .filter((session) => new Date(session.created_at).getTime() >= weekStart)
    .reduce((total, session) => total + Number(session.completed_minutes || 0), 0)
  const weeklyStudyMinutes = studyProgress?.weekly_minutes ?? computedWeeklyMinutes
  const studyStreakDays = studyProgress?.streak_days
    ?? calculateStudyStreak(studyProgress?.sessions || [])
  return (
    <div className="assistant-page-shell">
      <ErrorMessage error={error || actionError} />
      {busy ? <Loading /> : (
        <div className="assistant-layout">
          <section className="panel assistant-chat-panel">
            <header className="assistant-chat-header">
              <div>
                <p className="eyebrow">SMART CAMPUS AI</p>
                <h2>{mode === 'study' ? 'Study Buddy' : mode === 'placement' ? 'Placement Assistant' : mode === 'mood' ? 'Mood Detector' : 'General Campus Assistant'}</h2>
              </div>
              {isStudent && (
                <label className="assistant-mode-picker">
                  <span>Assistant mode</span>
                  <select
                    aria-label="Assistant mode"
                    disabled={working}
                    onChange={(event) => changeMode(event.target.value)}
                    value={mode}
                  >
                    {availableAssistantModes(profile.role).map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </select>
                </label>
              )}
            </header>
            <div className="assistant-controls">
              <button className="button secondary" type="button" onClick={newConversation}>New conversation</button>
              {visibleConversations.length > 0 && (
                <select
                  aria-label="Saved conversation"
                  className="conversation-picker"
                  onChange={(event) => event.target.value && loadConversation(event.target.value)}
                  value={conversationId || ''}
                >
                  <option value="">Saved conversations</option>
                  {visibleConversations.map((conversation) => (
                    <option key={conversation.id} value={conversation.id}>{conversation.title || 'Conversation'}</option>
                  ))}
                </select>
              )}
              {lastFailedRequest && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={working}
                  onClick={() => submitMessage(lastFailedRequest.message)}
                >
                  Retry
                </button>
              )}
              <button className="button secondary" disabled={working} onClick={clearConversation} type="button">Clear chat</button>
            </div>
            <div className="assistant-scroll-area" ref={historyRef}>
              {(data?.freeTime?.message?.startsWith('DEMO DATA:') || data?.timetable?.is_demo) && (
                <div className="alert success" role="status">DEMO DATA: assistant context uses synthetic academic and timetable records.</div>
              )}
              <p className="muted">{isStudent
              ? mode === 'study'
                ? 'Get explanations, quizzes, flashcards, and study planning based on your materials and academic progress. Uploaded content is private to your account.'
                : mode === 'placement'
                  ? 'Practice interview skills and research a career goal. Live career research is shown only with verifiable source links.'
                  : mode === 'mood'
                    ? 'Share a voluntary check-in. Private mood details stay out of ordinary assistant conversations.'
                    : 'Answers use your own linked academic records and timetable. Missing information is identified rather than guessed.'
              : 'Answers use your assigned timetable and authorized class records. Student information outside your scope is not available.'}</p>
            {mode === 'study' && isStudent && (
              <section className="assistant-mode-tools">
                <h3>Study materials</h3>
                <label className="study-upload-zone" htmlFor="study-material-upload">
                  <strong>Upload Study Material</strong>
                  <span>PDF, DOCX or TXT · maximum 5 MB</span>
                  <input
                    accept=".pdf,.docx,.txt,application/pdf,text/plain"
                    disabled={working}
                    id="study-material-upload"
                    onChange={uploadAssistantDocument}
                    type="file"
                  />
                </label>
                {selectedStudyFile && (
                  <div className="selected-study-file">
                    <div>
                      <strong>{selectedStudyFile.name}</strong>
                      <small>{studyUploading ? 'Uploading and extracting…' : studyDocument ? 'Uploaded and ready to analyse' : 'Upload not complete'}</small>
                    </div>
                    <button className="button secondary small" disabled={working} onClick={removeSelectedStudyFile} type="button">Remove</button>
                  </div>
                )}
                {studyDocument?.id && (
                  <button className="button primary" disabled={working || studyAnalyzing} onClick={analyzeStudyDocument} type="button">
                    {studyAnalyzing ? 'Analysing document…' : 'Analyse Document'}
                  </button>
                )}
                {studyDocument && (
                  <div className="assistant-document">
                    <strong>{studyDocument.filename || 'Uploaded study material'}</strong>
                    <p>{studyDocument.summary || 'Private material is ready for study activities.'}</p>
                    <button className="button secondary" disabled={working} onClick={generateStudyQuiz} type="button">Generate quiz and flashcards</button>
                    <button className="button secondary" disabled={working} onClick={() => deletePrivateDocument('study', studyDocument.id)} type="button">Delete private material</button>
                    {studyActivities.length > 0 && <ol>{studyActivities.map((activity, index) => <li key={`${index}-${activity}`}>{activity}</li>)}</ol>}
                    {studyQuiz.length > 0 && (
                      studyQuizIndex >= studyQuiz.length
                        ? <p role="status">Quiz complete: {studyQuizScore} of {studyQuiz.length} correct.</p>
                        : <form className="assistant-form" onSubmit={submitStudyQuizAnswer}>
                          <p><strong>Question {studyQuizIndex + 1} of {studyQuiz.length}</strong></p>
                          <p>{studyQuiz[studyQuizIndex].question}</p>
                          <label htmlFor="study-quiz-answer">Your answer</label>
                          <input
                            id="study-quiz-answer"
                            maxLength="200"
                            disabled={studyQuizAnswered}
                            onChange={(event) => setStudyQuizAnswer(event.target.value)}
                            required
                            value={studyQuizAnswer}
                          />
                          {studyQuizFeedback && <p role="status">{studyQuizFeedback}</p>}
                          {studyQuizAnswered
                            ? <button className="button primary" onClick={advanceStudyQuiz} type="button">{studyQuizIndex + 1 === studyQuiz.length ? 'Finish quiz' : 'Next question'}</button>
                            : <button className="button primary" disabled={!studyQuizAnswer.trim()} type="submit">Submit answer</button>}
                        </form>
                    )}
                  </div>
                )}
                {studyAnalysis && (
                  <section className="study-analysis" aria-live="polite">
                    <h3>Document analysis</h3>
                    <p><strong>{studyAnalysis.document?.name}</strong></p>
                    <p>{studyAnalysis.document?.summary}</p>
                    <p><strong>Main subject:</strong> {studyAnalysis.document?.main_subject}</p>
                    <p><strong>Extracted words:</strong> {studyAnalysis.document?.word_count}</p>
                    <details>
                      <summary>Extracted text preview</summary>
                      <p>{studyAnalysis.document?.extracted_text_preview}</p>
                    </details>
                    <h4>Main topics</h4>
                    <ul>{(studyAnalysis.chapter_topic_analysis?.main_topics || []).map((topic) => <li key={topic}>{topic}</li>)}</ul>
                    <h4>Important points</h4>
                    <ul>{(studyAnalysis.important_material?.important_points || []).map((point) => <li key={point}>{point}</li>)}</ul>
                    <h4>Sample questions</h4>
                    <ol>{(studyAnalysis.sample_exam_questions?.questions || []).map((item, index) => (
                      <li key={`${item.question}-${index}`}><strong>{item.marks}-mark:</strong> {item.question}<p><strong>Answer:</strong> {item.answer}</p></li>
                    ))}</ol>
                    <h4>MCQs</h4>
                    <ol>{(studyAnalysis.sample_exam_questions?.mcqs || []).map((item, index) => (
                      <li key={`${item.question}-${index}`}>{item.question}<p><strong>Answer:</strong> {item.answer}</p></li>
                    ))}</ol>
                  </section>
                )}
                <div className="study-session-controls">
                  <label>Subject
                    <select onChange={(event) => setStudySubjectCode(event.target.value)} value={studySubjectCode || academicReport?.subjects?.[0]?.subject_code || ''}>
                      {(academicReport?.subjects || []).map((subject) => (
                        <option key={subject.subject_code} value={subject.subject_code}>{subject.subject_name || subject.subject_code}</option>
                      ))}
                    </select>
                  </label>
                  <label>Study minutes
                    <input max="600" min="1" onChange={(event) => setStudyMinutes(event.target.value)} type="number" value={studyMinutes} />
                  </label>
                  <button className="button secondary" disabled={working || !academicReport?.subjects?.length} onClick={recordStudySession} type="button">Log study session</button>
                  {studyProgress && <small>Last 7 days: {weeklyStudyMinutes} minutes · Streak: {studyStreakDays} days · Recorded: {Object.values(studyProgress.subject_totals || {}).reduce((sum, minutes) => sum + Number(minutes || 0), 0)} minutes</small>}
                </div>
              </section>
            )}
            {mode === 'placement' && isStudent && (
              <section className="assistant-mode-tools">
                <h3>Career research</h3>
                <form className="form-grid" onSubmit={researchCareer}>
                  <label>Company
                    <input maxLength="120" onChange={(event) => setTargetCompany(event.target.value)} value={targetCompany} />
                  </label>
                  <label>Target role
                    <input maxLength="120" onChange={(event) => setTargetRole(event.target.value)} value={targetRole} />
                  </label>
                  <label>Expected salary
                    <input maxLength="80" onChange={(event) => setExpectedSalary(event.target.value)} value={expectedSalary} />
                  </label>
                  <label>Current skills
                    <input maxLength="500" onChange={(event) => setCurrentSkills(event.target.value)} value={currentSkills} />
                  </label>
                  <label>Skills to improve
                    <input maxLength="500" onChange={(event) => setSkillsToImprove(event.target.value)} value={skillsToImprove} />
                  </label>
                  <label>Current preparation level
                    <input maxLength="120" onChange={(event) => setPreparationLevel(event.target.value)} value={preparationLevel} />
                  </label>
                  <label>Application timeline
                    <input maxLength="120" onChange={(event) => setApplicationTimeline(event.target.value)} value={applicationTimeline} />
                  </label>
                  <label>Career goal
                    <input maxLength="160" onChange={(event) => setCareerGoal(event.target.value)} required value={careerGoal} />
                  </label>
                  <label>Job description (optional)
                    <textarea maxLength="8000" onChange={(event) => setJobDescription(event.target.value)} rows="4" value={jobDescription} />
                  </label>
                  <button
                    className="button secondary"
                    disabled={working || jobDescription.trim().length < 30}
                    onClick={analyzePastedJobDescription}
                    type="button"
                  >
                    {working ? 'Analysing job description…' : 'Analyse Job Description'}
                  </button>
                  <label className="consent-label">
                    <input checked={externalResearchConsent} onChange={(event) => setExternalResearchConsent(event.target.checked)} type="checkbox" />
                    Optional: allow the career goal to be sent to web search. Pasted or uploaded job-description text is analysed locally only.
                  </label>
                  <button className="button primary" disabled={working || !careerGoal.trim()} type="submit">Create plan and check research</button>
                </form>
                {researchResult && (
                  <div className="assistant-document" role="status">
                    <strong>{researchResult.available ? 'Career research' : 'Live research unavailable'}</strong>
                    {researchResult.summary && <p>{researchResult.summary}</p>}
                    {!researchResult.available && researchResult.reason && <p>{researchResult.reason}</p>}
                    {researchResult.date_researched && <small>Researched: {researchResult.date_researched}</small>}
                    {researchResult.sources?.length > 0 && <ul>{researchResult.sources.map((source) => {
                      const url = safeAssistantSourceUrl(source.url)
                      return <li key={source.url}>
                        {url ? <a href={url} rel="noreferrer" target="_blank">{source.title || url}</a> : (source.title || 'Source URL unavailable')}
                        {source.published_at && <small> · Published: {source.published_at}</small>}
                        {source.snippet && <p>{source.snippet}</p>}
                      </li>
                    })}</ul>}
                  </div>
                )}
                <h3>Job description or CV</h3>
                <label>Upload a job description or CV for private text extraction (PDF, DOCX, or TXT, max 5 MB)
                  <input accept=".pdf,.docx,.txt,application/pdf,text/plain" disabled={working} onChange={uploadAssistantDocument} type="file" />
                </label>
                {selectedPlacementFile && (
                  <div className="selected-study-file">
                    <div>
                      <strong>{selectedPlacementFile.name}</strong>
                      <small>{placementUploading ? 'Uploading and extracting…' : placementDocument ? 'Uploaded and ready to analyse' : 'Upload not complete'}</small>
                    </div>
                  </div>
                )}
                {placementDocument && (
                  <div className="assistant-document">
                    <strong>{placementDocument.filename || 'Placement document'}</strong>
                    <p>{placementDocument.summary || 'Private extracted text is ready to analyse.'}</p>
                    <button className="button primary" disabled={working || placementAnalyzing} onClick={analyzePlacementDocument} type="button">
                      {placementAnalyzing ? 'Analysing document…' : 'Analyse Job Description'}
                    </button>
                    <button className="button secondary" disabled={working} onClick={() => deletePrivateDocument('placement', placementDocument.id)} type="button">Delete private document</button>
                  </div>
                )}
                {placementAnalysis && (
                  <section className="study-analysis" aria-live="polite">
                    <h3>Job description analysis</h3>
                    <p>{placementAnalysis.document}</p>
                    <h4>Explicit requirements</h4>
                    <ul>{(placementAnalysis.explicit_requirements || []).map((item) => <li key={item}>{item}</li>)}</ul>
                    <h4>Qualifications and eligibility</h4>
                    <ul>{(placementAnalysis.qualifications_and_eligibility || []).map((item) => <li key={item}>{item}</li>)}</ul>
                    <h4>Technical skills and tools</h4>
                    <ul>{(placementAnalysis.technical_skills || []).map((item) => <li key={item}>{item}</li>)}</ul>
                    <h4>Responsibilities</h4>
                    <ul>{(placementAnalysis.responsibilities || []).map((item) => <li key={item}>{item}</li>)}</ul>
                    <h4>Additional recommendations (not stated requirements)</h4>
                    <ul>{(placementAnalysis.additional_recommendations || []).map((item) => <li key={item}>{item}</li>)}</ul>
                    <h4>Suggested preparation roadmap</h4>
                    <ol>{(placementAnalysis.roadmap || []).map((item) => <li key={item.week}>Week {item.week}: {item.focus}</li>)}</ol>
                  </section>
                )}
                <h3>Mock interview practice</h3>
                <div className="study-session-controls">
                  <label>Topic
                    <select onChange={(event) => setPlacementTopic(event.target.value)} value={placementTopic}>
                      {['Java', 'Python', 'SQL', 'DBMS', 'OOP', 'Operating Systems', 'Computer Networks', 'DSA', 'Aptitude', 'HR Interview', 'Technical Interview'].map((topic) => <option key={topic}>{topic}</option>)}
                    </select>
                  </label>
                  <label>Difficulty
                    <select onChange={(event) => setPlacementDifficulty(event.target.value)} value={placementDifficulty}>
                      {['beginner', 'intermediate', 'advanced'].map((level) => <option key={level}>{level}</option>)}
                    </select>
                  </label>
                  <button className="button secondary" disabled={working} onClick={() => createPlacementPractice(placementTopic, placementDifficulty)} type="button">Start practice</button>
                </div>
                {placementPractice && (
                  <form className="assistant-form" onSubmit={submitPlacementAnswer}>
                    <p><strong>{placementPractice.topic}:</strong> {placementPractice.question}</p>
                    <label htmlFor="placement-answer">Your answer</label>
                    <textarea id="placement-answer" maxLength="5000" onChange={(event) => setPlacementAnswer(event.target.value)} required rows="4" value={placementAnswer} />
                    <button className="button primary" disabled={working || !placementAnswer.trim()} type="submit">Get practice feedback</button>
                  </form>
                )}
                <div className="assistant-controls">
                  <button className="button secondary" disabled={working} onClick={loadPlacementProgress} type="button">Placement progress</button>
                </div>
              </section>
            )}
            {mode === 'mood' && isStudent && (
              <section className="assistant-mode-tools">
                <h3>Private mood check-in</h3>
                <p className="muted">Voluntary and non-diagnostic. Your check-in and optional reflection are visible only to you.</p>
                <form className="form-grid" onSubmit={saveMoodCheckIn}>
                  <label htmlFor="assistant-mood-value">How are you feeling?</label>
                  <select
                    id="assistant-mood-value"
                    onChange={(event) => setMoodValue(event.target.value)}
                    value={moodValue}
                  >
                    {[
                      ['very_low', 'Very low'],
                      ['low', 'Low'],
                      ['neutral', 'Neutral'],
                      ['good', 'Good'],
                      ['very_good', 'Very good'],
                    ].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <label htmlFor="assistant-mood-reflection">Optional private reflection</label>
                  <textarea
                    id="assistant-mood-reflection"
                    maxLength="2000"
                    onChange={(event) => setMoodReflection(event.target.value)}
                    rows="2"
                    value={moodReflection}
                  />
                  <button className="button primary" disabled={moodSaving} type="submit">
                    {moodSaving ? 'Saving check-in…' : 'Save private check-in'}
                  </button>
                  {moodStatus && <p role="status">{moodStatus}</p>}
                </form>
                {recentMoodCheckIns.length > 0 && (
                  <p className="muted">Most recent private check-in: {recentMoodCheckIns[0].mood} · {new Date(recentMoodCheckIns[0].created_at).toLocaleString()}</p>
                )}
              </section>
            )}
            {mode === 'general' && <label className="day-filter">Day (optional)
              <select onChange={(event) => setDay(event.target.value)} value={day}>
                <option value="">Today / infer from message</option>
                {DAYS.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>}
            <div className="assistant-history" aria-label="Conversation history" aria-live="polite">
              {messages.map((turn, index) => (
                <article className={`assistant-answer assistant-message ${turn.role}`} key={`${index}-${turn.intent || turn.role}`}>
                  <span>{turn.role === 'user' ? 'You' : `${turn.provider || 'Smart Campus'}${turn.intent ? ` · ${turn.intent}` : ''}`}</span>
                  <p>{turn.content}</p>
                  {turn.study_plan?.length > 0 && <ol>{turn.study_plan.map((item) => (
                    <li key={`${item.day}-${item.subject}`}>
                      <strong>{item.day} · {item.subject}{item.time_window ? ` · ${item.time_window}` : ''}:</strong> {item.activity}
                    </li>
                  ))}</ol>}
                  {turn.recommendations?.length > 0 && <ul>{turn.recommendations.map((item) => <li key={item}>{item}</li>)}</ul>}
                  {turn.data_limitations?.length > 0 && <p className="muted">Missing information: {turn.data_limitations.join(' ')}</p>}
                  {turn.disclaimer && <p className="muted">{turn.disclaimer}</p>}
                  {turn.sources?.length > 0 && <ul className="assistant-sources">{turn.sources.map((source) => {
                    const url = typeof source === 'string' ? safeAssistantSourceUrl(source) : safeAssistantSourceUrl(source.url)
                    return <li key={typeof source === 'string' ? source : source.url}>
                      {url ? <a href={url} rel="noreferrer" target="_blank">{typeof source === 'string' ? source : source.title || url}</a> : (typeof source === 'string' ? source : source.title || 'Source URL unavailable')}
                    </li>
                  })}</ul>}
                  {turn.role === 'assistant' && (
                    <button
                      className="button secondary small"
                      type="button"
                      onClick={() => navigator.clipboard?.writeText(turn.content)}
                    >
                      Copy response
                    </button>
                  )}
                </article>
              ))}
            </div>
            {mode === 'general' && isStudent && messages.some((turn) => turn.intent === 'create_complaint') && (
              <section className="panel assistant-action-card">
                <h3>Prepare complaint</h3>
                <p className="muted">Review the details before submitting. Nothing is written until you confirm.</p>
                {pendingConfirmation ? (
                  <>
                    <p><strong>Category:</strong> {pendingConfirmation.summary.category}</p>
                    <p><strong>Title:</strong> {pendingConfirmation.summary.title}</p>
                    <p><strong>Description:</strong> {pendingConfirmation.summary.description}</p>
                    <button className="button primary" type="button" disabled={working} onClick={confirmPendingAction}>Confirm submission</button>
                    <button className="button secondary" type="button" disabled={working} onClick={cancelPendingAction}>Cancel</button>
                  </>
                ) : (
                  <div className="form-grid">
                    <label>Category
                      <select value={complaintAction.category} onChange={(event) => setComplaintAction((current) => ({ ...current, category: event.target.value }))}>
                        {['academic', 'facilities', 'transport', 'library', 'safety', 'other'].map((category) => (
                          <option key={category} value={category}>{category}</option>
                        ))}
                      </select>
                    </label>
                    <label>Title
                      <input maxLength="120" value={complaintAction.title} onChange={(event) => setComplaintAction((current) => ({ ...current, title: event.target.value }))} />
                    </label>
                    <label>Description
                      <textarea maxLength="5000" rows="3" value={complaintAction.description} onChange={(event) => setComplaintAction((current) => ({ ...current, description: event.target.value }))} />
                    </label>
                    <button className="button primary" type="button" disabled={working} onClick={prepareComplaintAction}>Review complaint</button>
                  </div>
                )}
              </section>
            )}
            {working && <p role="status">Preparing your private, role-scoped response…</p>}
            {mode === 'general' && isStudent && <button className="button secondary" disabled={working} onClick={findFreeTime} type="button">Find free time</button>}
            {mode === 'general' && freeTime && <article className="assistant-answer"><span>{freeTime.day} · {freeTime.total_classes} classes</span><p>{freeTime.message}</p><ul>{freeTime.free_slots.map((slot) => <li key={slot.slot_label}>{slot.slot_label} · {slot.duration_display}</li>)}</ul></article>}
            </div>
            <form className="assistant-form" onSubmit={ask}>
              <label htmlFor="assistant-message">Your question</label>
              <div className={`assistant-composer ${['study', 'placement'].includes(mode) ? 'has-attachment' : ''}`}>
                {mode === 'placement' && (
                  <>
                    <input
                      accept=".pdf,.docx,.txt"
                      aria-label={mode === 'study' ? 'Upload study document' : 'Upload job description or CV'}
                      id="assistant-file"
                      onChange={uploadAssistantDocument}
                      type="file"
                    />
                    <label className="attachment-button" htmlFor="assistant-file" title="Attach a document">Attach</label>
                  </>
                )}
                {mode === 'study' && (
                  <label className="attachment-button" htmlFor="study-material-upload" title="Attach study material">Attach</label>
                )}
                <textarea
                  id="assistant-message"
                  maxLength="500"
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      if (message.trim() && !working) event.currentTarget.form?.requestSubmit()
                    }
                  }}
                  placeholder="Ask anything about your campus, studies, or placements..."
                  required
                  rows="2"
                  value={message}
                />
                <button
                  className="composer-icon-button"
                  type="button"
                  disabled={working}
                  onClick={startVoiceInput}
                  title={listening ? 'Listening…' : 'Voice input'}
                >
                  {listening ? 'Stop' : 'Mic'}
                </button>
                <button className="button primary" disabled={working || !message.trim()} type="submit">{working ? 'Sending…' : 'Send'}</button>
              </div>
            </form>
          </section>
          <details className="panel assistant-summary">
            <summary>Verified academic context</summary>
            {isStudent ? <>
              <p>{data?.freeTime?.linked
                ? 'Using the student timetable linked to your account.'
                : data?.freeTime?.message || academicReport?.message || 'Student academic context is unavailable.'}</p>
              {academicReport?.is_demo && (
                <p className="muted">DEMO DATA: synthetic academic records, not official records.</p>
              )}
              <Metric
                label="Overall attendance"
                value={academicReport?.attendance?.overall_percentage == null
                  ? 'Insufficient Data'
                  : `${academicReport.attendance.overall_percentage}%`}
              />
              <Metric label="Low-attendance subjects" value={lowAttendanceCount ?? 'Insufficient Data'} />
              <Metric label="Classes on selected day" value={data?.freeTime?.total_classes ?? '—'} />
            </> : <>
              <p>Using assigned timetable entries and role-scoped class data.</p>
              <Metric label="Authorized timetable entries" value={timetableEntries.length} />
              <Metric label="Assigned subjects" value={assignedSubjects.length} />
              <Metric label="Authorized students" value={data?.overview?.total_students_analyzed ?? '—'} />
            </>}
            <button className="button secondary" onClick={reload} type="button">Refresh context</button>
          </details>
        </div>
      )}
    </div>
  )
}

function TransportRouteCard({
  route,
  admin,
  action,
  onUpdate,
  onDelete,
  onAssign,
  onRemove,
}) {
  const [editing, setEditing] = useState(false)
  const [studentId, setStudentId] = useState('')
  const [pickupPoint, setPickupPoint] = useState(route.pickup_points[0] || '')
  const [dropPoint, setDropPoint] = useState(route.drop_points[0] || '')
  const [assignmentError, setAssignmentError] = useState('')

  async function assign(event) {
    event.preventDefault()
    const assignment = { student_id: studentId, pickup_point: pickupPoint, drop_point: dropPoint }
    const validationError = validateTransportAssignment(assignment)
    if (validationError) {
      setAssignmentError(validationError)
      return
    }
    setAssignmentError('')
    const succeeded = await onAssign(route.id, assignment)
    if (succeeded) setStudentId('')
  }

  return (
    <article className="transport-route-card">
      <div className="transport-route-heading">
        <div>
          <p className="eyebrow">ROUTE {route.route_number}</p>
          <h3>{route.bus_number} <span className="muted">· {route.registration_number}</span></h3>
          <p>Driver: {route.driver.name}</p>
        </div>
        <span className="transport-seats">{route.available_seats} of {route.capacity} seats available</span>
      </div>
      <div className="transport-stops">
        <div><strong>Pickup points</strong><p>{route.pickup_points.join(' · ')}</p></div>
        <div><strong>Drop points</strong><p>{route.drop_points.join(' · ')}</p></div>
      </div>
      {admin && (
        <div className="transport-admin-tools">
          <details>
            <summary>Assigned students ({route.assigned_seats})</summary>
            {route.assignments?.length ? (
              <ul className="transport-assignment-list">
                {route.assignments.map((assignment) => (
                  <li key={assignment.student_id}>
                    <span>{assignment.student_id}: {assignment.pickup_point} → {assignment.drop_point}</span>
                    <button
                      className="button danger small"
                      disabled={Boolean(action)}
                      onClick={() => onRemove(route.id, assignment.student_id)}
                      type="button"
                    >Remove</button>
                  </li>
                ))}
              </ul>
            ) : <Empty>No students are assigned to this route.</Empty>}
          </details>
          {route.available_seats > 0 && (
            <form className="transport-assignment-form" onSubmit={assign}>
              <label>Student ID
                <input maxLength="50" onChange={(event) => setStudentId(event.target.value)} required value={studentId} />
              </label>
              <label>Pickup
                <select onChange={(event) => setPickupPoint(event.target.value)} value={pickupPoint}>
                  {route.pickup_points.map((point) => <option key={point}>{point}</option>)}
                </select>
              </label>
              <label>Drop
                <select onChange={(event) => setDropPoint(event.target.value)} value={dropPoint}>
                  {route.drop_points.map((point) => <option key={point}>{point}</option>)}
                </select>
              </label>
              <button className="button secondary" disabled={Boolean(action)} type="submit">
                {action === `assign-${route.id}` ? 'Assigning…' : 'Assign student'}
              </button>
              <ErrorMessage error={assignmentError} />
            </form>
          )}
          {route.available_seats === 0 && <p className="muted">This route is at capacity.</p>}
          <div className="transport-route-actions">
            <button className="button secondary small" disabled={Boolean(action)} onClick={() => setEditing(!editing)} type="button">
              {editing ? 'Cancel edit' : 'Edit route'}
            </button>
            <button className="button danger small" disabled={Boolean(action) || route.assigned_seats > 0} onClick={() => onDelete(route.id)} type="button">
              {action === `delete-${route.id}` ? 'Deleting…' : 'Delete route'}
            </button>
          </div>
          {editing && (
            <TransportRouteForm
              busy={Boolean(action)}
              initialValue={transportFormFromRoute(route)}
              onCancel={() => setEditing(false)}
              onSubmit={async (payload) => {
                if (await onUpdate(route.id, payload)) setEditing(false)
              }}
              submitLabel="Save route"
            />
          )}
        </div>
      )}
    </article>
  )
}

function TransportPage({ data, busy, error, profile, reload }) {
  const [formOpen, setFormOpen] = useState(false)
  const [action, setAction] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const routes = data?.routes || []
  const admin = profile.role === 'admin'
  const token = () => sessionStorage.getItem('smart-campus-token')

  async function performAction(key, method, path, body, message) {
    setAction(key)
    setActionError('')
    setNotice('')
    try {
      await apiRequest(path, { method, token: token(), ...(body ? { body } : {}) })
      setNotice(message)
      await reload()
      return true
    } catch (requestError) {
      setActionError(requestError.message)
      return false
    } finally {
      setAction('')
    }
  }

  const addRoute = (route) => performAction(
    'create',
    'POST',
    '/transport/routes',
    route,
    'Transport route added.',
  )

  const updateRoute = (routeId, route) => performAction(
    `update-${routeId}`,
    'PATCH',
    `/transport/routes/${encodeURIComponent(routeId)}`,
    route,
    'Transport route updated.',
  )

  async function deleteRoute(routeId) {
    if (!globalThis.confirm('Delete this transport route?')) return false
    return performAction(
      `delete-${routeId}`,
      'DELETE',
      `/transport/routes/${encodeURIComponent(routeId)}`,
      undefined,
      'Transport route deleted.',
    )
  }

  const assignStudent = (routeId, assignment) => performAction(
    `assign-${routeId}`,
    'POST',
    `/transport/routes/${encodeURIComponent(routeId)}/assignments`,
    assignment,
    'Student assigned to transport.',
  )

  const removeStudent = (routeId, studentId) => performAction(
    `remove-${routeId}-${studentId}`,
    'DELETE',
    `/transport/routes/${encodeURIComponent(routeId)}/assignments/${encodeURIComponent(studentId)}`,
    undefined,
    'Student removed from the route.',
  )

  const assignedSeats = routes.reduce((total, route) => total + Number(route.assigned_seats || 0), 0)
  const availableSeats = routes.reduce((total, route) => total + availableTransportSeats(route), 0)

  return (
    <>
      <ErrorMessage error={error || actionError} />
      {notice && <div className="alert success" role="status">{notice}</div>}
      {busy && !data ? <Loading label="Loading transport routes…" /> : !data && error ? null : (
        <>
          <section className="metric-grid" aria-label="Transport summary">
            <Metric label="Routes" value={routes.length} detail="Configured bus routes" />
            <Metric label="Assigned seats" value={assignedSeats} detail="Current student assignments" />
            <Metric label="Available seats" value={availableSeats} detail="Across listed buses" />
          </section>
          {!admin && profile.role === 'student' && (
            <section className="panel" aria-labelledby="student-transport-heading">
              <div className="section-heading">
                <div><p className="eyebrow">MY TRANSPORT</p><h2 id="student-transport-heading">Student transport details</h2></div>
              </div>
              {data?.studentTransport?.assigned ? (
                <div className="transport-student-details">
                  <strong>Route {data.studentTransport.route.route_number} · {data.studentTransport.route.bus_number}</strong>
                  <span>Registration: {data.studentTransport.route.registration_number}</span>
                  <span>Pickup: {data.studentTransport.assignment.pickup_point}</span>
                  <span>Drop: {data.studentTransport.assignment.drop_point}</span>
                  <span>Driver: {data.studentTransport.route.driver.name}</span>
                </div>
              ) : (
                <Empty>No transport assignment is recorded for your account.</Empty>
              )}
            </section>
          )}
          {admin && (
            <section className="panel">
              <div className="section-heading">
                <div><p className="eyebrow">ADMINISTRATION</p><h2>Route management</h2></div>
                <button className="button primary" disabled={Boolean(action)} onClick={() => setFormOpen(!formOpen)} type="button">
                  {formOpen ? 'Cancel' : 'Add route'}
                </button>
              </div>
              {formOpen && (
                <TransportRouteForm
                  busy={Boolean(action)}
                  initialValue={{ ...EMPTY_TRANSPORT_FORM }}
                  onSubmit={async (route) => {
                    if (await addRoute(route)) setFormOpen(false)
                  }}
                  submitLabel="Create route"
                />
              )}
            </section>
          )}
          <section className="panel">
            <div className="section-heading">
              <div><p className="eyebrow">TRANSPORT DASHBOARD</p><h2>Bus routes</h2></div>
              <span className="muted">{routes.length} routes</span>
            </div>
            {routes.length === 0 ? <Empty>No transport routes have been configured.</Empty> : (
              <div className="transport-route-list">
                {routes.map((route) => (
                  <TransportRouteCard
                    action={action}
                    admin={admin}
                    key={route.id}
                    onAssign={assignStudent}
                    onDelete={deleteRoute}
                    onRemove={removeStudent}
                    onUpdate={updateRoute}
                    route={route}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </>
  )
}

function LibraryPage({ data, busy, error, profile, reload }) {
  const [search, setSearch] = useState('')
  const [books, setBooks] = useState(null)
  const [searching, setSearching] = useState(false)
  const [action, setAction] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [newBook, setNewBook] = useState({
    title: '', author: '', isbn: '', category: '', total_copies: '1',
  })
  const [stock, setStock] = useState({})
  const activeLoans = (data?.loans || []).filter((loan) => loan.status === 'borrowed')
  const displayedBooks = books ?? data?.books ?? []
  const catalogLoaded = books !== null || data?.books !== undefined

  async function searchBooks(event) {
    event.preventDefault()
    setSearching(true)
    setActionError('')
    try {
      const query = search.trim()
      setBooks(await apiRequest(
        `/library/books${query ? `?search=${encodeURIComponent(query)}` : ''}`,
        { token: sessionStorage.getItem('smart-campus-token') },
      ))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setSearching(false)
    }
  }

  async function performAction(key, operation, message) {
    setAction(key)
    setActionError('')
    setNotice('')
    try {
      await operation()
      setNotice(message)
      setBooks(null)
      await reload()
      return true
    } catch (requestError) {
      setActionError(requestError.message)
      return false
    } finally {
      setAction('')
    }
  }

  async function createBook(event) {
    event.preventDefault()
    const validationError = validateBookForm(newBook)
    if (validationError) {
      setActionError(validationError)
      return
    }
    const created = await performAction('create', () => apiRequest('/library/books', {
      method: 'POST',
      token: sessionStorage.getItem('smart-campus-token'),
      body: { ...newBook, total_copies: Number(newBook.total_copies) },
    }), 'Book added to the catalog.')
    if (created) setNewBook({ title: '', author: '', isbn: '', category: '', total_copies: '1' })
  }

  return (
    <>
      <ErrorMessage error={error || actionError} />
      {notice && <div className="alert success" role="status">{notice}</div>}
      {profile.role === 'admin' && (
        <section className="panel">
          <h2>Add a book</h2>
          <form className="form-grid library-book-form" onSubmit={createBook}>
            {[
              ['title', 'Title', 160],
              ['author', 'Author', 120],
              ['isbn', 'ISBN', 30],
              ['category', 'Category', 60],
            ].map(([field, label, maxLength]) => (
              <label key={field}>{label}
                <input
                  maxLength={maxLength}
                  onChange={(event) => setNewBook((current) => ({ ...current, [field]: event.target.value }))}
                  required
                  value={newBook[field]}
                />
              </label>
            ))}
            <label>Total copies
              <input
                max="10000"
                min="1"
                onChange={(event) => setNewBook((current) => ({ ...current, total_copies: event.target.value }))}
                required
                type="number"
                value={newBook.total_copies}
              />
            </label>
            <button className="button primary" disabled={Boolean(action)} type="submit">
              {action === 'create' ? 'Adding…' : 'Add book'}
            </button>
          </form>
        </section>
      )}
      <section className="panel">
        <div className="section-heading">
          <div><p className="eyebrow">CATALOG</p><h2>Search books</h2></div>
          <span className="muted">{displayedBooks.length} books</span>
        </div>
        <form className="library-search" onSubmit={searchBooks}>
          <label htmlFor="library-search">Title, author, ISBN or category</label>
          <div>
            <input
              id="library-search"
              maxLength="100"
              onChange={(event) => setSearch(event.target.value)}
              value={search}
            />
            <button className="button secondary" disabled={searching} type="submit">
              {searching ? 'Searching…' : 'Search'}
            </button>
            {books !== null && (
              <button
                className="button secondary"
                disabled={searching}
                onClick={() => { setSearch(''); setBooks(null) }}
                type="button"
              >
                Clear
              </button>
            )}
          </div>
        </form>
        {busy && !catalogLoaded ? <Loading label="Loading library…" /> : !catalogLoaded ? null : displayedBooks.length === 0 ? (
          <Empty>{search ? 'No books match your search.' : 'The library catalog is empty.'}</Empty>
        ) : (
          <div className="library-book-list">
            {displayedBooks.map((book) => (
              <article className="library-book" key={book.id}>
                <div>
                  <h3>{book.title}</h3>
                  <p>{book.author} · {book.category}</p>
                  <small>ISBN {book.isbn} · {book.available_copies} of {book.total_copies} available</small>
                </div>
                <div className="library-book-actions">
                  {canBorrowLibraryBook(book, activeLoans.length) ? (
                    <button
                      className="button primary"
                      disabled={Boolean(action)}
                      onClick={() => performAction(`borrow-${book.id}`, () => apiRequest(
                        `/library/books/${encodeURIComponent(book.id)}/borrow`,
                        { method: 'POST', token: sessionStorage.getItem('smart-campus-token') },
                      ), 'Book borrowed. It is due in 14 days.')}
                      type="button"
                    >
                      {action === `borrow-${book.id}` ? 'Borrowing…' : 'Borrow'}
                    </button>
                  ) : <span className="muted">{book.available_copies === 0 ? 'Unavailable' : 'Borrow limit reached'}</span>}
                  {profile.role === 'admin' && (
                    <form
                      className="library-stock-form"
                      onSubmit={(event) => {
                        event.preventDefault()
                        performAction(`stock-${book.id}`, () => apiRequest(
                          `/library/books/${encodeURIComponent(book.id)}`,
                          {
                            method: 'PATCH',
                            token: sessionStorage.getItem('smart-campus-token'),
                            body: { total_copies: Number(stock[book.id] ?? book.total_copies) },
                          },
                        ), 'Book inventory updated.')
                      }}
                    >
                      <label>Total copies
                        <input
                          max="10000"
                          min="1"
                          onChange={(event) => setStock((current) => ({ ...current, [book.id]: event.target.value }))}
                          required
                          type="number"
                          value={stock[book.id] ?? book.total_copies}
                        />
                      </label>
                      <button
                        className="button secondary small"
                        disabled={Boolean(action)}
                        onClick={(event) => {
                          const copies = Number(stock[book.id] ?? book.total_copies)
                          if (!Number.isInteger(copies) || copies < 1 || copies > 10000) {
                            event.preventDefault()
                            setActionError('Total copies must be a whole number from 1 to 10000.')
                          }
                        }}
                        type="submit"
                      >
                        Update stock
                      </button>
                    </form>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">YOUR ACCOUNT</p><h2>Borrowing history</h2></div></div>
        {busy && data?.loans === undefined ? <Loading label="Loading borrowing history…" /> : data?.loans === undefined ? null : data.loans.length === 0 ? (
          <Empty>You have no borrowing history yet.</Empty>
        ) : (
          <div className="library-book-list">
            {data.loans.map((loan) => (
              <article className="library-book" key={loan.id}>
                <div>
                  <h3>{loan.book_title}</h3>
                  <p>Borrowed {new Date(loan.borrowed_at).toLocaleDateString()} · Due {new Date(loan.due_at).toLocaleDateString()}</p>
                  <small>Status: {loan.status}</small>
                </div>
                {loan.status === 'borrowed' && (
                  <button
                    className="button secondary"
                    disabled={Boolean(action)}
                    onClick={() => performAction(`return-${loan.id}`, () => apiRequest(
                      `/library/loans/${encodeURIComponent(loan.id)}/return`,
                      { method: 'POST', token: sessionStorage.getItem('smart-campus-token') },
                    ), 'Book returned.')}
                    type="button"
                  >
                    {action === `return-${loan.id}` ? 'Returning…' : 'Return'}
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function pageTitle(page) {
  return NAV_ITEMS.find(([id]) => id === page)?.[1] || 'Overview'
}

function CampusApp() {
  const [token, setToken] = useState(() => sessionStorage.getItem('smart-campus-token') || '')
  const [profile, setProfile] = useState(null)
  const [page, setPage] = useState('overview')
  const [lostFoundClaimId, setLostFoundClaimId] = useState('')
  const [data, setData] = useState({})
  const [busy, setBusy] = useState(false)
  const [pageError, setPageError] = useState('')
  const [health, setHealth] = useState('checking')

  const visiblePages = useMemo(
    () => NAV_ITEMS.filter(([, , , roles]) => profile && roles.includes(profile.role)),
    [profile],
  )
  const selectedTitle = pageTitle(page)

  const loadProfile = useCallback(async (accessToken) => {
    const currentProfile = await apiRequest('/auth/me', { token: accessToken })
    sessionStorage.setItem('smart-campus-token', accessToken)
    setToken(accessToken)
    setProfile(currentProfile)
    setPage('overview')
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    apiRequest('/health', { signal: controller.signal })
      .then((result) => setHealth(result.status === 'ok' ? 'online' : 'offline'))
      .catch((error) => {
        if (error.name !== 'AbortError') setHealth('offline')
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!token || profile) return
    let active = true
    apiRequest('/auth/me', { token })
      .then((currentProfile) => {
        if (active) setProfile(currentProfile)
      })
      .catch(() => {
        sessionStorage.removeItem('smart-campus-token')
        if (active) {
          setToken('')
          setProfile(null)
        }
      })
    return () => { active = false }
  }, [token, profile])

  const reloadPage = useCallback(async () => {
    if (!token || !profile) return
    try {
      let result
      if (page === 'overview') {
        const calls = [
          apiRequest('/timetable/today', { token }),
          ...(profile.role === 'student' ? [apiRequest('/attendance/me', { token })] : []),
          ...(profile.role === 'student' ? [apiRequest('/students/dashboard/me', { token })] : []),
          ...(profile.role === 'admin' ? [apiRequest('/admin/stats', { token })] : []),
        ]
        const values = await Promise.all(calls)
        result = {
          timetable: values[0],
          ...(profile.role === 'student' ? { attendance: values[1] } : {}),
          ...(profile.role === 'student' ? { studentDashboard: values[2] } : {}),
          ...(profile.role === 'admin' ? { stats: values[1] } : {}),
        }
      } else if (page === 'profile') {
        result = await apiRequest('/students/me', { token })
      } else if (page === 'students') {
        result = await apiRequest('/students', { token })
      } else if (page === 'attendance') {
        const calls = [
          apiRequest(
            profile.role === 'student' ? '/attendance/me' : '/attendance/records',
            { token },
          ),
          ...(profile.role === 'student' ? [] : [apiRequest('/students', { token })]),
        ]
        const values = await Promise.all(calls)
        result = profile.role === 'student'
          ? values[0]
          : { records: values[0], students: values[1] }
      } else if (page === 'timetable') {
        result = await apiRequest('/timetable', { token })
      } else if (page === 'library') {
        const [books, loans] = await Promise.all([
          apiRequest('/library/books', { token }),
          apiRequest('/library/loans', { token }),
        ])
        result = { books, loans }
      } else if (page === 'transport') {
        const [routes, studentTransport] = await Promise.all([
          apiRequest('/transport/routes', { token }),
          ...(profile.role === 'student' ? [apiRequest('/transport/me', { token })] : []),
        ])
        result = {
          routes,
          ...(profile.role === 'student' ? { studentTransport } : {}),
        }
      } else if (page === 'complaints') {
        result = null
      } else if (page === 'lost-found') {
        result = null
      } else if (page === 'notifications') {
        result = profile.role === 'student'
          ? await apiRequest('/notifications', { token })
          : null
      } else if (page === 'academic-report') {
        result = await apiRequest('/academic-intelligence/me', { token })
      } else if (page === 'assistant') {
        if (profile.role === 'student') {
          const [freeTime, academicReport] = await Promise.all([
            apiRequest('/assistant/free-time', { token }),
            apiRequest('/academic-intelligence/me', { token }),
          ])
          result = { freeTime, academicReport }
        } else {
          const [timetable, overview] = await Promise.all([
            apiRequest('/timetable', { token }),
            apiRequest('/academic-intelligence/overview', { token }),
          ])
          result = { timetable, overview }
        }
      } else if (page === 'mood-check-in') {
        result = await apiRequest('/assistant/mood/check-ins', { token })
      } else if (page === 'mood-insights') {
        result = await apiRequest('/assistant/mood/analytics', { token })
      } else if (page === 'intelligence') {
        result = await apiRequest('/academic-intelligence/overview', { token })
      } else if (page === 'admin') {
        const [stats, users] = await Promise.all([
          apiRequest('/admin/stats', { token }),
          apiRequest('/admin/users', { token }),
        ])
        result = { stats, users }
      }
      setData((current) => ({ ...current, [page]: result }))
    } catch (error) {
      setPageError(error.message)
      if (error.status === 401) {
        sessionStorage.removeItem('smart-campus-token')
        setToken('')
        setProfile(null)
      }
    } finally {
      setBusy(false)
    }
  }, [page, profile, token])

  const refreshStudentContexts = useCallback(async () => {
    const [currentProfile, student, attendance, timetable, todayTimetable, freeTime, notifications] =
      await Promise.all([
        apiRequest('/auth/me', { token }),
        apiRequest('/students/me', { token }),
        apiRequest('/attendance/me', { token }),
        apiRequest('/timetable', { token }),
        apiRequest('/timetable/today', { token }),
        apiRequest('/assistant/free-time', { token }),
        apiRequest('/notifications', { token }),
      ])
    setPageError('')
    setProfile(currentProfile)
    setData((current) => ({
      ...current,
      profile: student,
      attendance,
      timetable,
      overview: { timetable: todayTimetable, attendance },
      assistant: { freeTime, attendance },
      notifications,
    }))
  }, [token])

  // This effect synchronizes the active page with its remote API data.
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect
    if (profile && visiblePages.some(([id]) => id === page)) reloadPage()
  }, [profile, page, visiblePages, reloadPage])

  function logout() {
    if (profile?.id) {
      for (const mode of ['general', 'placement', 'study', 'mood']) {
        sessionStorage.removeItem(`smart-campus-assistant-${profile.role}-${profile.id}-${mode}`)
      }
      sessionStorage.removeItem(`smart-campus-assistant-${profile.role}-${profile.id}`)
      sessionStorage.removeItem(`smart-campus-assistant-${profile.id}`)
    }
    sessionStorage.removeItem('smart-campus-token')
    setToken('')
    setProfile(null)
    setData({})
    setPage('overview')
    setLostFoundClaimId('')
  }

  function openLostFoundClaim(claimId = '') {
    setLostFoundClaimId(claimId || '')
    setPageError('')
    setPage('lost-found')
  }

  if (!token || !profile) return <AuthScreen onAuthenticated={loadProfile} />

  const currentData = data[page]
  const pageBusy = busy || (currentData === undefined && !pageError)
  let pageContent
  if (page === 'overview') {
    pageContent = <DashboardPage data={currentData} busy={pageBusy} error={pageError} health={health} profile={profile} setPage={setPage} />
  } else if (page === 'profile') {
    pageContent = <ProfilePage busy={pageBusy} data={currentData} error={pageError} onLinked={refreshStudentContexts} profile={profile} />
  } else if (page === 'academic-report') {
    pageContent = <StudentAcademicReportPage busy={pageBusy} data={currentData} error={pageError} />
  } else if (page === 'students') {
    pageContent = <StudentsPage busy={pageBusy} data={currentData} error={pageError} />
  } else if (page === 'attendance') {
    pageContent = <AttendancePage
      busy={pageBusy}
      data={profile.role === 'student' ? currentData : currentData?.records}
      error={pageError}
      profile={profile}
      reload={reloadPage}
      students={currentData?.students}
    />
  } else if (page === 'timetable') {
    pageContent = <TimetablePage busy={pageBusy} data={currentData} error={pageError} profile={profile} reload={reloadPage} />
  } else if (page === 'library') {
    pageContent = <LibraryPage busy={pageBusy} data={currentData} error={pageError} profile={profile} reload={reloadPage} />
  } else if (page === 'transport') {
    pageContent = <TransportPage busy={pageBusy} data={currentData} error={pageError} profile={profile} reload={reloadPage} />
  } else if (page === 'complaints') {
    pageContent = <ComplaintsPage profile={profile} token={token} />
  } else if (page === 'lost-found') {
    pageContent = <LostAndFoundPage openClaimId={lostFoundClaimId} profile={profile} token={token} />
  } else if (page === 'notifications') {
    pageContent = <NotificationsPage busy={pageBusy} data={currentData} error={pageError} openLostFoundClaim={openLostFoundClaim} profile={profile} reload={reloadPage} />
  } else if (page === 'assistant') {
    pageContent = <AssistantPage key={`${profile.role}:${profile.id}`} busy={pageBusy} data={currentData} error={pageError} reload={reloadPage} profile={profile} />
  } else if (page === 'mood-check-in') {
    pageContent = <MoodCheckInPage busy={pageBusy} data={currentData} error={pageError} reload={reloadPage} token={token} />
  } else if (page === 'mood-insights') {
    pageContent = <MoodInsightsPage busy={pageBusy} data={currentData} error={pageError} />
  } else if (page === 'intelligence') {
    pageContent = <AcademicIntelligencePage busy={pageBusy} data={currentData} error={pageError} profile={profile} />
  } else {
    pageContent = <AdminPage busy={pageBusy} data={currentData} error={pageError} reload={reloadPage} />
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={() => setPage('overview')}>
          <span className="brand-mark">SC</span>
          <span><strong>Smart Campus</strong><small>Management portal</small></span>
        </a>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {visiblePages.map(([id, label, short]) => (
            <button
              aria-current={page === id ? 'page' : undefined}
              className={`nav-item ${page === id ? 'active' : ''}`}
              key={id}
              onClick={() => {
                setPageError('')
                setLostFoundClaimId('')
                setPage(id)
              }}
              type="button"
            >
              <span className="nav-icon">{short}</span>{label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile-chip">
            <span className="profile-avatar">{(profile.name || 'SC').slice(0, 2).toUpperCase()}</span>
            <span><strong>{profile.name}</strong><small>{profile.role}</small></span>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div><span className="muted">Workspace</span><span className="slash">/</span><strong>{selectedTitle}</strong></div>
          <div className="topbar-actions">
            <span className={`api-state ${health}`}><i /> API {health}</span>
            <button className="button secondary small" onClick={logout} type="button">Log out</button>
          </div>
        </header>
        <div className={`content ${page === 'assistant' ? 'content-assistant' : ''}`}>
          {page !== 'assistant' && <section className="page-heading">
            <div><p className="eyebrow">{profile.role.toUpperCase()} WORKSPACE</p><h1>{selectedTitle}</h1></div>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setPageError('')
                setBusy(true)
                reloadPage()
              }}
              type="button"
            >
              Refresh
            </button>
          </section>}
          {page === 'assistant'
            ? <div className="assistant-page-body">{pageContent}</div>
            : <>
              {pageContent}
              <footer className="page-footer">Smart Campus Management System · Express API at {API_BASE_URL}</footer>
            </>}
        </div>
      </main>
    </div>
  )
}

export default CampusApp
