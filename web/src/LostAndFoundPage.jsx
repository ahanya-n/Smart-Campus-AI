import { useCallback, useEffect, useState } from 'react'
import { apiRequest } from './api'
import {
  INITIAL_LOST_FOUND_REPORT,
  LOST_FOUND_CATEGORIES,
  canRequestLostFoundMatch,
  formatReportDateTime,
  validateLostFoundImage,
  validateLostFoundReport,
} from './lostAndFound'

const PAGE = {
  LANDING: 'landing',
  FORM: 'form',
  REVIEW: 'review',
  REPORTS: 'reports',
  MATCHES: 'matches',
  DETAILS: 'details',
  CLAIMS: 'claims',
}

function ReportImage({ report, large = false, token }) {
  const [authenticatedPreview, setAuthenticatedPreview] = useState('')
  const imagePath = typeof report.image_url === 'string' &&
    /^\/api\/lost-found\/(?:images\/[a-f\d]{40}\.(?:jpg|png|webp)|matches\/[a-f\d]{24}\/image)$/i.test(report.image_url)
    ? report.image_url
    : ''

  useEffect(() => {
    let active = true
    let objectUrl = ''
    // eslint-disable-next-line react/set-state-in-effect
    setAuthenticatedPreview('')
    if (imagePath && token) {
      fetch(imagePath, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((response) => response.ok ? response.blob() : Promise.reject(new Error('Image unavailable')))
        .then((blob) => {
          if (!active) return
          objectUrl = URL.createObjectURL(blob)
          setAuthenticatedPreview(objectUrl)
        })
        .catch(() => {
          if (active) setAuthenticatedPreview('')
        })
    }
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [imagePath, token])

  const preview = authenticatedPreview || report.imagePreview
  if (preview) {
    return (
      <img
        alt={report.itemName ? `${report.itemName} preview` : 'Selected item preview'}
        className={large ? 'lf-image lf-image-large' : 'lf-image'}
        src={preview}
      />
    )
  }
  return (
    <div className={large ? 'lf-image-placeholder lf-image-large' : 'lf-image-placeholder'} aria-label="No item image provided">
      <span>{report.category?.slice(0, 1) || 'LF'}</span>
      <small>No image</small>
    </div>
  )
}

function StatusBadge({ status }) {
  const normalized = String(status || 'active').toLowerCase().replaceAll('_', '-')
  const labels = {
    active: 'Active',
    match_found: 'Match found',
    verification_pending: 'Verification pending',
    pending: 'Awaiting review',
    approved: 'Request approved',
    rejected: 'Request rejected',
    resolved: 'Resolved',
    closed: 'Closed',
  }
  return <span className={`lf-status lf-status-${normalized}`}>{labels[String(status)] || String(status)}</span>
}

function normalizeReport(report) {
  return {
    ...report,
    type: report.report_type,
    itemName: report.item_name,
    brand: report.brand || '',
    description: report.description || '',
    category: report.category || '',
    colour: report.colour || '',
    date: report.event_date || '',
    time: report.event_time || '',
    location: report.location || '',
    identifyingDetails: report.additional_details || '',
  }
}

export default function LostAndFoundPage({ profile, token, openClaimId = '' }) {
  const [view, setView] = useState(PAGE.LANDING)
  const [reportType, setReportType] = useState('lost')
  const [form, setForm] = useState({ ...INITIAL_LOST_FOUND_REPORT })
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [reports, setReports] = useState([])
  const [incomingClaims, setIncomingClaims] = useState([])
  const [selectedClaimId, setSelectedClaimId] = useState('')
  const [selectedReportId, setSelectedReportId] = useState(null)
  const [matchResults, setMatchResults] = useState(null)
  const [matchRequestId, setMatchRequestId] = useState(null)
  const [loading, setLoading] = useState(false)
  const [aiCategory, setAiCategory] = useState('')
  const [aiColour, setAiColour] = useState('')

  useEffect(() => () => {
    if (form.imagePreview?.startsWith('blob:')) URL.revokeObjectURL(form.imagePreview)
  }, [form.imagePreview])

  const selectedReport = reports.find((report) => report.id === selectedReportId) || reports[0]

  const loadReports = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setFormError('')
    try {
      const result = await apiRequest('/lost-found/my-reports', { token })
      const normalized = (result.items || []).map(normalizeReport)
      setReports(normalized)
      setSelectedReportId((current) => {
        if (current && normalized.some((report) => report.id === current)) return current
        return normalized[0]?.id || null
      })
    } catch (error) {
      setFormError(error.message)
    } finally {
      setLoading(false)
    }
  }, [token])

  const loadIncomingClaims = useCallback(async (targetClaimId = '') => {
    if (!token) return
    setLoading(true)
    setFormError('')
    try {
      const result = await apiRequest('/lost-found/claims/incoming', { token })
      setIncomingClaims(result.items || [])
      setSelectedClaimId(targetClaimId)
      setSelectedReportId(null)
      setView(PAGE.CLAIMS)
    } catch (error) {
      setFormError(error.message)
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect
    loadReports()
  }, [loadReports])

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect
    if (openClaimId) loadIncomingClaims(openClaimId)
  }, [loadIncomingClaims, openClaimId])

  useEffect(() => {
    if (!selectedClaimId || view !== PAGE.CLAIMS) return
    document.getElementById(`lost-found-claim-${selectedClaimId}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    })
  }, [incomingClaims, selectedClaimId, view])

  function openForm(type) {
    setReportType(type)
    setForm({ ...INITIAL_LOST_FOUND_REPORT })
    setFormError('')
    setNotice('')
    setView(PAGE.FORM)
  }

  function updateField(event) {
    const { name, value } = event.target
    setForm((current) => ({ ...current, [name]: value }))
  }

  function selectImage(event) {
    const file = event.target.files?.[0]
    if (!file) return
    const error = validateLostFoundImage(file)
    if (error) {
      event.target.value = ''
      setFormError(error)
      return
    }

    setForm((current) => {
      if (current.imagePreview?.startsWith('blob:')) URL.revokeObjectURL(current.imagePreview)
      return {
        ...current,
        image: file,
        imageName: file.name,
        imagePreview: URL.createObjectURL(file),
      }
    })
    setFormError('')
  }

  function removeImage() {
    setForm((current) => {
      if (current.imagePreview?.startsWith('blob:')) URL.revokeObjectURL(current.imagePreview)
      return { ...current, image: null, imageName: '', imagePreview: '' }
    })
  }

  function continueToReview(event) {
    event.preventDefault()
    const error = validateLostFoundReport(form)
    if (error) {
      setFormError(error)
      return
    }
    setFormError('')
    setView(PAGE.REVIEW)
  }

  async function readImageData(file) {
    if (!file) return null
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result || '')
        const comma = result.indexOf(',')
        resolve({
          name: file.name,
          type: file.type,
          size: file.size,
          data: comma >= 0 ? result.slice(comma + 1) : result,
        })
      }
      reader.onerror = () => reject(new Error('Could not read the selected image.'))
      reader.readAsDataURL(file)
    })
  }

  async function submitReport() {
    setLoading(true)
    setFormError('')
    setNotice('')
    try {
      const image = await readImageData(form.image)
      const created = await apiRequest('/lost-found', {
        token,
        method: 'POST',
        body: {
          report_type: reportType,
          item_name: form.itemName.trim(),
          brand: form.brand.trim(),
          description: form.description.trim(),
          category: form.category,
          colour: form.colour.trim(),
          event_date: form.date,
          event_time: form.time,
          location: form.location.trim(),
          additional_details: form.identifyingDetails.trim(),
          image,
        },
      })
      await loadReports()
      setSelectedReportId(created.id)
      setNotice('Lost and Found report submitted successfully.')
      setView(PAGE.REPORTS)
    } catch (error) {
      setFormError(error.message)
      setView(PAGE.FORM)
    } finally {
      setLoading(false)
    }
  }

  async function closeReport(reportId) {
    setLoading(true)
    setFormError('')
    setNotice('')
    try {
      await apiRequest(`/lost-found/${encodeURIComponent(reportId)}/close`, {
        token,
        method: 'PATCH',
      })
      await loadReports()
      setNotice('Report closed successfully.')
    } catch (error) {
      setFormError(error.message)
    } finally {
      setLoading(false)
    }
  }

  async function resolveReport(reportId) {
    setLoading(true)
    setFormError('')
    setNotice('')
    try {
      await apiRequest(`/lost-found/${encodeURIComponent(reportId)}/resolve`, {
        token,
        method: 'PATCH',
      })
      await loadReports()
      setNotice('Report resolved successfully.')
    } catch (error) {
      setFormError(error.message)
    } finally {
      setLoading(false)
    }
  }

  async function openDetails(reportId) {
    setFormError('')
    setLoading(true)
    try {
      const detail = await apiRequest(`/lost-found/${encodeURIComponent(reportId)}`, { token })
      setSelectedReportId(detail.id)
      setReports((current) => {
        const normalized = normalizeReport(detail)
        const exists = current.some((report) => report.id === normalized.id)
        return exists
          ? current.map((report) => report.id === normalized.id ? normalized : report)
          : [normalized, ...current]
      })
      setAiCategory(detail.ai_analysis?.predicted_category || detail.category || '')
      setAiColour(detail.ai_analysis?.predicted_colour || detail.colour || '')
      setNotice('')
      setView(PAGE.DETAILS)
    } catch (error) {
      setFormError(error.message)
    } finally {
      setLoading(false)
    }
  }

  async function applyAISuggestions(reportId) {
    setLoading(true)
    setFormError('')
    setNotice('')
    try {
      await apiRequest(`/lost-found/${encodeURIComponent(reportId)}/ai-suggestions`, {
        token,
        method: 'PATCH',
        body: { category: aiCategory, colour: aiColour },
      })
      await openDetails(reportId)
      setNotice('AI category and colour suggestions applied to the report.')
    } catch (error) {
      setFormError(error.message)
    } finally {
      setLoading(false)
    }
  }

  async function openMatches(reportId) {
    const report = reports.find((item) => item.id === reportId)
    if (report?.type !== 'lost') {
      setFormError('Only a LOST report can request a possible-item match.')
      return
    }
    setSelectedReportId(reportId)
    setMatchRequestId(null)
    setMatchResults(null)
    setLoading(true)
    setFormError('')
    setNotice('')
    try {
      const results = await apiRequest(
        `/lost-found/${encodeURIComponent(reportId)}/matches`,
        { token },
      )
      setMatchResults(results)
      setView(PAGE.MATCHES)
    } catch (error) {
      setFormError(error.message)
    } finally {
      setLoading(false)
    }
  }

  async function requestMatch(matchId) {
    setLoading(true)
    setFormError('')
    setNotice('')
    try {
      await apiRequest(
        `/lost-found/matches/${encodeURIComponent(matchId)}/request`,
        { token, method: 'POST' },
      )
      setMatchRequestId(matchId)
      setMatchResults((current) => current && ({
        ...current,
        items: current.items.map((match) =>
          match.id === matchId ? { ...match, match_status: 'verification_pending' } : match),
        high_confidence: current.high_confidence.map((match) =>
          match.id === matchId ? { ...match, match_status: 'verification_pending' } : match),
        possible_matches: current.possible_matches.map((match) =>
          match.id === matchId ? { ...match, match_status: 'verification_pending' } : match),
      }))
      setNotice('Match request submitted. No private details were revealed.')
    } catch (error) {
      setFormError(error.message)
    } finally {
      setLoading(false)
    }
  }

  async function reviewMatchRequest(claim, decision) {
    setLoading(true)
    setFormError('')
    setNotice('')
    try {
      const result = await apiRequest(
        `/lost-found/matches/${encodeURIComponent(claim.match_id)}/claims/${encodeURIComponent(claim.id)}/review`,
        { token, method: 'PATCH', body: { decision } },
      )
      setIncomingClaims((current) => current.map((item) =>
        item.id === claim.id ? { ...item, verification_status: result.verification_status } : item))
      setNotice(`Match request ${decision}. No private details were revealed.`)
    } catch (error) {
      setFormError(error.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="lf-page">
      {notice && <div className="alert success" role="status">{notice}</div>}

      {view === PAGE.LANDING && (
        <>
          <section className="lf-landing-banner">
            <div>
              <p className="eyebrow">{profile?.role === 'admin' ? 'CAMPUS SERVICE REVIEW' : 'STUDENT CAMPUS SERVICES'}</p>
              <h2>Lost and Found</h2>
              <p>
                {profile?.role === 'admin'
                  ? 'Review incoming match requests and help verify reports before resolution.'
                  : 'Report an item you lost or found and review potential matches with privacy-conscious details.'}
              </p>
            </div>
            <div className="lf-rule-note">
              <strong>Matching rule</strong>
              <span>Only opposite report types with event timestamps within 24 hours are eligible.</span>
            </div>
          </section>

          {profile?.role !== 'admin' && <section className="lf-action-grid" aria-label="Lost and found report actions">
            <article className="lf-action-card lf-action-lost">
              <span className="lf-action-icon" aria-hidden="true">L</span>
              <div>
                <p className="eyebrow">MISSING ITEM</p>
                <h3>I Lost Something</h3>
                <p>Describe the item and where it went missing.</p>
              </div>
              <button className="button primary" type="button" onClick={() => openForm('lost')}>
                Report lost item
              </button>
            </article>
            <article className="lf-action-card lf-action-found">
              <span className="lf-action-icon" aria-hidden="true">F</span>
              <div>
                <p className="eyebrow">FOUND ITEM</p>
                <h3>I Found Something</h3>
                <p>Share only enough information to help with a match.</p>
              </div>
              <button className="button primary" type="button" onClick={() => openForm('found')}>
                Report found item
              </button>
            </article>
          </section>}

          {profile?.role === 'admin' ? (
            <section className="panel lf-form-panel">
              <div className="section-heading">
                <div><p className="eyebrow">OWNER REVIEW</p><h2>Incoming match requests</h2></div>
                <button className="button primary" type="button" onClick={loadIncomingClaims}>Review requests</button>
              </div>
              <p className="muted">Only report details needed for verification are shown. Similarity scores are not proof of ownership.</p>
            </section>
          ) : <section>
            <div className="section-heading">
              <div>
                <p className="eyebrow">YOUR ACTIVITY</p>
                <h2>Recent reports</h2>
              </div>
              <div className="lf-card-actions">
                <button className="text-button" type="button" onClick={loadIncomingClaims}>
                  Incoming match requests
                </button>
                <button className="text-button" type="button" onClick={() => setView(PAGE.REPORTS)}>
                  View my reports
                </button>
              </div>
            </div>
            {reports.length === 0 ? (
              <div className="empty-state">No Lost and Found reports yet.</div>
            ) : (
              <div className="lf-report-grid">
                {reports.slice(0, 3).map((report) => (
                  <article className="lf-report-card" key={report.id}>
                    <ReportImage report={report} token={token} />
                    <div className="lf-report-card-body">
                      <div className="lf-report-heading">
                        <span className={`lf-type lf-type-${report.type}`}>{report.type === 'lost' ? 'Lost' : 'Found'}</span>
                        <StatusBadge status={report.status} />
                      </div>
                      <h3>{report.itemName}</h3>
                      {report.brand && <p>Brand: {report.brand}</p>}
                      <p>{formatReportDateTime(report.date, report.time)}</p>
                      <p className="lf-location">{report.location}</p>
                      <div className="lf-card-actions">
                        <button className="button secondary small" type="button" onClick={() => openDetails(report.id)}>View details</button>
                        {report.type === 'lost' && report.status !== 'closed' && report.status !== 'resolved' && (
                          <button className="button secondary small" type="button" onClick={() => openMatches(report.id)}>Matches</button>
                        )}
                        {report.type === 'found' && report.status !== 'closed' && report.status !== 'resolved' && (
                          <button className="button secondary small" type="button" onClick={() => loadIncomingClaims()}>Incoming requests</button>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>}
        </>
      )}

      {view === PAGE.FORM && (
        <section className="panel lf-form-panel">
          <div className="lf-form-heading">
            <div>
              <p className="eyebrow">{reportType === 'lost' ? 'LOST REPORT' : 'FOUND REPORT'}</p>
              <h2>{reportType === 'lost' ? 'Report a lost item' : 'Report a found item'}</h2>
            </div>
            <div className="lf-type-switch" aria-label="Choose report type">
              <button className={reportType === 'lost' ? 'active' : ''} type="button" onClick={() => setReportType('lost')}>Lost</button>
              <button className={reportType === 'found' ? 'active' : ''} type="button" onClick={() => setReportType('found')}>Found</button>
            </div>
          </div>

          {formError && <div className="alert error" role="alert">{formError}</div>}
          <form className="lf-form-grid" onSubmit={continueToReview}>
            <label>
              Item name
              <input name="itemName" maxLength="120" value={form.itemName} onChange={updateField} placeholder="e.g. Black backpack" />
            </label>
            <label>
              Brand (optional)
              <input name="brand" maxLength="80" value={form.brand} onChange={updateField} placeholder="e.g. Milton" />
            </label>
            <label>
              Category
              <select name="category" value={form.category} onChange={updateField}>
                <option value="">Choose a category</option>
                {LOST_FOUND_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
            </label>
            <label>
              Colour
              <input name="colour" maxLength="60" value={form.colour} onChange={updateField} placeholder="e.g. Black" />
            </label>
            <label>
              Date
              <input name="date" type="date" value={form.date} onChange={updateField} />
            </label>
            <label>
              Approximate time
              <input name="time" type="time" value={form.time} onChange={updateField} />
            </label>
            <label>
              Location
              <input name="location" maxLength="200" value={form.location} onChange={updateField} placeholder="Building or nearby landmark" />
            </label>
            <label className="lf-description-field">
              Description
              <textarea name="description" maxLength="1000" rows="4" value={form.description} onChange={updateField} placeholder="Describe the item and visible identifying features." />
              <small>{form.description.length}/1000</small>
            </label>
            <label className="lf-identifying-field">
              Additional identifying details (optional)
              <textarea name="identifyingDetails" maxLength="1000" rows="3" value={form.identifyingDetails} onChange={updateField} placeholder="Details that can help verify ownership later." />
              <small>{form.identifyingDetails.length}/1000</small>
            </label>

            <fieldset className="lf-image-field">
              <legend>Image</legend>
              {form.imagePreview ? (
                <div className="lf-image-editor">
                  <img alt={`${form.itemName || 'Selected item'} preview`} src={form.imagePreview} />
                  <div>
                    <strong>{form.imageName}</strong>
                    <div className="lf-card-actions">
                      <label className="button secondary small lf-change-image">
                        Change image
                        <input accept="image/jpeg,image/png,image/webp" type="file" onChange={selectImage} />
                      </label>
                      <button className="button danger small" type="button" onClick={removeImage}>Remove</button>
                    </div>
                  </div>
                </div>
              ) : (
                <label className="lf-upload">
                  <input accept="image/jpeg,image/png,image/webp" type="file" onChange={selectImage} />
                  <strong>Choose an item image</strong>
                  <span>JPG, PNG or WebP · Maximum 5 MB</span>
                </label>
              )}
            </fieldset>

            <div className="lf-form-actions">
              <button className="button secondary" type="button" onClick={() => setView(PAGE.LANDING)}>Cancel</button>
              <button className="button primary" type="submit">Review details</button>
            </div>
          </form>
        </section>
      )}

      {view === PAGE.REVIEW && (
        <section className="panel lf-review-panel">
          <div className="lf-form-heading">
            <div>
              <p className="eyebrow">BEFORE SUBMISSION</p>
              <h2>Review report details</h2>
            </div>
            <span className={`lf-type lf-type-${reportType}`}>{reportType === 'lost' ? 'Lost report' : 'Found report'}</span>
          </div>
          <div className="lf-review-grid">
            <ReportImage report={form} large token={token} />
            <dl className="lf-details-list">
              <div><dt>Item name</dt><dd>{form.itemName}</dd></div>
              {form.brand && <div><dt>Brand</dt><dd>{form.brand}</dd></div>}
              <div><dt>Category</dt><dd>{form.category}</dd></div>
              <div><dt>Colour</dt><dd>{form.colour}</dd></div>
              <div><dt>Date and time</dt><dd>{formatReportDateTime(form.date, form.time)}</dd></div>
              <div><dt>Location</dt><dd>{form.location}</dd></div>
              <div><dt>Description</dt><dd>{form.description}</dd></div>
              {form.identifyingDetails && <div><dt>Additional details</dt><dd>{form.identifyingDetails}</dd></div>}
            </dl>
          </div>
          <div className="alert success lf-preview-alert">
            Confirming will send this report to the Smart Campus backend and store it in MongoDB.
          </div>
          <div className="lf-form-actions">
            <button className="button secondary" type="button" onClick={() => setView(PAGE.FORM)}>Edit details</button>
            <button className="button primary" disabled={loading} type="button" onClick={submitReport}>
              {loading ? 'Submitting…' : 'Submit report'}
            </button>
          </div>
        </section>
      )}

      {view === PAGE.REPORTS && (
        <section>
          <div className="lf-toolbar">
            <button className="button secondary" type="button" onClick={() => setView(PAGE.LANDING)}>Back to Lost and Found</button>
            <div className="lf-card-actions">
              <button className="button secondary" type="button" onClick={loadIncomingClaims}>Incoming match requests</button>
              <button className="button primary" type="button" onClick={() => openForm('lost')}>New report</button>
            </div>
          </div>
          {reports.length === 0 ? (
            <div className="empty-state">No Lost and Found reports are available.</div>
          ) : (
            <div className="lf-my-reports">
              {reports.map((report) => (
                <article className="lf-my-report" key={report.id}>
                  <ReportImage report={report} token={token} />
                  <div className="lf-my-report-content">
                    <div className="lf-report-heading">
                      <span className={`lf-type lf-type-${report.type}`}>{report.type === 'lost' ? 'Lost' : 'Found'}</span>
                      <StatusBadge status={report.status} />
                    </div>
                    <h3>{report.itemName}</h3>
                    <p>{report.description}</p>
                    <dl className="lf-summary-list">
                      <div><dt>Date and time</dt><dd>{formatReportDateTime(report.date, report.time)}</dd></div>
                      <div><dt>Location</dt><dd>{report.location}</dd></div>
                      <div><dt>Category</dt><dd>{report.category}</dd></div>
                    </dl>
                  </div>
                  <div className="lf-my-report-actions">
                    <button className="button secondary" type="button" onClick={() => openDetails(report.id)}>View details</button>
                    {report.type === 'lost' && report.status !== 'closed' && report.status !== 'resolved' && (
                      <button className="button secondary" type="button" onClick={() => openMatches(report.id)}>Matching results</button>
                    )}
                    {report.type === 'found' && report.status !== 'closed' && report.status !== 'resolved' && (
                      <button className="button secondary" type="button" onClick={() => loadIncomingClaims()}>Incoming match requests</button>
                    )}
                    {report.status !== 'closed' && report.status !== 'resolved' && (
                      <button className="button danger" type="button" onClick={() => closeReport(report.id)}>Close report</button>
                    )}
                    {report.status !== 'closed' && report.status !== 'resolved' && (
                      <button className="button secondary" type="button" onClick={() => resolveReport(report.id)}>Mark resolved</button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {view === PAGE.CLAIMS && (
        <section>
          <div className="lf-toolbar">
            <button className="button secondary" type="button" onClick={() => setView(PAGE.LANDING)}>Back to Lost and Found</button>
            <h2>Incoming match requests</h2>
          </div>
          {formError && <div className="alert error" role="alert">{formError}</div>}
          {incomingClaims.length === 0 ? (
            <div className="empty-state">No incoming match requests are available for your reports.</div>
          ) : (
            <div className="lf-claim-list">
              {incomingClaims.map((claim) => (
                <article className={`lf-claim-card ${selectedClaimId === claim.id ? 'lf-claim-card-selected' : ''}`} id={`lost-found-claim-${claim.id}`} key={claim.id}>
                  <ReportImage
                    report={{ image_url: claim.owner_report.image_url, itemName: claim.owner_report.item_name }}
                    token={token}
                  />
                  <div className="lf-claim-content">
                    <div className="lf-report-heading">
                      <StatusBadge status={claim.verification_status} />
                      <span className="lf-match-score">
                        {claim.similarity_score == null ? 'Score unavailable' : `${claim.similarity_score}% experimental similarity`}
                      </span>
                    </div>
                    <h3>{claim.requesting_report.item_name} may match your {claim.owner_report.report_type} report</h3>
                    <p>
                      Your report: {claim.owner_report.item_name} · {claim.owner_report.status}
                    </p>
                    <p>
                      Requesting report: {claim.requesting_report.report_type} · {claim.requesting_report.category} ·
                      {' '}{claim.requesting_report.colour} ·
                      {' '}{formatReportDateTime(claim.requesting_report.event_date, claim.requesting_report.event_time)}
                    </p>
                    <p className="muted">
                      Requester identity, description, and exact location remain private. Similarity does not verify ownership.
                    </p>
                    {claim.verification_status === 'pending' ? (
                      <div className="lf-card-actions">
                        <button
                          className="button primary"
                          disabled={loading}
                          type="button"
                          onClick={() => reviewMatchRequest(claim, 'approved')}
                        >
                          Approve request
                        </button>
                        <button
                          className="button secondary"
                          disabled={loading}
                          type="button"
                          onClick={() => reviewMatchRequest(claim, 'rejected')}
                        >
                          Reject request
                        </button>
                      </div>
                    ) : claim.verification_status === 'approved' &&
                      !['closed', 'resolved'].includes(claim.owner_report.status) ? (
                      <button
                        className="button secondary"
                        disabled={loading}
                        type="button"
                        onClick={async () => {
                          await resolveReport(claim.owner_report.id)
                          await loadIncomingClaims()
                        }}
                      >
                        {profile?.role === 'admin' ? 'Mark report resolved' : 'Mark my report resolved'}
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {view === PAGE.DETAILS && selectedReport && (
        <section className="panel lf-details-panel">
          <div className="lf-form-heading">
            <div>
              <p className="eyebrow">REPORT DETAILS</p>
              <h2>{selectedReport.itemName}</h2>
            </div>
            <StatusBadge status={selectedReport.status} />
          </div>
          <div className="lf-review-grid">
            <ReportImage report={selectedReport} large token={token} />
            <dl className="lf-details-list">
              <div><dt>Report type</dt><dd>{selectedReport.type === 'lost' ? 'Lost item' : 'Found item'}</dd></div>
              {selectedReport.brand && <div><dt>Brand</dt><dd>{selectedReport.brand}</dd></div>}
              <div><dt>Category</dt><dd>{selectedReport.category}</dd></div>
              <div><dt>Colour</dt><dd>{selectedReport.colour}</dd></div>
              <div><dt>Date and time</dt><dd>{formatReportDateTime(selectedReport.date, selectedReport.time)}</dd></div>
              <div><dt>Location</dt><dd>{selectedReport.location}</dd></div>
              <div><dt>Description</dt><dd>{selectedReport.description}</dd></div>
              {selectedReport.identifyingDetails && <div><dt>Identifying details</dt><dd>{selectedReport.identifyingDetails}</dd></div>}
            </dl>
          </div>
          {selectedReport.ai_analysis && (
            <div className="lf-business-rules">
              <strong>
                AI image analysis · {selectedReport.ai_analysis.analysis_status} ·
                {' '}{selectedReport.ai_analysis.model || 'unknown model'}
              </strong>
              <span>
                Suggested item: {selectedReport.ai_analysis.predicted_item || 'Uncertain'}.
                Suggested category: {selectedReport.ai_analysis.predicted_category || 'Other'}.
                Suggested colour: {selectedReport.ai_analysis.predicted_colour || 'Unknown'}.
                {' '}AI suggestions are editable; they do not overwrite the original report unless updated below.
              </span>
              {selectedReport.ai_analysis.limitations?.length > 0 && (
                <span>{selectedReport.ai_analysis.limitations.join(' ')}</span>
              )}
              <div className="lf-card-actions">
                <label>Suggested category
                  <select value={aiCategory} onChange={(event) => setAiCategory(event.target.value)}>
                    {LOST_FOUND_CATEGORIES.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                </label>
                <label>Suggested colour
                  <input maxLength="60" value={aiColour} onChange={(event) => setAiColour(event.target.value)} />
                </label>
                <button
                  className="button secondary small"
                  disabled={loading}
                  type="button"
                  onClick={() => applyAISuggestions(selectedReport.id)}
                >
                  Apply suggestions
                </button>
              </div>
            </div>
          )}
          <div className="lf-business-rules">
            <strong>Report rule</strong>
            <span>Reports remain active until you close or resolve them manually. They are not automatically deleted after 24 hours.</span>
          </div>
          <div className="lf-form-actions">
            <button className="button secondary" type="button" onClick={() => setView(PAGE.REPORTS)}>Back to my reports</button>
            {selectedReport.type === 'lost' && selectedReport.status !== 'closed' && selectedReport.status !== 'resolved' && (
              <button className="button primary" type="button" onClick={() => openMatches(selectedReport.id)}>View matching results</button>
            )}
            {selectedReport.type === 'found' && selectedReport.status !== 'closed' && selectedReport.status !== 'resolved' && (
              <button className="button primary" type="button" onClick={() => loadIncomingClaims()}>Review incoming requests</button>
            )}
          </div>
        </section>
      )}

      {view === PAGE.MATCHES && selectedReport && (
        <section>
          <div className="lf-matches-heading">
            <div>
              <p className="eyebrow">POTENTIAL ITEMS</p>
              <h2>Matching results</h2>
              <p className="muted">Results for your {selectedReport.type} report: <strong>{selectedReport.itemName}</strong></p>
            </div>
            <button className="button secondary" type="button" onClick={() => openDetails(selectedReport.id)}>View my report</button>
          </div>

          <div className="lf-privacy-note">
            <strong>Privacy protected</strong>
            <span>Candidate photos are visible only to authorized students. Names, phone numbers, reporter descriptions, and exact sensitive locations are not shown. A similarity score does not verify ownership.</span>
          </div>
          <div className="lf-privacy-note">
            <strong>AI notice</strong>
            <span>AI-generated matches are suggestions only. Similarity scores do not confirm item ownership.</span>
          </div>

          <section>
            <div className="section-heading">
              <div>
                <p className="eyebrow">BEST POTENTIAL RESULTS</p>
                <h2>High-Confidence Matches</h2>
              </div>
              <span className="muted">{matchResults?.high_confidence?.length || 0} shown</span>
            </div>
            {!matchResults?.high_confidence?.length ? (
              <div className="empty-state">No high-confidence matches found yet.</div>
            ) : (
              <div className="lf-match-grid">
                {matchResults.high_confidence.map((match) => (
                  <article className="lf-match-card" key={match.id}>
                      <div className="lf-match-images">
                        <figure>
                          <figcaption>Your lost report</figcaption>
                          <ReportImage report={selectedReport} token={token} />
                        </figure>
                        <figure>
                          <figcaption>Possible found report</figcaption>
                          <ReportImage report={{ ...match, itemName: match.item_name }} token={token} />
                        </figure>
                      </div>
                    <div>
                      <div className="lf-match-score">
                        <strong>{match.similarity_score}%</strong>
                        <span>Experimental similarity</span>
                      </div>
                      <h3>{match.item_name} · {match.category} · {match.colour}</h3>
                      {match.brand && <p>Brand: {match.brand}</p>}
                      <p>{formatReportDateTime(match.event_date, match.event_time)}</p>
                      <p className="lf-location">{match.approximate_location}</p>
                      <p>{match.explanation?.join(' ')}</p>
                      {matchRequestId === match.id || match.match_status === 'verification_pending' ? (
                        <div className="alert success" role="status">Match request submitted. Private details remain hidden.</div>
                      ) : match.match_status === 'approved' ? (
                        <StatusBadge status="approved" />
                      ) : canRequestLostFoundMatch(selectedReport.type, match.report_type) ? (
                        <button className="button primary" disabled={loading} type="button" onClick={() => requestMatch(match.id)}>
                          This may be my item
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="section-heading">
              <div>
                <p className="eyebrow">ADDITIONAL POTENTIAL RESULTS</p>
                <h2>Other Possible Matches</h2>
              </div>
              <span className="muted">{matchResults?.possible_matches?.length || 0} shown</span>
            </div>
            {!matchResults?.possible_matches?.length ? (
              <div className="empty-state">No similar item found yet.</div>
            ) : (
              <div className="lf-match-grid">
                {matchResults.possible_matches.map((match) => (
                  <article className="lf-match-card" key={match.id}>
                      <div className="lf-match-images">
                        <figure>
                          <figcaption>Your lost report</figcaption>
                          <ReportImage report={selectedReport} token={token} />
                        </figure>
                        <figure>
                          <figcaption>Possible found report</figcaption>
                          <ReportImage report={{ ...match, itemName: match.item_name }} token={token} />
                        </figure>
                      </div>
                    <div>
                      <div className="lf-match-score">
                        <strong>{match.similarity_score}%</strong>
                        <span>Experimental similarity</span>
                      </div>
                      <h3>{match.item_name} · {match.category} · {match.colour}</h3>
                      {match.brand && <p>Brand: {match.brand}</p>}
                      <p>{formatReportDateTime(match.event_date, match.event_time)}</p>
                      <p className="lf-location">{match.approximate_location}</p>
                      <p>{match.explanation?.join(' ')}</p>
                      {matchRequestId === match.id || match.match_status === 'verification_pending' ? (
                        <div className="alert success" role="status">Match request submitted. Private details remain hidden.</div>
                      ) : match.match_status === 'approved' ? (
                        <StatusBadge status="approved" />
                      ) : canRequestLostFoundMatch(selectedReport.type, match.report_type) ? (
                        <button className="button secondary" disabled={loading} type="button" onClick={() => requestMatch(match.id)}>
                          This may be my item
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <div className="lf-no-matches">
            <h3>{matchResults?.items?.length ? 'Results are experimental' : 'No similar item found yet.'}</h3>
            <p>Only opposite report types within 24 hours are compared. Reports remain active for future eligible reports.</p>
          </div>
        </section>
      )}

      <footer className="lf-footer">
        Signed in as {profile?.name || profile?.role || 'student'} · Reports are stored by the Smart Campus backend
      </footer>
    </div>
  )
}
