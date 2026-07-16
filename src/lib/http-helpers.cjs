const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { MICROCKS_URL } = require('../config.cjs');
const { authHeaders, invalidateToken, isAuthEnabled } = require('./microcks-auth.cjs');

// True when the given URL points at the configured Microcks server.
// We only inject auth headers on calls that leave the building for Microcks.
function isMicrocksUrl(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const m = new URL(MICROCKS_URL);
    return u.host === m.host;
  } catch (_) {
    return false;
  }
}

// Microcks's mock playback endpoints (/graphql, /rest, /grpc, /websocket) are
// open and don't expect auth. Sending a Bearer token to them can cause Spring
// to 500 if the token doesn't match an expected scope. Only the admin /api/*
// endpoints require auth.
function isMicrocksAdminPath(pathname) {
  return typeof pathname === 'string' && pathname.startsWith('/api/');
}

async function buildHeadersForUrl(targetUrl, extra = {}) {
  if (!isAuthEnabled() || !isMicrocksUrl(targetUrl)) return { ...extra };
  try {
    const u = new URL(targetUrl);
    if (!isMicrocksAdminPath(u.pathname)) return { ...extra };
  } catch (_) {
    return { ...extra };
  }
  const auth = await authHeaders();
  return { ...extra, ...auth };
}

function doGet(url, timeout, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout, headers }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(); reject(new Error('timeout')); });
  });
}

async function httpGet(url) {
  const headers = await buildHeadersForUrl(url);
  let { status, body } = await doGet(url, 5000, headers);
  if (status === 401 && isAuthEnabled() && isMicrocksUrl(url)) {
    invalidateToken();
    const retryHeaders = await buildHeadersForUrl(url);
    ({ status, body } = await doGet(url, 5000, retryHeaders));
  }
  return body;
}

async function httpGetLong(targetUrl, timeout = 30000) {
  const headers = await buildHeadersForUrl(targetUrl);
  let { status, body } = await doGet(targetUrl, timeout, headers);
  if (status === 401 && isAuthEnabled() && isMicrocksUrl(targetUrl)) {
    invalidateToken();
    const retryHeaders = await buildHeadersForUrl(targetUrl);
    ({ status, body } = await doGet(targetUrl, timeout, retryHeaders));
  }
  return body;
}

async function proxyToMicrocks(req, res, targetPath) {
  const url = new URL(targetPath, MICROCKS_URL);
  const mod = url.protocol === 'https:' ? https : http;

  const headers = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    'Accept': req.headers['accept'] || 'application/json',
    host: url.host,
  };

  if (isAuthEnabled() && isMicrocksAdminPath(url.pathname)) {
    const auth = await authHeaders();
    Object.assign(headers, auth);
  }

  const bodyStr = req.body ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : null;
  if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers,
    timeout: 10000,
  };

  const proxyReq = mod.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    const skip = new Set(['transfer-encoding', 'connection']);
    Object.entries(proxyRes.headers).forEach(([k, v]) => {
      if (!skip.has(k.toLowerCase())) res.setHeader(k, v);
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.status(502).json({
      error: 'Microcks proxy error',
      detail: err.message,
      hint: `Is Microcks running at ${MICROCKS_URL}?`,
    });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.status(504).json({ error: 'Microcks request timed out' });
  });

  if (bodyStr) proxyReq.write(bodyStr);
  proxyReq.end();
}

async function proxyToMicrocksAsText(req, res, targetPath) {
  const url = new URL(targetPath, MICROCKS_URL);
  const mod = url.protocol === 'https:' ? https : http;
  const headers = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    'Accept': 'text/plain',
    host: url.host,
  };
  if (isAuthEnabled() && isMicrocksAdminPath(url.pathname)) {
    const auth = await authHeaders();
    Object.assign(headers, auth);
  }
  const options = {
    hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method, headers, timeout: 10000,
  };
  const proxyReq = mod.request(options, (proxyRes) => {
    const encoding = (proxyRes.headers['content-encoding'] || '').toLowerCase();
    let stream = proxyRes;
    if (encoding === 'gzip') stream = proxyRes.pipe(zlib.createGunzip());
    else if (encoding === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
    else if (encoding === 'br') stream = proxyRes.pipe(zlib.createBrotliDecompress());
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      res.status(proxyRes.statusCode);
      res.setHeader('content-type', 'text/plain');
      res.send(body);
    });
    stream.on('error', () => {
      res.status(502).json({ error: 'Decompression error' });
    });
  });
  proxyReq.on('error', (err) => {
    res.status(502).json({ error: 'Microcks proxy error', detail: err.message });
  });
  proxyReq.on('timeout', () => { proxyReq.destroy(); res.status(504).json({ error: 'Timeout' }); });
  proxyReq.end();
}

async function fetchFromMicrocks(targetPath, body) {
  const url = new URL(targetPath, MICROCKS_URL);
  const mod = url.protocol === 'https:' ? https : http;
  const postData = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
  };
  if (isAuthEnabled() && isMicrocksAdminPath(url.pathname)) {
    const auth = await authHeaders();
    Object.assign(headers, auth);
  }
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method: 'POST',
      headers,
      timeout: 10000,
    };
    const r = mod.request(opts, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => resolve({ status: resp.statusCode, body: d, headers: resp.headers }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.write(postData);
    r.end();
  });
}

module.exports = {
  httpGet,
  httpGetLong,
  proxyToMicrocks,
  proxyToMicrocksAsText,
  fetchFromMicrocks,
};
