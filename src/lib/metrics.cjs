'use strict';

// Lightweight in-memory request instrumentation for the mock traffic
// (GraphQL + REST proxies). Powers the Overview, Analytics, and API Routes
// screens. Intentionally ephemeral — metrics reset on restart and are NOT
// persisted (they describe live traffic, not durable config).

const MAX_REQUESTS = 500;
const MAX_ACTIVITY = 100;

/** @type {Array<{ts:number, protocol:string, service:string, method:string, path:string, status:number, latencyMs:number}>} */
const requests = [];
/** @type {Record<string, {protocol:string, service:string, method:string, path:string, count:number, errors:number, totalLatency:number, lastStatus:number, lastSeen:number}>} */
const routeStats = {};
/** @type {Array<{ts:number, type:string, title:string, detail?:string, actor?:string}>} */
const activity = [];

let totalAll = 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeSegment(seg) {
  if (!seg) return seg;
  if (/^\d+$/.test(seg)) return '{id}';
  if (UUID_RE.test(seg)) return '{id}';
  if (seg.length >= 20 && /[0-9]/.test(seg) && /[a-z]/i.test(seg)) return '{id}';
  return seg;
}

function normalizePath(pathname) {
  return (
    '/' +
    pathname
      .split('/')
      .filter(Boolean)
      .map(normalizeSegment)
      .join('/')
  );
}

// Classify a request path into mock traffic. Returns null for non-mock paths
// (health, ai, schema, dashboard, etc.) so metrics stay meaningful.
function classify(pathname) {
  // Strip an optional workspace prefix: /ws/:id/rest/... or /ws/:id/graphql/...
  let p = pathname;
  const ws = p.match(/^\/ws\/[^/]+(\/.*)$/);
  if (ws) p = ws[1];

  const gql = p.match(/^\/graphql(?:\/([^/?]+))?/);
  if (gql) {
    return { protocol: 'GRAPHQL', service: gql[1] || 'unified', routeKey: normalizePath(pathname) };
  }
  const rest = p.match(/^\/rest\/([^/?]+)/);
  if (rest) {
    return { protocol: 'REST', service: rest[1], routeKey: normalizePath(pathname) };
  }
  return null;
}

function recordRequest(req, res, latencyMs) {
  const c = classify(req.path || req.url || '');
  if (!c) return;

  const method = (req.method || 'GET').toUpperCase();
  const status = res.statusCode || 0;
  const ts = Date.now();

  requests.push({ ts, protocol: c.protocol, service: c.service, method, path: c.routeKey, status, latencyMs: Math.round(latencyMs * 100) / 100 });
  if (requests.length > MAX_REQUESTS) requests.shift();

  const key = `${c.protocol} ${method} ${c.routeKey}`;
  const r =
    routeStats[key] ||
    (routeStats[key] = {
      protocol: c.protocol,
      service: c.service,
      method,
      path: c.routeKey,
      count: 0,
      errors: 0,
      totalLatency: 0,
      lastStatus: 0,
      lastSeen: 0,
    });
  r.count += 1;
  if (status >= 400) r.errors += 1;
  r.totalLatency += latencyMs;
  r.lastStatus = status;
  r.lastSeen = ts;

  totalAll += 1;
}

// High-level, human-readable events (test generation, chaos injection, deploys).
function logEvent(evt) {
  activity.push({ ts: Date.now(), type: evt.type || 'event', title: evt.title || '', detail: evt.detail, actor: evt.actor });
  if (activity.length > MAX_ACTIVITY) activity.shift();
}

function middleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    try {
      const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
      recordRequest(req, res, latencyMs);
    } catch {
      /* never let instrumentation break a request */
    }
  });
  next();
}

function summary() {
  const total = requests.length;
  const byProtocol = {};
  let errors = 0;
  let latencySum = 0;
  const byService = {};
  for (const r of requests) {
    byProtocol[r.protocol] = (byProtocol[r.protocol] || 0) + 1;
    byService[r.service] = (byService[r.service] || 0) + 1;
    if (r.status >= 400) errors += 1;
    latencySum += r.latencyMs;
  }
  return {
    totalRequests: totalAll,
    windowRequests: total,
    byProtocol,
    byService,
    errorRate: total ? errors / total : 0,
    avgLatencyMs: total ? Math.round((latencySum / total) * 100) / 100 : 0,
    routes: Object.keys(routeStats).length,
    recentRequests: requests.slice(-20).reverse(),
    series: requests.slice(-60).map((r) => ({ ts: r.ts, latencyMs: r.latencyMs, status: r.status, protocol: r.protocol })),
    activity: activity.slice(-20).reverse(),
  };
}

function routes() {
  return Object.values(routeStats)
    .map((r) => ({
      protocol: r.protocol,
      service: r.service,
      method: r.method,
      path: r.path,
      count: r.count,
      errorRate: r.count ? r.errors / r.count : 0,
      avgLatencyMs: r.count ? Math.round((r.totalLatency / r.count) * 100) / 100 : 0,
      lastStatus: r.lastStatus,
      lastSeen: r.lastSeen,
    }))
    .sort((a, b) => b.count - a.count);
}

module.exports = { middleware, recordRequest, logEvent, summary, routes };
