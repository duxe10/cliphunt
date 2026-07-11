// Exposes non-secret runtime config to the browser so WORKER_URL isn't hardcoded in app.js
// (there's no build step to inject it). WORKER_URL is a public endpoint, not a secret — the
// worker is guarded by HMAC signatures, not by URL obscurity.
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workerUrl: process.env.WORKER_URL || null }),
  };
};
