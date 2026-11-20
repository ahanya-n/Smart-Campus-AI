import { useCallback, useEffect, useState } from 'react'

import { apiRequest } from './api'
import {
  COMPLAINT_CATEGORIES,
  COMPLAINT_STATUSES,
  validateComplaintForm,
  validateComplaintResponse,
} from './complaints'

const EMPTY_FORM = { category: 'academic', title: '', description: '' }
const EMPTY_STATS = { total: 0, pending: 0, in_progress: 0, resolved: 0, rejected: 0 }

function labelFor(options, value) {
  return options.find(([key]) => key === value)?.[1] || value
}

function ComplaintDate({ value }) {
  if (!value) return null
  const date = new Date(value)
  return <span>{Number.isNaN(date.valueOf()) ? value : date.toLocaleString()}</span>
}

export default function ComplaintsPage({ profile, token }) {
  const admin = profile.role === 'admin'
  const [items, setItems] = useState([])
  const [stats, setStats] = useState(EMPTY_STATS)
  const [staff, setStaff] = useState([])
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [statusDraft, setStatusDraft] = useState({})
  const [assigneeDraft, setAssigneeDraft] = useState({})
  const [responses, setResponses] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const query = new URLSearchParams()
    if (appliedSearch) query.set('search', appliedSearch)
    if (statusFilter) query.set('status', statusFilter)
    if (categoryFilter) query.set('category', categoryFilter)
    try {
      const suffix = query.size ? `?${query}` : ''
      const requests = [apiRequest(`/complaints${suffix}`, { token })]
      if (admin) {
        requests.push(
          apiRequest('/complaints/stats', { token }),
          apiRequest('/admin/users', { token }),
        )
      }
      const [list, nextStats, users] = await Promise.all(requests)
      setItems(Array.isArray(list?.items) ? list.items : [])
      if (admin) {
        setStats(nextStats)
        setStaff((users || []).filter((user) => ['faculty', 'admin'].includes(user.role)))
      }
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }, [admin, appliedSearch, categoryFilter, statusFilter, token])

  useEffect(() => {
    load()
  }, [load])

  async function perform(id, method, path, body, successMessage) {
    setAction(id)
    setError('')
    setNotice('')
    try {
      await apiRequest(path, { method, token, body })
      setNotice(successMessage)
      await load()
      return true
    } catch (requestError) {
      setError(requestError.message)
      return false
    } finally {
      setAction('')
    }
  }

  async function submitComplaint(event) {
    event.preventDefault()
    const validationError = validateComplaintForm(form)
    if (validationError) {
      setFormError(validationError)
      return
    }
    setFormError('')
    setAction('create')
    try {
      await apiRequest('/complaints', {
        method: 'POST',
        token,
        body: {
          category: form.category,
          title: form.title.trim(),
          description: form.description.trim(),
        },
      })
      setForm(EMPTY_FORM)
      setNotice('Your complaint was submitted.')
      await load()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setAction('')
    }
  }

  async function submitResponse(event, complaint) {
    event.preventDefault()
    const draft = responses[complaint.id] || { message: '', resolution_notes: '' }
    const validationError = validateComplaintResponse(
      draft.message,
      draft.resolution_notes,
    )
    if (validationError) {
      setError(validationError)
      return
    }
    const saved = await perform(
      `respond-${complaint.id}`,
      'POST',
      `/complaints/${encodeURIComponent(complaint.id)}/responses`,
      {
        message: draft.message.trim(),
        resolution_notes: draft.resolution_notes.trim() || undefined,
      },
      'Response added.',
    )
    if (saved) {
      setResponses((current) => ({ ...current, [complaint.id]: { message: '', resolution_notes: '' } }))
    }
  }

  return (
    <>
      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert success" role="status">{notice}</div>}
      <div className="page-heading">
        <div>
          <p className="eyebrow">{admin ? 'ADMINISTRATION' : 'STUDENT SERVICES'}</p>
          <h1>Complaints</h1>
        </div>
        <button className="button secondary" disabled={loading} onClick={load} type="button">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {admin ? (
        <section className="metric-grid" aria-label="Complaint statistics">
          <article className="metric-card"><span>Total complaints</span><strong>{stats.total}</strong></article>
          <article className="metric-card"><span>Pending</span><strong>{stats.pending}</strong></article>
          <article className="metric-card"><span>In progress</span><strong>{stats.in_progress}</strong></article>
          <article className="metric-card"><span>Resolved</span><strong>{stats.resolved}</strong></article>
          <article className="metric-card"><span>Rejected</span><strong>{stats.rejected}</strong></article>
        </section>
      ) : (
        <section className="panel" aria-labelledby="complaint-submit-heading">
          <div className="section-heading">
            <div><p className="eyebrow">NEW REQUEST</p><h2 id="complaint-submit-heading">Submit a complaint</h2></div>
          </div>
          {formError && <div className="alert error" role="alert">{formError}</div>}
          <form className="form-grid complaint-form" onSubmit={submitComplaint}>
            <label>Category
              <select
                onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
                value={form.category}
              >
                {COMPLAINT_CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>Title
              <input
                maxLength="120"
                minLength="3"
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                required
                value={form.title}
              />
            </label>
            <label className="complaint-description">Description
              <textarea
                maxLength="5000"
                minLength="10"
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                required
                rows="4"
                value={form.description}
              />
            </label>
            <button className="button primary" disabled={Boolean(action)} type="submit">
              {action === 'create' ? 'Submitting…' : 'Submit complaint'}
            </button>
          </form>
        </section>
      )}

      {admin && (
        <form
          className="complaint-filters panel"
          onSubmit={(event) => {
            event.preventDefault()
            setAppliedSearch(search.trim())
          }}
        >
          <label>Search complaints
            <input maxLength="100" onChange={(event) => setSearch(event.target.value)} value={search} />
          </label>
          <label>Status
            <select onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
              <option value="">All statuses</option>
              {COMPLAINT_STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>Category
            <select onChange={(event) => setCategoryFilter(event.target.value)} value={categoryFilter}>
              <option value="">All categories</option>
              {COMPLAINT_CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button className="button secondary" disabled={loading} type="submit">Search</button>
        </form>
      )}

      <section className="panel">
        <div className="section-heading">
          <div><p className="eyebrow">{admin ? 'CASE MANAGEMENT' : 'YOUR REQUESTS'}</p><h2>{admin ? 'Complaint queue' : 'Submitted complaints'}</h2></div>
          <span className="muted">{items.length} shown</span>
        </div>
        {loading && items.length === 0 ? <p className="state-message" role="status">Loading complaints…</p> : null}
        {!loading && items.length === 0 && !error ? (
          <div className="empty-state">{admin ? 'No complaints match these filters.' : 'You have not submitted any complaints.'}</div>
        ) : (
          <div className="complaint-list">
            {items.map((complaint) => {
              const responseDraft = responses[complaint.id] || { message: '', resolution_notes: '' }
              return (
                <article className="complaint-card" key={complaint.id}>
                  <div className="complaint-card-heading">
                    <div>
                      <p className="eyebrow">{labelFor(COMPLAINT_CATEGORIES, complaint.category)}{admin ? ` · ${complaint.student_name}` : ''}</p>
                      <h3>{complaint.title}</h3>
                      {admin && <p className="muted">{complaint.student_id || complaint.student_email}</p>}
                    </div>
                    <span className={`complaint-status status-${complaint.status}`}>{labelFor(COMPLAINT_STATUSES, complaint.status)}</span>
                  </div>
                  <p className="complaint-description-text">{complaint.description}</p>
                  <p className="muted">Submitted <ComplaintDate value={complaint.created_at} /></p>
                  {complaint.assigned_staff_name && <p className="muted">Assigned to {complaint.assigned_staff_name}</p>}
                  {complaint.resolution_notes && <p className="complaint-resolution"><strong>Resolution notes:</strong> {complaint.resolution_notes}</p>}
                  {admin && (
                    <div className="complaint-admin-controls">
                      <label>Status
                        <select
                          onChange={(event) => setStatusDraft((current) => ({ ...current, [complaint.id]: event.target.value }))}
                          value={statusDraft[complaint.id] ?? complaint.status}
                        >
                          {COMPLAINT_STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      </label>
                      <button
                        className="button secondary"
                        disabled={Boolean(action)}
                        onClick={() => perform(
                          `status-${complaint.id}`,
                          'PATCH',
                          `/complaints/${encodeURIComponent(complaint.id)}`,
                          { status: statusDraft[complaint.id] ?? complaint.status },
                          'Complaint status updated.',
                        )}
                        type="button"
                      >
                        {action === `status-${complaint.id}` ? 'Saving…' : 'Update status'}
                      </button>
                      <label>Responsible staff
                        <select
                          onChange={(event) => setAssigneeDraft((current) => ({ ...current, [complaint.id]: event.target.value }))}
                          value={assigneeDraft[complaint.id] ?? complaint.assigned_to ?? ''}
                        >
                          <option value="">Unassigned</option>
                          {staff.map((person) => <option key={person.id} value={person.id}>{person.name} ({person.role})</option>)}
                        </select>
                      </label>
                      <button
                        className="button secondary"
                        disabled={Boolean(action)}
                        onClick={() => perform(
                          `assign-${complaint.id}`,
                          'PATCH',
                          `/complaints/${encodeURIComponent(complaint.id)}`,
                          { assigned_to: assigneeDraft[complaint.id] || null },
                          'Complaint assignment updated.',
                        )}
                        type="button"
                      >
                        {action === `assign-${complaint.id}` ? 'Saving…' : 'Save assignment'}
                      </button>
                    </div>
                  )}
                  <details className="complaint-responses">
                    <summary>Details and responses ({complaint.responses.length})</summary>
                    {complaint.responses.length === 0
                      ? <p className="muted">No response has been added.</p>
                      : complaint.responses.map((response) => (
                        <div className="complaint-response" key={response.id}>
                          <strong>{response.author_name || 'Campus staff'}</strong>
                          <p>{response.message}</p>
                          {response.resolution_notes && <p><strong>Resolution:</strong> {response.resolution_notes}</p>}
                          <small><ComplaintDate value={response.created_at} /></small>
                        </div>
                      ))}
                    {admin && (
                      <form className="form-grid complaint-response-form" onSubmit={(event) => submitResponse(event, complaint)}>
                        <label>Response
                          <textarea
                            maxLength="3000"
                            onChange={(event) => setResponses((current) => ({ ...current, [complaint.id]: { ...responseDraft, message: event.target.value } }))}
                            required
                            rows="2"
                            value={responseDraft.message}
                          />
                        </label>
                        <label>Resolution notes (optional)
                          <textarea
                            maxLength="3000"
                            onChange={(event) => setResponses((current) => ({ ...current, [complaint.id]: { ...responseDraft, resolution_notes: event.target.value } }))}
                            rows="2"
                            value={responseDraft.resolution_notes}
                          />
                        </label>
                        <button className="button primary" disabled={Boolean(action)} type="submit">
                          {action === `respond-${complaint.id}` ? 'Saving…' : 'Add response'}
                        </button>
                      </form>
                    )}
                  </details>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </>
  )
}
