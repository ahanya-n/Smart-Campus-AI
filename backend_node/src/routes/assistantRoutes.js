const express = require('express');
const { Transform } = require('node:stream');

const MAX_ASSISTANT_MULTIPART_BYTES = 5 * 1024 * 1024 + 64 * 1024;

function createAssistantRouter({
  authenticate,
  fetchImpl = globalThis.fetch,
  baseUrl = 'http://127.0.0.1:8000',
}) {
  const router = express.Router();

  router.use(authenticate, async (request, response) => {
    const path = request.originalUrl.replace(/^\/api\/assistant/, '/assistant');
    const requestContentType = request.get('content-type') || '';
    const isMultipart = /^multipart\/form-data\b/i.test(requestContentType);
    const declaredLength = Number(request.get('content-length'));
    if (isMultipart && Number.isFinite(declaredLength) && declaredLength > MAX_ASSISTANT_MULTIPART_BYTES) {
      await new Promise((resolve, reject) => {
        if (request.readableEnded) {
          resolve();
          return;
        }
        request.once('end', resolve);
        request.once('error', reject);
        request.resume();
      });
      return response.status(413).json({ detail: 'Uploaded file must be 5 MB or smaller.' });
    }
    const hasJsonBody = request.body !== undefined;
    let multipartBytes = 0;
    let multipartTooLarge = false;
    const multipartBody = isMultipart
      ? request.pipe(new Transform({
        transform(chunk, _encoding, callback) {
          multipartBytes += chunk.length;
          if (multipartBytes > MAX_ASSISTANT_MULTIPART_BYTES) {
            multipartTooLarge = true;
            callback();
            return;
          }
          callback(null, chunk);
        },
      }))
      : undefined;
    const headers = {
      authorization: request.get('authorization'),
      ...(isMultipart
        ? { 'content-type': requestContentType }
        : hasJsonBody
          ? { 'content-type': 'application/json' }
          : {}),
    };
    let upstream;
    try {
      upstream = await fetchImpl(new URL(path, baseUrl), {
        method: request.method,
        headers,
        ...(isMultipart
          ? { body: multipartBody, duplex: 'half' }
          : hasJsonBody
            ? { body: JSON.stringify(request.body) }
            : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (multipartTooLarge) {
        return response.status(413).json({ detail: 'Uploaded file must be 5 MB or smaller.' });
      }
      return response.status(503).json({
        detail: 'Assistant service is unavailable.',
      });
    }

    if (multipartTooLarge) {
      return response.status(413).json({ detail: 'Uploaded file must be 5 MB or smaller.' });
    }
    if (upstream.status === 204) return response.status(204).end();
    const contentType = upstream.headers.get('content-type');
    if (contentType) response.set('Content-Type', contentType);
    const contentDisposition = upstream.headers.get('content-disposition');
    if (contentDisposition) response.set('Content-Disposition', contentDisposition);
    const body = typeof upstream.arrayBuffer === 'function'
      ? Buffer.from(await upstream.arrayBuffer())
      : await upstream.text();
    return response.status(upstream.status).send(body);
  });

  return router;
}

module.exports = { createAssistantRouter };
