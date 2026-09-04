const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { MICROCKS_URL, CACHE_TTL } = require('../config.cjs');
const { httpGet, httpGetLong } = require('./http-helpers.cjs');
const { authHeaders, isAuthEnabled, invalidateToken } = require('./microcks-auth.cjs');
const {
  assertInNamespace,
  isInNamespace,
  NamespaceViolationError,
} = require('./microcks-namespace.cjs');

async function microcksAuthHeaders() {
  return isAuthEnabled() ? await authHeaders() : {};
}

let microcksServices = [];
let lastFetch = 0;

async function fetchMicrocksServices() {
  if (Date.now() - lastFetch < CACHE_TTL && microcksServices.length > 0) {
    return microcksServices;
  }
  try {
    const data = await httpGet(`${MICROCKS_URL}/api/services?page=0&size=200`);
    microcksServices = JSON.parse(data);
    lastFetch = Date.now();
    return microcksServices;
  } catch (err) {
    console.log(`  ⚠ Cannot reach Microcks at ${MICROCKS_URL}: ${err.message}`);
    return microcksServices;
  }
}

function invalidateCache() {
  lastFetch = 0;
}

function findServiceEntry(services, serviceName) {
  const norm = serviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return services.find(s => s.name === serviceName)
    || services.find(s => s.name.toLowerCase() === serviceName.toLowerCase())
    || services.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
}

async function getMicrocksServiceId(serviceName) {
  invalidateCache();
  const services = await fetchMicrocksServices();
  const svc = findServiceEntry(services, serviceName);
  return svc ? svc.id : null;
}

// Returns { id, type } so callers can tell REST from GraphQL/Event/gRPC
// services that happen to share a normalized name with an artifact of a
// different kind (e.g. "test-openapi.json" vs "test-schema.graphql").
async function getMicrocksServiceInfo(serviceName) {
  invalidateCache();
  const services = await fetchMicrocksServices();
  const svc = findServiceEntry(services, serviceName);
  return svc ? { id: svc.id, type: svc.type } : null;
}

function curlExec(args, timeoutMs = 20000) {
  const { execSync } = require('child_process');
  return execSync(`curl -s -w "\\n%{http_code}" ${args}`, { timeout: timeoutMs, encoding: 'utf-8' });
}

function parseCurlResult(result) {
  const lines = result.trim().split('\n');
  const statusCode = parseInt(lines[lines.length - 1], 10);
  const body = lines.slice(0, -1).join('\n');
  return { status: statusCode, body };
}

async function deleteServiceFromMicrocks(serviceId) {
  try {
    const url = new URL(`${MICROCKS_URL}/api/services/${serviceId}`);
    const transport = url.protocol === 'https:' ? https : http;
    const headers = await microcksAuthHeaders();
    const status = await new Promise((resolve, reject) => {
      const r = transport.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'DELETE',
        headers,
        timeout: 15000,
      }, (resp) => {
        resp.on('data', () => {});
        resp.on('end', () => resolve(resp.statusCode));
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
      r.end();
    });
    if (status === 401 && isAuthEnabled()) invalidateToken();
    return status >= 200 && status < 300;
  } catch (_) { return false; }
}

