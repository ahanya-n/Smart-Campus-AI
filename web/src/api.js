const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

export async function apiRequest(path, { token, method = 'GET', body, signal } = {}) {
  const headers = new Headers()
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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
    const error = new Error(payload?.detail || `Request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return payload
}

export { API_BASE_URL }
