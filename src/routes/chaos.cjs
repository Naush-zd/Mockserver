'use strict';

const express = require('express');
const chaos = require('../lib/chaos.cjs');
const metrics = require('../lib/metrics.cjs');
const { getUserScope } = require('../state.cjs');

const router = express.Router();

// Active transport faults visible to the caller's scope (workspace/user/global).
router.get('/chaos/faults', (req, res) => {
  const scopes = chaos.scopesForRequest(req);
  res.json({ faults: chaos.listFaults(scopes) });
});

// Create / update a transport fault (latency + jitter + error rate) on a service.
router.post('/chaos/faults', (req, res) => {
  const { service, latencyMs, jitterMs, errorRate, errorStatus, enabled, global } = req.body || {};
  if (!service) return res.status(400).json({ error: 'Provide "service"' });

  const scope = chaos.writeScope(req, !!global);
  const fault = chaos.setFault(scope, service, { latencyMs, jitterMs, errorRate, errorStatus, enabled });

  const bits = [];
  if (fault.latencyMs) bits.push(`${fault.latencyMs}ms latency${fault.jitterMs ? ` \u00b1${fault.jitterMs}ms` : ''}`);
  if (fault.errorRate) bits.push(`${Math.round(fault.errorRate * 100)}% ${fault.errorStatus}s`);
  metrics.logEvent({
    type: 'chaos',
    title: `Fault on ${service}: ${bits.join(', ') || 'disabled'}`,
    detail: 'transport',
    actor: getUserScope(req),
  });

  res.json({ fault });
});

// Clear a single service fault, or all faults in the caller's scope.
router.delete('/chaos/faults', (req, res) => {
  const { service, global } = req.body || {};
  const scope = chaos.writeScope(req, !!global);

  if (service) {
    const cleared = chaos.clearFault(scope, service);
    if (cleared) {
      metrics.logEvent({ type: 'restore', title: `Cleared fault on ${service}`, detail: 'transport', actor: getUserScope(req) });
    }
    return res.json({ cleared });
  }

  const count = chaos.clearScope(scope);
  if (count) {
    metrics.logEvent({ type: 'restore', title: `Cleared ${count} transport fault(s)`, detail: 'transport', actor: getUserScope(req) });
  }
  res.json({ cleared: count });
});

module.exports = router;
