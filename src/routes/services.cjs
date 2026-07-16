'use strict';

// Lightweight services listing for the Next.js frontend. Replaces the JSON
// branch of the old server-rendered dashboard (now removed). Returns the
// Microcks services visible in the caller's workspace, decorated with a
// human-friendly displayName.

const express = require('express');
const router = express.Router();
const { MICROCKS_URL } = require('../config.cjs');
const { fetchMicrocksServices } = require('../lib/microcks-service.cjs');
const { isServiceVisibleInWorkspace, serviceRegistry, getWorkspaceId } = require('../state.cjs');
const { getDisplayName } = require('../lib/microcks-namespace.cjs');

async function listServices(req, res) {
  const activeWs = getWorkspaceId(req);
  const all = await fetchMicrocksServices();
  const services = all
    .filter((s) => isServiceVisibleInWorkspace(s.name, activeWs))
    .map((s) => ({
      ...s,
      displayName: getDisplayName(s.name, serviceRegistry[s.name] || null),
    }));
  res.json({ services, microcks: MICROCKS_URL });
}

// `/` keeps the frontend's existing api.servicesDetail() call working;
// `/services` is the explicit alias.
router.get('/', listServices);
router.get('/services', listServices);

module.exports = router;
