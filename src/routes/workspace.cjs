'use strict';

const express = require('express');
const { workspaces, scenarioStore, responseOverrides, variableMockStore, getUserScope, getWorkspaceId, getServicesForWorkspace, isServiceVisibleInWorkspace, unregisterWorkspaceServices, serviceRegistry, markDirty } = require('../state.cjs');
const { fetchMicrocksServices, deleteExistingService, invalidateCache } = require('../lib/microcks-service.cjs');
const { getDisplayName } = require('../lib/microcks-namespace.cjs');

const router = express.Router();

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function generateId(name) {
  const slug = slugify(name);
  const base = slug ? `ws-${slug}` : 'ws-unnamed';
  if (!workspaces[base]) return base;
  // Append short numeric suffix on collision
  for (let i = 2; i <= 999; i++) {
    const candidate = `${base}-${i}`;
    if (!workspaces[candidate]) return candidate;
  }
  // Fallback: timestamp-based (extremely unlikely)
  return `${base}-${Date.now().toString(36)}`;
}

router.post('/workspaces', (req, res) => {
  const { name, description, isolated } = req.body;
  if (!name) return res.status(400).json({ error: 'Provide "name"' });

  const user = getUserScope(req);
  const id = generateId(name);
  workspaces[id] = {
    id,
    name,
    description: description || '',
    owner: user,
    createdAt: new Date().toISOString(),
    isolated: isolated !== false,
    scenarios: {},
    overrides: {},
    variableMocks: {},
  };
  markDirty();
  res.json(workspaces[id]);
});

router.get('/workspaces', (req, res) => {
  const user = getUserScope(req);
  const list = Object.values(workspaces).filter(w => w.owner === user || w.owner === 'global');
  res.json({ workspaces: list });
});

router.get('/workspaces/:id', (req, res) => {
  const ws = workspaces[req.params.id];
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  res.json(ws);
});

router.put('/workspaces/:id', (req, res) => {
  const ws = workspaces[req.params.id];
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  if (req.body.name) ws.name = req.body.name;
  if (req.body.description !== undefined) ws.description = req.body.description;
  if (req.body.isolated !== undefined) ws.isolated = !!req.body.isolated;
  markDirty();
  res.json(ws);
});

router.delete('/workspaces/:id', async (req, res) => {
  const ws = workspaces[req.params.id];
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const shouldDeleteServices = req.query.deleteServices === 'true';
  const wsId = req.params.id;

  const prefix = `ws:${wsId}:`;
  for (const k of Object.keys(scenarioStore)) {
    if (k.startsWith(prefix)) delete scenarioStore[k];
  }
  for (const k of Object.keys(responseOverrides)) {
    if (k.startsWith(prefix)) delete responseOverrides[k];
  }
  for (const k of Object.keys(variableMockStore)) {
    if (k.startsWith(prefix)) delete variableMockStore[k];
  }

  const deletedFromMicrocks = [];
  if (shouldDeleteServices) {
    const ownedServices = getServicesForWorkspace(wsId);
    for (const svcName of ownedServices) {
      try {
        await deleteExistingService(svcName);
        deletedFromMicrocks.push(svcName);
      } catch (_) {}
    }
    unregisterWorkspaceServices(wsId, false);
    invalidateCache();
  } else {
    unregisterWorkspaceServices(wsId, true);
  }

  delete workspaces[wsId];
  markDirty();
  res.json({
    deleted: true,
    id: wsId,
    servicesAction: shouldDeleteServices ? 'deleted' : 'moved_to_default',
    deletedServices: deletedFromMicrocks,
  });
});

router.post('/workspaces/:id/activate', (req, res) => {
  const ws = workspaces[req.params.id];
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const user = getUserScope(req);
  const wsPrefix = `ws:${req.params.id}:${user}:`;

  for (const [k, v] of Object.entries(ws.scenarios)) {
    scenarioStore[wsPrefix + k] = v;
  }
  for (const [k, v] of Object.entries(ws.overrides)) {
    responseOverrides[wsPrefix + k] = v;
  }
  for (const [k, v] of Object.entries(ws.variableMocks)) {
    variableMockStore[wsPrefix + k] = v;
  }

  markDirty();
  res.json({ activated: true, id: req.params.id, scenariosApplied: Object.keys(ws.scenarios).length });
});

