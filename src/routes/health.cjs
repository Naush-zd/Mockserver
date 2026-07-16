const express = require('express');
const router = express.Router();
const { MICROCKS_URL } = require('../config.cjs');
const { fetchMicrocksServices } = require('../lib/microcks-service.cjs');
const { getAIStatus } = require('../lib/ai-client.cjs');
const { getPersistenceStatus, flushNowAwait } = require('../state.cjs');

router.get('/health', async (req, res) => {
  const services = await fetchMicrocksServices();
  const graphql = services.filter(s => s.type === 'GRAPHQL' || s.type === 'GRAPH');
  const rest = services.filter(s => s.type === 'REST');
  const event = services.filter(s => s.type === 'EVENT' || s.type === 'ASYNC_API');
  const totalOps = services.reduce((sum, s) => sum + (s.operations?.length || 0), 0);

  res.json({
    status: 'ok',
    microcks: MICROCKS_URL,
    microcksReachable: services.length > 0,
    services: { total: services.length, graphql: graphql.length, rest: rest.length, event: event.length },
    totalOperations: totalOps,
    uptime: process.uptime(),
  });
});

router.get('/health/ai', (req, res) => {
  const status = getAIStatus();
  res.json({
    ...status,
    fallbackMode: !status.available,
    message: status.available
      ? 'AI is available — scenarios use LLM generation'
      : 'AI unavailable — scenarios use deterministic faker/graphql-tools fallback',
  });
});

// Diagnostic endpoint: shows current persistence config and state.
// Use this to verify S3 env vars are reaching the app and to see
// last save status without needing CloudWatch logs.
router.get('/health/persistence', (req, res) => {
  res.json(getPersistenceStatus());
});

// Force a synchronous flush to S3 + file. Returns the actual error
// from AWS if the write fails, so we can debug permissions issues.
router.post('/health/persistence/flush', async (req, res) => {
  const result = await flushNowAwait();
  res.json(result);
});

module.exports = router;