async function importArtifactToMicrocks(filePath, isMain = true) {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes = { '.graphql': 'text/plain', '.json': 'application/json', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.proto': 'text/plain' };
  const mime = mimeTypes[ext] || 'application/octet-stream';
  const mainParam = isMain ? 'true' : 'false';

  const fileContent = fs.readFileSync(filePath);
  const boundary = '----FormBoundary' + Date.now().toString(36);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`),
    fileContent,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const url = new URL(`${MICROCKS_URL}/api/artifact/upload?mainArtifact=${mainParam}`);
  const transport = url.protocol === 'https:' ? https : http;
  const auth = await microcksAuthHeaders();
  const opts = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
      ...auth,
    },
    timeout: 60000,
  };

  return new Promise((resolve, reject) => {
    const r = transport.request(opts, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        const code = resp.statusCode;
        if (code === 401 && isAuthEnabled()) invalidateToken();
        if (code === 200 || code === 201) {
          resolve({ success: true, file: fileName, code });
        } else {
          reject(new Error(`Import failed for ${fileName}: HTTP ${code} — ${d.substring(0, 200)}`));
        }
      });
    });
    r.on('error', (err) => reject(new Error(`Import error for ${fileName}: ${err.message}`)));
    r.on('timeout', () => { r.destroy(); reject(new Error(`Import timeout for ${fileName}`)); });
    r.write(body);
    r.end();
  });
}

function clearServiceDispatchers(serviceName) {
  return new Promise(async (resolve) => {
    try {
      assertInNamespace(serviceName, 'clear dispatchers on');
    } catch (err) {
      if (err instanceof NamespaceViolationError) {
        resolve({ cleared: 0, error: err.message, namespaceViolation: true });
        return;
      }
      throw err;
    }
    try {
      const data = await httpGetLong(`${MICROCKS_URL}/api/services?page=0&size=200`);
      const services = JSON.parse(data);
      const norm = serviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const svc = services.find(s => s.name === serviceName)
        || services.find(s => s.name.toLowerCase() === serviceName.toLowerCase())
        || services.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
      if (!svc) { resolve({ cleared: 0 }); return; }
      if (!isInNamespace(svc.name)) {
        resolve({ cleared: 0, error: `matched service "${svc.name}" is outside namespace`, namespaceViolation: true });
        return;
      }

      const auth = await microcksAuthHeaders();
      let cleared = 0;
      for (const op of (svc.operations || [])) {
        if (op.dispatcher === 'QUERY_ARGS' || op.dispatcher === 'JSON_BODY' || op.dispatcher === 'FALLBACK') {
          try {
            await new Promise((res2, rej2) => {
              const opName = encodeURIComponent(op.name);
              const url = new URL(`${MICROCKS_URL}/api/services/${svc.id}/operation?operationName=${opName}`);
              const transport = url.protocol === 'https:' ? https : http;
              const body = JSON.stringify({ dispatcher: null, dispatcherRules: null });
              const opts = {
                hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search, method: 'PUT',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(body),
                  ...auth,
                },
                timeout: 15000,
              };
              const r = transport.request(opts, (resp) => {
                let d = ''; resp.on('data', c => d += c);
                resp.on('end', () => res2(resp.statusCode));
              });
              r.on('error', rej2);
              r.on('timeout', () => { r.destroy(); rej2(new Error('timeout')); });
              r.write(body); r.end();
            });
            cleared++;
          } catch (_) {}
        }
      }
      resolve({ cleared });
    } catch (err) {
      resolve({ cleared: 0, error: err.message });
    }
  });
}

function configureServiceDispatchers(serviceName, dispatcher, rules) {
  return new Promise(async (resolve) => {
    try {
      assertInNamespace(serviceName, 'configure dispatchers on');
    } catch (err) {
      if (err instanceof NamespaceViolationError) {
        resolve({ configured: 0, error: err.message, namespaceViolation: true });
        return;
      }
      throw err;
    }
    try {
      const data = await httpGetLong(`${MICROCKS_URL}/api/services?page=0&size=200`);
      const services = JSON.parse(data);
      const norm = serviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const svc = services.find(s => s.name === serviceName)
        || services.find(s => s.name.toLowerCase() === serviceName.toLowerCase())
        || services.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
      if (!svc) { resolve({ configured: 0 }); return; }
      if (!isInNamespace(svc.name)) {
        resolve({ configured: 0, error: `matched service "${svc.name}" is outside namespace`, namespaceViolation: true });
        return;
      }

      const auth = await microcksAuthHeaders();
      let configured = 0;
      for (const op of (svc.operations || [])) {
        try {
          await new Promise((res2, rej2) => {
            const opName = encodeURIComponent(op.name);
            const url = new URL(`${MICROCKS_URL}/api/services/${svc.id}/operation?operationName=${opName}`);
            const transport = url.protocol === 'https:' ? https : http;
            const body = JSON.stringify({ dispatcher, dispatcherRules: rules });
            const opts = {
              hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
              path: url.pathname + url.search, method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...auth,
              },
              timeout: 15000,
            };
            const r = transport.request(opts, (resp) => {
              let d = ''; resp.on('data', c => d += c);
              resp.on('end', () => res2(resp.statusCode));
            });
            r.on('error', rej2);
            r.on('timeout', () => { r.destroy(); rej2(new Error('timeout')); });
            r.write(body); r.end();
          });
          configured++;
        } catch (_) {}
      }
      resolve({ configured });
    } catch (err) {
      resolve({ configured: 0, error: err.message });
    }
  });
}

async function getMicrocksExamples(serviceName, operationName) {
  try {
    const data = await httpGetLong(`${MICROCKS_URL}/api/services?page=0&size=200`);
    const services = JSON.parse(data);
    const norm = serviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const svc = services.find(s => s.name === serviceName)
      || services.find(s => s.name.toLowerCase() === serviceName.toLowerCase())
      || services.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
    if (!svc) return { examples: [], service: null };

    const svcDetail = await httpGetLong(`${MICROCKS_URL}/api/services/${svc.id}?messages=true`);
    const detail = JSON.parse(svcDetail);
    const messagesMap = detail.messagesMap || {};

    const examples = [];
    for (const [opKey, pairs] of Object.entries(messagesMap)) {
      const opMatch = opKey === operationName
        || opKey.replace(/^QUERY\s+/, '') === operationName
        || opKey.replace(/^MUTATION\s+/, '') === operationName;
      if (!opMatch) continue;

      for (const pair of pairs) {
        const req = pair.request || {};
        const resp = pair.response || {};
        let variables = null;
        try {
          const reqContent = req.content ? JSON.parse(req.content) : null;
          if (reqContent && reqContent.variables && Object.keys(reqContent.variables).length > 0) {
            variables = reqContent.variables;
          }
        } catch (_) {}

        let body = null;
        try { body = JSON.parse(resp.content || '{}'); } catch (_) {}

        examples.push({
          name: resp.name || 'default',
          variables,
          body,
          status: resp.status || '200',
          dispatchCriteria: resp.dispatchCriteria || null,
        });
      }
    }

    return { examples, service: { id: svc.id, name: svc.name, version: svc.version } };
  } catch (err) {
    return { examples: [], error: err.message };
  }
}

async function deleteExistingService(serviceName) {
  try {
    const serviceId = await getMicrocksServiceId(serviceName);
    if (!serviceId) return { deleted: false, reason: 'Service not found' };
    const result = await deleteServiceFromMicrocks(serviceId);
    return { deleted: result, serviceId };
  } catch (err) {
    return { deleted: false, error: err.message };
  }
}

// Pick the best GraphQL operation argument to dispatch on.
// Preference: first Int (cleanest 1/2/3 mapping) > first String > first primitive.
// Returns the chosen arg or null if none suitable.
function pickGraphQLDispatchArg(args) {
  if (!Array.isArray(args) || args.length === 0) return null;
  const PRIMITIVE = new Set(['Int', 'Float', 'String', 'ID', 'Boolean', 'Tenant', 'DateTime']);
  const usable = args.filter(a => a && a.type && !a.type.isList && PRIMITIVE.has(a.type.name));
  if (usable.length === 0) return null;
  return usable.find(a => a.type.name === 'Int' || a.type.name === 'Float')
    || usable.find(a => a.type.name === 'String' || a.type.name === 'ID')
    || usable[0];
}

// Mirror of postman-builder.buildVariantVariables for a single field, used to
// predict the example values produced for each variant index N (0-based).
function predictVariantValue(arg, index) {
  const defaults = {
    'String': 'example', 'Int': 1, 'Float': 1.0, 'Boolean': true, 'ID': 'id-001',
    'Tenant': 'example-tenant', 'DateTime': '2026-03-01T00:00:00Z',
  };
  const base = defaults[arg.type.name];
  if (typeof base === 'string') return index === 0 ? base : `${base}-${index + 1}`;
  if (typeof base === 'number') return base + index;
  if (typeof base === 'boolean') return index % 2 === 0 ? base : !base;
  return base;
}

// Build a Groovy SCRIPT-dispatcher payload that maps inbound GraphQL variable
// values to example names. Returns null if no usable dispatch arg.
function buildGraphQLDispatchScript(op, sampleCount) {
  const arg = pickGraphQLDispatchArg(op.args);
  if (!arg) return null;
  const n = Math.max(1, sampleCount || 1);
  const lines = [
    "def json = new groovy.json.JsonSlurper().parseText(mockRequest.requestContent)",
    `def v = json?.variables?.${arg.name}`,
  ];
  for (let i = 0; i < n; i++) {
    const expected = predictVariantValue(arg, i);
    const literal = typeof expected === 'string'
      ? `"${expected.replace(/"/g, '\\"')}"`
      : String(expected);
    lines.push(`if (v == ${literal}) return "example-${i + 1}"`);
  }
  lines.push('return "example-1"');
  return lines.join('\n');
}

