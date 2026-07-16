'use strict';

// In-memory chaos fault injection for mock playback (REST / GraphQL / gRPC).
// A fault is attached to a service and adds artificial latency (+ optional
// jitter) and/or a probabilistic error response BEFORE the mock is served.
//
// This is orthogonal to the response-shape scenarios in ai-scenario.cjs
// (wrong-types, missing-fields, etc.): those mutate the payload, these
// degrade the transport (slow / flaky endpoints).
//
// Ephemeral by design — faults reset on restart and are not persisted.

const { getUserScope, getWorkspaceId } = require('../state.cjs');

/** @type {Record<string, {service:string, scope:string, latencyMs:number, jitterMs:number, errorRate:number, errorStatus:number, enabled:boolean, updatedAt:number}>} */
const faults = {};

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function clampFloat(v, min, max, dflt) {
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function keyFor(scope, service) {
  return `${scope}:${service}`;
}

// Scopes to consult when serving a request, most-specific first.
function scopesForRequest(req) {
  const user = getUserScope(req);
  const wsId = getWorkspaceId(req);
  return [wsId ? `ws:${wsId}:${user}` : null, user, 'global'].filter(Boolean);
}

// The single scope a mutation writes to.
function writeScope(req, global) {
  if (global) return 'global';
  const user = getUserScope(req);
  const wsId = getWorkspaceId(req);
  return wsId ? `ws:${wsId}:${user}` : user;
}

function setFault(scope, service, cfg = {}) {
  const fault = {
    service,
    scope,
    latencyMs: clampInt(cfg.latencyMs, 0, 60000, 0),
    jitterMs: clampInt(cfg.jitterMs, 0, 60000, 0),
    errorRate: clampFloat(cfg.errorRate, 0, 1, 0),
    errorStatus: clampInt(cfg.errorStatus, 400, 599, 503),
    enabled: cfg.enabled !== false,
    updatedAt: Date.now(),
  };
  faults[keyFor(scope, service)] = fault;
  return fault;
}

function clearFault(scope, service) {
  const k = keyFor(scope, service);
  if (faults[k]) {
    delete faults[k];
    return true;
  }
  return false;
}

function clearScope(scope) {
  let cleared = 0;
  for (const k of Object.keys(faults)) {
    if (faults[k].scope === scope) {
      delete faults[k];
      cleared += 1;
    }
  }
  return cleared;
}

function listFaults(scopes) {
  const set = new Set(scopes);
  return Object.values(faults).filter((f) => set.has(f.scope));
}

function lookup(scopes, service) {
  for (const scope of scopes) {
    const f = faults[keyFor(scope, service)];
    if (f && f.enabled) return f;
  }
  return null;
}

function parseService(pathname) {
  let p = pathname || '';
  const ws = p.match(/^\/ws\/[^/]+(\/.*)$/);
  if (ws) p = ws[1];

  let m;
  if ((m = p.match(/^\/graphql(?:\/([^/?]+))?/))) return { protocol: 'GRAPHQL', service: m[1] || 'unified' };
  if ((m = p.match(/^\/rest\/([^/?]+)/))) return { protocol: 'REST', service: m[1] };
  if ((m = p.match(/^\/grpc\/([^/?]+)/))) return { protocol: 'GRPC', service: m[1] };
  return null;
}

function computeDelay(fault) {
  let d = fault.latencyMs;
  if (fault.jitterMs > 0) d += Math.round((Math.random() * 2 - 1) * fault.jitterMs);
  return Math.max(0, d);
}

// Express middleware. Only affects mock playback paths; everything else
// passes straight through untouched.
function middleware(req, res, next) {
  const parsed = parseService(req.path || req.url || '');
  if (!parsed) return next();

  const fault = lookup(scopesForRequest(req), parsed.service);
  if (!fault) return next();

  const shouldFail = fault.errorRate > 0 && Math.random() < fault.errorRate;
  const delay = computeDelay(fault);

  const proceed = () => {
    if (res.headersSent) return;
    if (shouldFail) {
      res.setHeader('X-Chaos', 'error');
      res.setHeader('X-Chaos-Service', parsed.service);
      return res.status(fault.errorStatus).json({
        error: 'Chaos fault injected',
        chaos: { type: 'error', status: fault.errorStatus, service: parsed.service, protocol: parsed.protocol },
      });
    }
    if (delay > 0) res.setHeader('X-Chaos-Latency', String(delay));
    next();
  };

  if (delay > 0) setTimeout(proceed, delay);
  else proceed();
}

module.exports = {
  middleware,
  setFault,
  clearFault,
  clearScope,
  listFaults,
  lookup,
  scopesForRequest,
  writeScope,
  parseService,
};