router.post('/workspaces/:id/deactivate', (req, res) => {
  const ws = workspaces[req.params.id];
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const user = getUserScope(req);
  const wsPrefix = `ws:${req.params.id}:${user}:`;

  let cleared = 0;
  for (const k of Object.keys(scenarioStore)) {
    if (k.startsWith(wsPrefix)) { delete scenarioStore[k]; cleared++; }
  }
  for (const k of Object.keys(responseOverrides)) {
    if (k.startsWith(wsPrefix)) { delete responseOverrides[k]; cleared++; }
  }
  for (const k of Object.keys(variableMockStore)) {
    if (k.startsWith(wsPrefix)) { delete variableMockStore[k]; cleared++; }
  }

  markDirty();
  res.json({ deactivated: true, id: req.params.id, cleared });
});

router.post('/workspaces/:id/snapshot', (req, res) => {
  const ws = workspaces[req.params.id];
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const user = getUserScope(req);
  const userPrefix = user + ':';

  ws.scenarios = {};
  ws.overrides = {};
  ws.variableMocks = {};

  for (const [k, v] of Object.entries(scenarioStore)) {
    if (k.startsWith(userPrefix)) {
      ws.scenarios[k.slice(userPrefix.length)] = v;
    }
  }
  for (const [k, v] of Object.entries(responseOverrides)) {
    if (k.startsWith(userPrefix) && v.remaining > 0) {
      ws.overrides[k.slice(userPrefix.length)] = v;
    }
  }
  for (const [k, v] of Object.entries(variableMockStore)) {
    if (k.startsWith(userPrefix)) {
      ws.variableMocks[k.slice(userPrefix.length)] = v;
    }
  }

  ws.snapshotAt = new Date().toISOString();
  res.json({
    snapshotted: true,
    id: req.params.id,
    scenarios: Object.keys(ws.scenarios).length,
    overrides: Object.keys(ws.overrides).length,
    variableMocks: Object.keys(ws.variableMocks).length,
  });
});

router.get('/api/workspace-operations', (req, res) => {
  const wsId = req.query.workspace;
  if (!wsId) return res.status(400).json({ error: 'Provide "workspace" query param' });

  const ws = workspaces[wsId];
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const services = {};
  const prefix = `ws:${wsId}:`;

  function addOp(service, operation) {
    if (!services[service]) services[service] = new Set();
    services[service].add(operation);
  }

  function parseKey(key) {
    const parts = key.split(':');
    if (parts.length >= 2) {
      const svc = parts[parts.length - 2];
      const op = parts[parts.length - 1];
      if (svc && op) addOp(svc, op);
    }
  }

  for (const k of Object.keys(scenarioStore)) {
    if (k.startsWith(prefix)) parseKey(k.slice(prefix.length));
  }
  for (const k of Object.keys(responseOverrides)) {
    if (k.startsWith(prefix)) parseKey(k.slice(prefix.length));
  }

  for (const k of Object.keys(ws.scenarios || {})) { parseKey(k); }
  for (const k of Object.keys(ws.overrides || {})) { parseKey(k); }

  const result = {};
  for (const [svc, ops] of Object.entries(services)) {
    result[svc] = [...ops];
  }
  res.json({ workspace: wsId, services: result });
});

router.get('/api/services-for-workspace', async (req, res) => {
  const wsId = req.query.workspace || null;
  const allServices = await fetchMicrocksServices();
  const visible = allServices.filter(s => isServiceVisibleInWorkspace(s.name, wsId));
  // Decorate each service with a `displayName` derived by stripping the
  // global namespace prefix and the workspace id from the canonical name.
  // The UI uses `displayName` for human-facing labels but keeps `name` for
  // backend calls (deletes, regenerates, GraphQL/REST routing).
  const decorated = visible.map(s => ({
    ...s,
    displayName: getDisplayName(s.name, serviceRegistry[s.name] || null),
  }));
  res.json({
    workspace: wsId,
    services: decorated.map(s => s.name),
    serviceDetails: decorated,
  });
});

router.delete('/api/services/:serviceName', async (req, res) => {
  const serviceName = decodeURIComponent(req.params.serviceName);
  if (!serviceName) return res.status(400).json({ error: 'Provide service name' });

  const result = await deleteExistingService(serviceName);
  if (result.namespaceViolation) {
    return res.status(403).json(result);
  }
  if (!result.deleted) {
    return res.status(404).json(result);
  }
  invalidateCache();
  res.json(result);
});

module.exports = router;
