const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { MICROCKS_URL, SCHEMA_CACHE_TTL } = require('../config.cjs');
const { responseOverrides, aiRemovedFields, scenarioStore, getUserScope, getWorkspaceId, proxyUrls, workspaces, markDirty } = require('../state.cjs');
const { httpGet, fetchFromMicrocks, proxyToMicrocks } = require('../lib/http-helpers.cjs');
const http = require('http');
const https = require('https');
const { extractSelectionSet, filterResponseBySelection, extractOperationName } = require('../lib/graphql-utils.cjs');
const { fullTypeMap } = require('../lib/schema-loader.cjs');
const { fetchMicrocksServices, getMicrocksExamples } = require('../lib/microcks-service.cjs');
const { resolveTypeName, validateFieldsAgainstSchema } = require('../lib/validation.cjs');

function deepMerge(base, overlay) {
  if (overlay === null || overlay === undefined) return overlay;
  if (typeof overlay !== 'object' || Array.isArray(overlay)) return overlay;
  if (typeof base !== 'object' || Array.isArray(base) || base === null) return overlay;

  const result = { ...base };
  for (const key of Object.keys(overlay)) {
    if (overlay[key] === null) {
      result[key] = null;
    } else if (typeof overlay[key] === 'object' && !Array.isArray(overlay[key]) &&
               typeof result[key] === 'object' && !Array.isArray(result[key]) && result[key] !== null) {
      result[key] = deepMerge(result[key], overlay[key]);
    } else {
      result[key] = overlay[key];
    }
  }
  return result;
}

const serverSchemaCache = {};

async function getServiceSchema(service) {
  const cached = serverSchemaCache[service];
  if (cached && Date.now() - cached.ts < SCHEMA_CACHE_TTL) return cached.schema;

  try {
    let serviceVersion = '1.0';
    let microcksName = service;
    try {
      const data = await httpGet(`${MICROCKS_URL}/api/services?page=0&size=200`);
      const services = JSON.parse(data);
      const norm = service.toLowerCase().replace(/[^a-z0-9]/g, '');
      const svc = services.find(s => s.name === service)
        || services.find(s => s.name.toLowerCase() === service.toLowerCase())
        || services.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
      if (svc) {
        serviceVersion = svc.version;
        microcksName = svc.name;
      }
    } catch (e) {}
    
    const introspectionQuery = '{ __schema { types { name kind fields { name type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } } queryType { name } mutationType { name } } }';
    const resp = await fetchFromMicrocks(`/graphql/${microcksName}/${serviceVersion}`, { query: introspectionQuery });
    if (resp.status === 200) {
      const parsed = JSON.parse(resp.body);
      if (parsed.data && parsed.data.__schema) {
        const schema = parsed.data.__schema;
        serverSchemaCache[service] = { schema, ts: Date.now() };
        return schema;
      }
    }
  } catch (_) {}
  return null;
}

