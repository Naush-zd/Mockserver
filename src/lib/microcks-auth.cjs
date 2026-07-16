const https = require('https');
const http = require('http');
const {
  MICROCKS_AUTH_ENABLED,
  MICROCKS_AUTH_TOKEN_URL,
  MICROCKS_CLIENT_ID,
  MICROCKS_CLIENT_SECRET,
} = require('../config.cjs');

// Refresh the token this many milliseconds before it actually expires,
// so in-flight requests never see a 401 from clock skew.
const REFRESH_SKEW_MS = 30_000;

let cachedToken = null;
let cachedExpiresAt = 0;
let inflight = null;

function postForm(targetUrl, formBody) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(targetUrl); } catch (e) { return reject(e); }
    const mod = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
        'Accept': 'application/json',
      },
      timeout: 10_000,
    };
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('token request timeout')); });
    req.write(formBody);
    req.end();
  });
}

async function fetchNewToken() {
  const form = [
    'grant_type=client_credentials',
    `client_id=${encodeURIComponent(MICROCKS_CLIENT_ID)}`,
    `client_secret=${encodeURIComponent(MICROCKS_CLIENT_SECRET)}`,
  ].join('&');

  const { status, body } = await postForm(MICROCKS_AUTH_TOKEN_URL, form);
  if (status < 200 || status >= 300) {
    throw new Error(`Microcks auth failed: HTTP ${status} — ${body.slice(0, 200)}`);
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch (e) {
    throw new Error(`Microcks auth returned non-JSON: ${body.slice(0, 200)}`);
  }
  if (!parsed.access_token) {
    throw new Error(`Microcks auth response missing access_token: ${body.slice(0, 200)}`);
  }

  const expiresInMs = (Number(parsed.expires_in) || 300) * 1000;
  cachedToken = parsed.access_token;
  cachedExpiresAt = Date.now() + expiresInMs - REFRESH_SKEW_MS;
  return cachedToken;
}

async function getAccessToken() {
  if (!MICROCKS_AUTH_ENABLED) return null;

  if (cachedToken && Date.now() < cachedExpiresAt) {
    return cachedToken;
  }

  // De-dupe concurrent refreshes into a single in-flight request.
  if (inflight) return inflight;

  inflight = fetchNewToken()
    .finally(() => { inflight = null; });

  return inflight;
}

// Force-invalidate the cached token. Call this when a Microcks response
// comes back 401 so the next request fetches a fresh token.
function invalidateToken() {
  cachedToken = null;
  cachedExpiresAt = 0;
}

// Convenience: returns an object ready to spread into an http headers map.
// Returns {} when auth is disabled — safe to always use.
async function authHeaders() {
  if (!MICROCKS_AUTH_ENABLED) return {};
  try {
    const token = await getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch (err) {
    console.log(`  ⚠ Microcks auth error: ${err.message}`);
    return {};
  }
}

function isAuthEnabled() {
  return MICROCKS_AUTH_ENABLED;
}

module.exports = {
  getAccessToken,
  authHeaders,
  invalidateToken,
  isAuthEnabled,
};
