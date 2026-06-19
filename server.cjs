#!/usr/bin/env node
/**
 * WM Sports Mock Server — Microcks-Powered
 *
 * A dashboard UI that proxies all mock requests to a Microcks instance.
 * Microcks handles the actual mocking (200+ operations across GraphQL, REST, Kafka, RabbitMQ).
 * This server provides:
 *   - Pretty dashboard at /
 *   - GraphQL proxy: /graphql/:service → Microcks /graphql/:service/1.0
 *   - REST proxy:    /rest/:service/*  → Microcks /rest/:service/1.0/*
 *   - Health check:  /health
 *   - Fallback:      @graphql-tools/mock when Microcks is unavailable
 *
 * FUTURE ENHANCEMENT:
 *   This server's mock generation logic (@faker-js/faker, @graphql-tools/mock, LLM integration)
 *   can be extracted as an npm package to support inline mocking in resolvers, where developers
 *   can call generateMockData() directly without endpoint changes. See ENHANCEMENT.md.
 */

require('dotenv').config();

const app = require('./src/app.cjs');
const { PORT, MICROCKS_URL, MICROCKS_AUTH_ENABLED, MICROCKS_SERVICE_PREFIX, STATE_FILE_PATH, S3_STATE_BUCKET, AI_API_KEY, AI_MODEL, AI_PROVIDER, AUTH_ENABLED, MOCK_API_KEY, AUTH_ALLOWED_GROUPS } = require('./src/config.cjs');
const { fetchMicrocksServices } = require('./src/lib/microcks-service.cjs');
const { seedRegistryFromMicrocks, initState } = require('./src/state.cjs');
const { syncSchemasFromMicrocks } = require('./src/routes/schema-api.cjs');
const { isAuthEnabled, authHeaders } = require('./src/lib/microcks-auth.cjs');
const { filterToNamespace, isEnabled: nsEnabled } = require('./src/lib/microcks-namespace.cjs');

app.listen(PORT, async () => {
  console.log(`\n  WM Sports Mock Server (Microcks-Powered)`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Microcks:   ${MICROCKS_URL}`);
  console.log(`  Auth:       ${isAuthEnabled() ? '✓ Keycloak client-credentials' : '✗ disabled (no auth env vars)'}`);
  console.log(`  Namespace:  ${nsEnabled() ? `"${MICROCKS_SERVICE_PREFIX}*" (prefix enforced)` : 'disabled (no prefix)'}`);
  const persistLabel = S3_STATE_BUCKET
    ? `✓ S3 (s3://${S3_STATE_BUCKET})${STATE_FILE_PATH ? ' + file (' + STATE_FILE_PATH + ')' : ''}`
    : STATE_FILE_PATH ? STATE_FILE_PATH : '✗ in-memory only (set S3_STATE_BUCKET or STATE_FILE_PATH)';
  console.log(`  Persist:    ${persistLabel}`);

  await initState();

  console.log(`  GraphQL:    POST /graphql/:service`);
  console.log(`  REST:       /rest/:service/:version/...`);
  console.log(`  Health:     GET /health`);
  console.log(`  Stat REST:  For sports-stats-api use STAT_REST_API_URL=http://localhost:${PORT}`);
  console.log(`              (Apollo strips /rest/... from base when paths start with /api; do not point at Microcks :8585 for Stat REST.)`);
  console.log(`  AI Setup:   POST /ai/setup (schema + prompt → auto-deploy)`);
  console.log(`  AI Scenario: POST /ai/scenario (apply failure scenarios to Microcks)`);
  console.log(`  AI:         ${AI_API_KEY ? AI_PROVIDER + ' / ' + AI_MODEL : '⚠ Not set (export GROQ_API_KEY) — using fallback mode'}`);
  console.log(`  Scoping:    Pass X-User header to isolate overrides + scenarios per person`);
  if (AUTH_ENABLED) {
    const groups = AUTH_ALLOWED_GROUPS.length ? AUTH_ALLOWED_GROUPS.join(', ') : 'any user assigned to the SAML app in Okta';
    console.log(`  Dashboard auth: ✓ Okta SAML (allowed: ${groups})`);
    console.log(`  Service auth:   ${MOCK_API_KEY ? '✓ X-API-Key accepted' : '⚠ MOCK_API_KEY not set — service callers will be blocked'}`);
  } else {
    console.log(`  Dashboard auth: ✗ disabled (set AUTH_ENABLED=true to require Okta SAML login)`);
  }
  console.log('');

  if (isAuthEnabled()) {
    try {
      const h = await authHeaders();
      console.log(`  Auth: ${h.Authorization ? '✓ Token fetched successfully' : '⚠ Token fetch returned empty'}`);
    } catch (err) {
      console.log(`  Auth: ✗ Token fetch failed — ${err.message}`);
    }
  }

  const services = await fetchMicrocksServices();
  if (services.length > 0) {
    seedRegistryFromMicrocks(services.map(s => s.name));
    const graphql = services.filter(s => s.type === 'GRAPHQL' || s.type === 'GRAPH');
    const rest = services.filter(s => s.type === 'REST');
    const event = services.filter(s => s.type === 'EVENT' || s.type === 'ASYNC_API');
    const totalOps = services.reduce((sum, s) => sum + (s.operations?.length || 0), 0);
    console.log(`  Microcks: ${services.length} services (${graphql.length} GraphQL, ${rest.length} REST, ${event.length} Event)`);
    if (nsEnabled()) {
      const nsServices = filterToNamespace(services);
      console.log(`  Namespace: ${nsServices.length} services match "${MICROCKS_SERVICE_PREFIX}*" (${services.length - nsServices.length} from other teams)`);
    }
    console.log(`  Total: ${totalOps} operations`);

    const syncResult = await syncSchemasFromMicrocks();
    if (syncResult.synced.length > 0) {
      console.log(`  Schema sync: ${syncResult.synced.length} schema(s) synced from Microcks`);
    }
    if (syncResult.errors.length > 0) {
      console.log(`  Schema sync: ${syncResult.errors.length} error(s)`);
    }
    console.log('');
  } else {
    console.log(`  ⚠ Microcks not reachable at ${MICROCKS_URL}`);
    console.log(`  Start Microcks: docker compose up -d\n`);
  }
});
