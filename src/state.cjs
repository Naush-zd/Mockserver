const fs = require('fs');
const path = require('path');
const { STATE_FILE_PATH } = require('./config.cjs');
const s3 = require('./lib/s3-persistence.cjs');

const responseOverrides = {};
const aiRemovedFields = {};
const scenarioStore = {};

const workspaces = {};
const variableMockStore = {};
const proxyUrls = {};
let upstreamUrl = null;

// Maps service name -> workspace ID (null = global/pre-existing, visible only in Default)
const serviceRegistry = {};
let registrySeeded = false;

// Microcks-style example dispatcher registry (URI_PARTS / URI_PARAMS).
// Shape:
//   exampleRegistry[serviceName] = {
//     [`${METHOD} ${pathTemplate}`]: {
//       dispatcher: 'URI_PARTS' | 'URI_PARAMS' | 'FALLBACK',
//       dispatcherRules: ['id', 'status', ...],   // param names to match on
//       fallback: '<exampleName>' | null,
//       examples: {
//         <exampleName>: {
//           request: { pathParams: { id: '1' }, queryParams: { ... } },
//           response: { status: 200, body: <any>, headers?: {...} }
//         }
//       }
//     }
//   }
const exampleRegistry = {};

// ── Persistence ────────────────────────────────────────────────
// Debounced save. Collects rapid mutations into a single I/O.
let saveTimer = null;
const SAVE_DELAY_MS = 2000;

function filePersistEnabled() {
  return Boolean(STATE_FILE_PATH);
}

function persistEnabled() {
  return filePersistEnabled() || s3.isEnabled();
}

function getSnapshot() {
  return {
    workspaces,
    scenarioStore,
    responseOverrides,
    variableMockStore,
    serviceRegistry,
    exampleRegistry,
    upstreamUrl,
    savedAt: new Date().toISOString(),
  };
}

function saveToFile(snapshot) {
  if (!filePersistEnabled()) return;
  try {
    const dir = path.dirname(STATE_FILE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = STATE_FILE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
    fs.renameSync(tmp, STATE_FILE_PATH);
  } catch (err) {
    console.log(`  ⚠ File state save failed: ${err.message}`);
  }
}

let lastSaveAt = null;
let lastSaveError = null;

function scheduleSave() {
  if (!persistEnabled()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushNow();
  }, SAVE_DELAY_MS);
}

function flushNow() {
  const snapshot = getSnapshot();
  saveToFile(snapshot);
  if (s3.isEnabled()) {
    s3.saveToS3(snapshot)
      .then(() => { lastSaveAt = new Date().toISOString(); lastSaveError = null; })
      .catch((err) => { lastSaveError = err.message; });
  } else {
    lastSaveAt = new Date().toISOString();
  }
}

async function flushNowAwait() {
  const snapshot = getSnapshot();
  const result = { file: 'skipped', s3: 'skipped', snapshot: { workspaces: Object.keys(snapshot.workspaces || {}).length, services: Object.keys(snapshot.serviceRegistry || {}).length, scenarios: Object.keys(snapshot.scenarioStore || {}).length } };
  if (filePersistEnabled()) {
    try { saveToFile(snapshot); result.file = 'ok'; }
    catch (err) { result.file = `error: ${err.message}`; }
  }
  if (s3.isEnabled()) {
    try {
      await s3.saveToS3(snapshot);
      result.s3 = 'ok';
      lastSaveAt = new Date().toISOString();
      lastSaveError = null;
    } catch (err) {
      result.s3 = `error: ${err.message}`;
      lastSaveError = err.message;
    }
  }
  return result;
}

function getPersistenceStatus() {
  return {
    s3Enabled: s3.isEnabled(),
    fileEnabled: filePersistEnabled(),
    s3Bucket: process.env.S3_STATE_BUCKET || null,
    s3Key: process.env.S3_STATE_KEY || 'unified-mockserver/state.json',
    s3Region: process.env.S3_STATE_REGION || process.env.AWS_REGION || 'us-east-1',
    stateFilePath: STATE_FILE_PATH || null,
    currentState: {
      workspaces: Object.keys(workspaces).length,
      services: Object.keys(serviceRegistry).length,
      scenarios: Object.keys(scenarioStore).length,
    },
    lastSaveAt,
    lastSaveError,
  };
}