function findBestMatchingExample(examples, variables) {
  if (!variables || Object.keys(variables).length === 0) return null;
  
  const varStr = JSON.stringify(variables, Object.keys(variables).sort());
  let bestMatch = null;
  let bestScore = -1;

  for (const ex of examples) {
    if (!ex.variables) continue;
    const exVarStr = JSON.stringify(ex.variables, Object.keys(ex.variables).sort());
    
    if (exVarStr === varStr) return ex;

    let score = 0;
    for (const [key, val] of Object.entries(variables)) {
      if (ex.variables[key] !== undefined) {
        if (JSON.stringify(ex.variables[key]) === JSON.stringify(val)) {
          score += 2;
        } else {
          score += 1;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = ex;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

function forwardToProxy(proxyUrl, body, originalReq) {
  return new Promise((resolve, reject) => {
    const url = new URL(proxyUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const fwdHeaders = {};
    if (originalReq && originalReq.headers) {
      const skip = new Set(['host', 'connection', 'content-length', 'x-user', 'x-workspace', 'x-probe', 'x-microcks-example']);
      for (const [k, v] of Object.entries(originalReq.headers)) {
        if (!skip.has(k.toLowerCase())) fwdHeaders[k] = v;
      }
    }
    fwdHeaders['content-type'] = 'application/json';
    fwdHeaders['content-length'] = Buffer.byteLength(payload);
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: (originalReq && originalReq.method) || 'POST',
      headers: fwdHeaders,
      timeout: 15000,
    };
    const r = mod.request(opts, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => resolve({ status: resp.statusCode, body: data, headers: resp.headers }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('proxy timeout')); });
    r.write(payload);
    r.end();
  });
}

function isWorkspaceIsolated(req) {
  const wsId = getWorkspaceId(req);
  if (!wsId) return false;
  const ws = workspaces[wsId];
  return ws && ws.isolated;
}

async function handleGraphqlService(req, res) {
  const service = req.params.service;
  
  let serviceVersion = '1.0';
  let microcksName = service;
  try {
    const data = await httpGet(`${MICROCKS_URL}/api/services?page=0&size=200`);
    const services = JSON.parse(data);
    const norm = service.toLowerCase().replace(/[^a-z0-9]/g, '');
    const svc = services.find(s => s.name === service)
      || services.find(s => s.name.toLowerCase() === service.toLowerCase())
      || services.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
    if (svc) {
      serviceVersion = svc.version;
      microcksName = svc.name;
    }
  } catch (e) {}
  
  const microcksPath = `/graphql/${microcksName}/${serviceVersion}`;
  const queryStr = req.body?.query || '';

  if (queryStr.includes('__schema') || queryStr.includes('__type')) {
    return proxyToMicrocks(req, res, microcksPath);
  }

  const isProbe = req.headers['x-probe'] === 'true';
  const isolated = isWorkspaceIsolated(req);
  const opName = extractOperationName(queryStr);
  if (opName) {
    const userScope = getUserScope(req);
    const wsId = getWorkspaceId(req);
    const wsPrefix = wsId ? `ws:${wsId}:${userScope}:` : null;
    const wsKey = `${userScope}:${service}:${opName}`;
    const globalKey = `global:${service}:${opName}`;
    const wsOverrideKey = wsPrefix ? `${wsPrefix}${service}:${opName}` : null;

    let override, activeKey;
    if (isolated) {
      override = wsOverrideKey ? responseOverrides[wsOverrideKey] : null;
      activeKey = wsOverrideKey;
    } else {
      override = (wsOverrideKey && responseOverrides[wsOverrideKey]) || responseOverrides[wsKey] || responseOverrides[globalKey];
      activeKey = (wsOverrideKey && responseOverrides[wsOverrideKey]) ? wsOverrideKey : (responseOverrides[wsKey] ? wsKey : globalKey);
    }
    if (override && override.remaining > 0) {
      if (!isProbe) {
        override.remaining--;
        if (override.remaining <= 0) delete responseOverrides[activeKey];
      }
      res.setHeader('X-Source', 'ai-override');
      res.setHeader('X-Override-Remaining', override.remaining);
      return res.json(override.data);
    }

    const wsScenarioKey = wsPrefix ? `${wsPrefix}${service}:${opName}` : null;
    const scenarioWsKey = `${userScope}:${service}:${opName}`;
    const scenarioGlobalKey = `global:${service}:${opName}`;
    let scenarioEntry;
    if (isolated) {
      scenarioEntry = wsScenarioKey ? scenarioStore[wsScenarioKey] : null;
    } else {
      scenarioEntry = (wsScenarioKey && scenarioStore[wsScenarioKey]) || scenarioStore[scenarioWsKey] || scenarioStore[scenarioGlobalKey];
    }
    if (scenarioEntry && scenarioEntry.data) {
      if (scenarioEntry.source === 'ai-setup') {
        res.setHeader('X-Source', 'ai-setup-workspace');
        return res.json(scenarioEntry.data);
      }
      try {
        const baseResp = await fetchFromMicrocks(microcksPath, req.body);
        if (baseResp.status === 200) {
          const baseParsed = JSON.parse(baseResp.body);
          const merged = deepMerge(baseParsed, scenarioEntry.data);
          res.setHeader('X-Source', 'ai-scenario-overlay');
          return res.json(merged);
        }
      } catch (_) {}
      res.setHeader('X-Source', 'ai-scenario');
      return res.json(scenarioEntry.data);
    }

    if (isolated && !scenarioEntry) {
      const proxyUrl = proxyUrls[service.toLowerCase()];
      if (proxyUrl) {
        try {
          const proxyResp = await forwardToProxy(proxyUrl, req.body, req);
          res.setHeader('X-Mock-Source', 'proxy');
          for (const [hk, hv] of Object.entries(proxyResp.headers)) {
            if (!['transfer-encoding', 'connection'].includes(hk.toLowerCase())) res.setHeader(hk, hv);
          }
          res.status(proxyResp.status);
          return res.send(proxyResp.body);
        } catch (err) {
          return res.status(502).json({ error: 'Proxy forward failed', detail: err.message });
        }
      }
      return res.status(404).json({ error: 'No mock data configured for this operation in the current workspace', operation: opName, service });
    }
  }

  const schema = await getServiceSchema(service);
  const hasFullSchema = Object.keys(fullTypeMap).length > 0;
  if (schema && hasFullSchema) {
    const validationErrors = validateFieldsAgainstSchema(schema, queryStr, fullTypeMap);
    if (validationErrors.length > 0) {
      return res.json({ errors: validationErrors });
    }
  }

  const selectionMap = extractSelectionSet(queryStr);
  const requestedExample = req.headers['x-microcks-example'];
  const variables = req.body?.variables || null;

  try {
    if (opName && (requestedExample || (variables && Object.keys(variables).length > 0))) {
      try {
        const exResult = await getMicrocksExamples(service, opName);
        if (exResult.examples && exResult.examples.length > 1) {
          let matched = null;

          if (requestedExample) {
            matched = exResult.examples.find(e => e.name === requestedExample);
          }

          if (!matched && variables) {
            matched = findBestMatchingExample(exResult.examples, variables);
          }

          if (matched && matched.body) {
            res.setHeader('X-Source', 'microcks-example');
            res.setHeader('X-Example-Name', matched.name);
            let result = JSON.parse(JSON.stringify(matched.body));
            if (result && result.data && selectionMap) {
              const userScope = getUserScope(req);
              const removedKey = `${userScope}:${service}:${opName}`;
              const globalRemovedKey = `global:${service}:${opName}`;
              const removedFields = aiRemovedFields[removedKey] || aiRemovedFields[globalRemovedKey] || [];
              result.data = filterResponseBySelection(result.data, selectionMap, removedFields);
            }
            return res.json(result);
          }
        }
      } catch (_) {}
    }

    let resp = await fetchFromMicrocks(microcksPath, req.body);

    if (resp.status === 500 && selectionMap) {
      const opName = extractOperationName(queryStr);
      if (opName) {
        const isM = queryStr.trimStart().startsWith('mutation');
        const bareQuery = (isM ? 'mutation' : '') + `{ ${opName} }`;
        resp = await fetchFromMicrocks(microcksPath, { query: bareQuery });
      }
    }

    if (resp.status !== 200 || !selectionMap) {
      res.status(resp.status);
      res.setHeader('Content-Type', resp.headers['content-type'] || 'application/json');
      return res.send(resp.body);
    }

    const parsed = JSON.parse(resp.body);
    if (parsed.data) {
      const userScope = getUserScope(req);
      const removedKey = opName ? `${userScope}:${service}:${opName}` : null;
      const globalRemovedKey = opName ? `global:${service}:${opName}` : null;
      const removedFields = removedKey ? (aiRemovedFields[removedKey] || aiRemovedFields[globalRemovedKey] || []) : [];
      parsed.data = filterResponseBySelection(parsed.data, selectionMap, removedFields);
    }
    res.json(parsed);
  } catch (err) {
    const proxyUrl = proxyUrls[service.toLowerCase()];
    if (proxyUrl) {
      try {
        const proxyResp = await forwardToProxy(proxyUrl, req.body, req);
        res.setHeader('X-Mock-Source', 'proxy');
        for (const [hk, hv] of Object.entries(proxyResp.headers)) {
          if (!['transfer-encoding', 'connection'].includes(hk.toLowerCase())) res.setHeader(hk, hv);
        }
        res.status(proxyResp.status);
        return res.send(proxyResp.body);
      } catch (_) {}
    }
    res.status(502).json({ error: 'Microcks proxy error', detail: err.message });
  }
}

// Mock playback endpoints sit behind authentication but get high-volume
// traffic from tests, CI runners, and dev workflows, so the limit is generous.
const playbackRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/graphql/:service', playbackRateLimiter, handleGraphqlService);

router.post('/ws/:workspaceId/graphql/:service', playbackRateLimiter, (req, res) => {
  req.headers['x-workspace'] = req.params.workspaceId;
  handleGraphqlService(req, res);
});

router.post('/graphql', playbackRateLimiter, async (req, res) => {
  const services = await fetchMicrocksServices();
  const graphqlSvcs = services.filter(s =>
    s.type === 'GRAPHQL' || s.type === 'GRAPH'
  );

  if (graphqlSvcs.length === 0) {
    return res.status(503).json({
      error: 'No GraphQL services found in Microcks',
      hint: `Check ${MICROCKS_URL}`,
    });
  }

  const { query, variables, operationName } = req.body;
  const selectionMap = (query && !query.includes('__schema')) ? extractSelectionSet(query) : null;

  for (const svc of graphqlSvcs) {
    try {
      const resp = await fetchFromMicrocks(`/graphql/${svc.name}/${svc.version}`, { query, variables, operationName });
      if (resp.status !== 200) continue;
      const parsed = JSON.parse(resp.body);
      if (parsed.errors && parsed.errors.length > 0) continue;
      if (parsed.data && selectionMap) {
        parsed.data = filterResponseBySelection(parsed.data, selectionMap);
      }
      return res.json(parsed);
    } catch (_) {}
  }

  res.status(400).json({
    error: 'Query did not match any Microcks GraphQL service',
    availableServices: graphqlSvcs.map(s => s.name),
  });
});

module.exports = router;
