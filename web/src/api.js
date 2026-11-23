const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

export async function apiRequest(path, { token, method = 'GET', body, signal } = {}) {
  const headers = new Headers()
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
  if (body !== undefined && !isFormData) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : (isFormData ? body : JSON.stringify(body)),
      signal,
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new Error('The API could not be reached. Check that the Express server is running.')
  }

  if (response.status === 204) return null
  let payload
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) {
    const detail = payload?.detail
    const message = typeof detail === 'string'
      ? detail
      : Array.isArray(detail)
        ? detail.map((item) => typeof item === 'string'
          ? item
          : item?.msg || item?.message || 'Invalid request').join('; ')
        : detail && typeof detail === 'object'
          ? detail.message || detail.error || 'The request could not be completed.'
          : `Request failed (${response.status})`
    const error = new Error(message)
    error.status = response.status
    throw error
  }
  return payload
}

export async function apiDownload(path, { token, signal } = {}) {
  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal,
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new Error('The API could not be reached. Check that the Express server is running.')
  }
  if (!response.ok) {
    let payload
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    const error = new Error(payload?.detail || `Request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  const disposition = response.headers.get('content-disposition') || ''
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1]
  let filename = encodedName || plainName || 'assistant-document'
  try {
    filename = decodeURIComponent(filename)
  } catch {
    filename = 'assistant-document'
  }
  filename = filename.split(/[\\/]/).pop().replace(/[^\w .-]/g, '_') || 'assistant-document'
  return { blob: await response.blob(), filename }
}

export { API_BASE_URL }