async function configureGraphQLOperationDispatchers(serviceName, operations, sampleCount) {
  const results = [];
  for (const op of operations || []) {
    const script = buildGraphQLDispatchScript(op, sampleCount);
    if (!script) {
      results.push({ operation: op.name, configured: false, reason: 'no dispatch arg' });
      continue;
    }
    const r = await configureOperationDispatcher(serviceName, op.name, 'SCRIPT', script);
    results.push({ operation: op.name, ...r });
  }
  return results;
}

async function configureOperationDispatcher(serviceName, operationName, dispatcher, rules) {
  try {
    assertInNamespace(serviceName, 'configure operation on');
  } catch (err) {
    if (err instanceof NamespaceViolationError) {
      return { configured: false, error: err.message, namespaceViolation: true };
    }
    throw err;
  }
  try {
    const data = await httpGetLong(`${MICROCKS_URL}/api/services?page=0&size=200`);
    const services = JSON.parse(data);
    const norm = serviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const svc = services.find(s => s.name === serviceName)
      || services.find(s => s.name.toLowerCase() === serviceName.toLowerCase())
      || services.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
    if (!svc) return { configured: false, reason: 'Service not found' };
    if (!isInNamespace(svc.name)) {
      return {
        configured: false,
        error: `matched service "${svc.name}" is outside namespace`,
        namespaceViolation: true,
      };
    }

    const opName = encodeURIComponent(operationName);
    const url = new URL(`${MICROCKS_URL}/api/services/${svc.id}/operation?operationName=${opName}`);
    const transport = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ dispatcher, dispatcherRules: rules });
    const auth = await microcksAuthHeaders();

    return new Promise((resolve) => {
      const opts = {
        hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search, method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...auth,
        },
        timeout: 15000,
      };
      const r = transport.request(opts, (resp) => {
        let d = ''; resp.on('data', c => d += c);
        resp.on('end', () => {
          if (resp.statusCode === 401 && isAuthEnabled()) invalidateToken();
          resolve({ configured: resp.statusCode < 300, status: resp.statusCode });
        });
      });
      r.on('error', (err) => resolve({ configured: false, error: err.message }));
      r.on('timeout', () => { r.destroy(); resolve({ configured: false, error: 'timeout' }); });
      r.write(body); r.end();
    });
  } catch (err) {
    return { configured: false, error: err.message };
  }
}

module.exports = {
  fetchMicrocksServices,
  invalidateCache,
  getMicrocksServiceId,
  getMicrocksServiceInfo,
  curlExec,
  parseCurlResult,
  deleteServiceFromMicrocks,
  deleteExistingService,
  importArtifactToMicrocks,
  clearServiceDispatchers,
  configureServiceDispatchers,
  getMicrocksExamples,
  configureOperationDispatcher,
  configureGraphQLOperationDispatchers,
  buildGraphQLDispatchScript,
};