// Flush pending state on shutdown so ECS SIGTERM doesn't lose data.
function handleShutdown(signal) {
  console.log(`  [State] ${signal} received, flushing state...`);
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const snapshot = getSnapshot();
  saveToFile(snapshot);
  if (s3.isEnabled()) {
    s3.saveToS3(snapshot)
      .then(() => console.log('  [State] Shutdown flush to S3 complete'))
      .catch((err) => console.log(`  [State] Shutdown flush to S3 failed: ${err.message}`))
      .finally(() => process.exit(0));
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

function applySnapshot(data) {
  if (!data) return false;
  if (data.workspaces) Object.assign(workspaces, data.workspaces);
  if (data.scenarioStore) Object.assign(scenarioStore, data.scenarioStore);
  if (data.responseOverrides) Object.assign(responseOverrides, data.responseOverrides);
  if (data.variableMockStore) Object.assign(variableMockStore, data.variableMockStore);
  if (data.serviceRegistry) Object.assign(serviceRegistry, data.serviceRegistry);
  if (data.exampleRegistry) Object.assign(exampleRegistry, data.exampleRegistry);
  if (data.upstreamUrl) upstreamUrl = data.upstreamUrl;
  return true;
}

function loadFromDisk() {
  if (!filePersistEnabled()) return false;
  try {
    if (!fs.existsSync(STATE_FILE_PATH)) return false;
    const raw = fs.readFileSync(STATE_FILE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    applySnapshot(data);
    const wsCount = Object.keys(workspaces).length;
    const scCount = Object.keys(scenarioStore).length;
    console.log(`  State: restored from file ${STATE_FILE_PATH} (${wsCount} workspaces, ${scCount} scenarios, saved ${data.savedAt || 'unknown'})`);
    return true;
  } catch (err) {
    console.log(`  ⚠ File state load failed: ${err.message}`);
    return false;
  }
}

// Async init — call from server.cjs before listening. Tries S3 first,
// falls back to file. Sync file load also runs at module-init time so
// the server works even if initState() is never awaited.
async function initState() {
  console.log(`  [State] S3 enabled: ${s3.isEnabled()}, file enabled: ${filePersistEnabled()}`);
  if (s3.isEnabled()) {
    try {
      const data = await s3.loadFromS3();
      if (data) {
        applySnapshot(data);
        const wsCount = Object.keys(workspaces).length;
        const scCount = Object.keys(scenarioStore).length;
        console.log(`  State: restored from S3 s3://${process.env.S3_STATE_BUCKET}/${process.env.S3_STATE_KEY || 'unified-mockserver/state.json'} (${wsCount} workspaces, ${scCount} scenarios, saved ${data.savedAt || 'unknown'})`);
        return;
      }
      console.log(`  State: no existing state in S3, starting fresh`);
    } catch (err) {
      console.log(`  ⚠ S3 state init failed: ${err.message}, falling back to file`);
    }
  }
  // File fallback (also runs synchronously at require-time below)
}

// Synchronous file load at module init — ensures state is available
// immediately for local dev / docker-compose where S3 isn't configured.
loadFromDisk();

// ── Core functions ─────────────────────────────────────────────

function getUserScope(req) {
  return req.headers['x-user'] || 'global';
}

function getWorkspaceId(req) {
  return req.headers['x-workspace'] || null;
}

function getEffectiveScope(req) {
  const wsId = getWorkspaceId(req);
  const user = getUserScope(req);
  return wsId ? `ws:${wsId}:${user}` : user;
}

function registerService(serviceName, workspaceId) {
  serviceRegistry[serviceName] = workspaceId || null;
  scheduleSave();
}

function seedRegistryFromMicrocks(serviceNames) {
  if (registrySeeded) return;
  for (const name of serviceNames) {
    if (!(name in serviceRegistry)) {
      serviceRegistry[name] = null;
    }
  }
  registrySeeded = true;
}

function isServiceVisibleInWorkspace(serviceName, workspaceId) {
  const owner = serviceRegistry[serviceName];
  if (owner === undefined) return true;
  if (!workspaceId) return owner === null;
  return owner === workspaceId;
}

function getServicesForWorkspace(workspaceId) {
  const visible = new Set();
  for (const [name, owner] of Object.entries(serviceRegistry)) {
    if (!workspaceId && owner === null) visible.add(name);
    else if (workspaceId && owner === workspaceId) visible.add(name);
  }
  return visible;
}

function unregisterWorkspaceServices(workspaceId, moveToGlobal) {
  for (const [name, owner] of Object.entries(serviceRegistry)) {
    if (owner === workspaceId) {
      if (moveToGlobal) {
        serviceRegistry[name] = null;
      } else {
        delete serviceRegistry[name];
      }
    }
  }
  scheduleSave();
}

// Notify persistence layer that state changed. Call after modifying
// any of the exported objects (scenarioStore, responseOverrides, etc.)
// from routes. Workspace/service registration calls this automatically.
function markDirty() {
  scheduleSave();
}

// ── Example dispatcher (Microcks-style) ────────────────────────

function registerOperationExamples(serviceName, opKey, entry) {
  if (!serviceName || !opKey || !entry) return;
  if (!exampleRegistry[serviceName]) exampleRegistry[serviceName] = {};
  exampleRegistry[serviceName][opKey] = entry;
  scheduleSave();
}

function clearServiceExamples(serviceName) {
  if (exampleRegistry[serviceName]) {
    delete exampleRegistry[serviceName];
    scheduleSave();
  }
}

// Match the actual request path against a path template like `/books/{id}`.
// Returns extracted path params on match, or null on miss.
function matchPathTemplate(actualPath, templatePath) {
  const a = actualPath.split('/').filter(Boolean);
  const t = templatePath.split('/').filter(Boolean);
  if (a.length !== t.length) return null;
  const params = {};
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith('{') && t[i].endsWith('}')) {
      params[t[i].slice(1, -1)] = decodeURIComponent(a[i]);
    } else if (t[i] !== a[i]) {
      return null;
    }
  }
  return params;
}

// Pick the example whose request shape matches the incoming request.
// Mirrors Microcks URI_PARTS / URI_PARAMS dispatchers.
function dispatchExample(serviceName, method, actualPath, queryParams) {
  const svcOps = exampleRegistry[serviceName];
  if (!svcOps) return null;

  for (const [opKey, op] of Object.entries(svcOps)) {
    const [opMethod, opPath] = opKey.split(' ');
    if (opMethod !== method) continue;
    const pathParams = matchPathTemplate(actualPath, opPath);
    if (!pathParams) continue;

    const dispatcher = op.dispatcher || 'FALLBACK';
    const rules = op.dispatcherRules || [];
    const examples = op.examples || {};

    if (dispatcher === 'URI_PARTS' || dispatcher === 'URI_PARAMS') {
      for (const [name, ex] of Object.entries(examples)) {
        const exReq = ex.request || {};
        const exPath = exReq.pathParams || {};
        const exQuery = exReq.queryParams || {};
        let allMatch = true;
        for (const rule of rules) {
          const actual = pathParams[rule] !== undefined
            ? pathParams[rule]
            : (queryParams ? queryParams[rule] : undefined);
          const expected = exPath[rule] !== undefined ? exPath[rule] : exQuery[rule];
          if (expected === undefined) continue;
          if (String(actual) !== String(expected)) { allMatch = false; break; }
        }
        if (allMatch && rules.length > 0) {
          return { exampleName: name, response: ex.response, opKey };
        }
      }
    }

    // Fallback to a named default example, or first available.
    if (op.fallback && examples[op.fallback]) {
      return { exampleName: op.fallback, response: examples[op.fallback].response, opKey };
    }
    const first = Object.entries(examples)[0];
    if (first) {
      return { exampleName: first[0], response: first[1].response, opKey };
    }
  }

  return null;
}

module.exports = {
  responseOverrides,
  aiRemovedFields,
  scenarioStore,
  workspaces,
  variableMockStore,
  proxyUrls,
  serviceRegistry,
  exampleRegistry,
  get upstreamUrl() { return upstreamUrl; },
  set upstreamUrl(v) { upstreamUrl = v; scheduleSave(); },
  getUserScope,
  getWorkspaceId,
  getEffectiveScope,
  registerService,
  seedRegistryFromMicrocks,
  isServiceVisibleInWorkspace,
  getServicesForWorkspace,
  unregisterWorkspaceServices,
  registerOperationExamples,
  clearServiceExamples,
  dispatchExample,
  markDirty,
  initState,
  flushNowAwait,
  getPersistenceStatus,
};
