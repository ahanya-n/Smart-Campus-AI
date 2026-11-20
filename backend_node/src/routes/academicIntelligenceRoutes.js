const express = require('express');

function createAcademicIntelligenceRouter({
  authenticate,
  fetchImpl = globalThis.fetch,
  baseUrl = 'http://127.0.0.1:8000',
}) {
  const router = express.Router();

  router.use(authenticate, async (request, response) => {
    const path = request.originalUrl.replace(/^\/api\/academic-intelligence/, '/academic-intelligence');
    let upstream;
    try {
      upstream = await fetchImpl(new URL(path, baseUrl), {
        method: request.method,
        headers: {
          authorization: request.get('authorization'),
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    } catch {
      return response.status(503).json({
        detail: 'Academic intelligence service is unavailable.',
      });
    }

    if (upstream.status === 204) return response.status(204).end();
    const contentType = upstream.headers.get('content-type');
    if (contentType) response.set('Content-Type', contentType);
    return response.status(upstream.status).send(await upstream.text());
  });

  return router;
}

module.exports = { createAcademicIntelligenceRouter };
