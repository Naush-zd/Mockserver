const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { scenarioStore, getUserScope, getWorkspaceId, dispatchExample } = require('../state.cjs');
const { proxyToMicrocks } = require('../lib/http-helpers.cjs');

// Mock playback endpoints sit behind authentication but get high-volume
// traffic from tests, CI runners, and dev workflows, so the limit is generous.
const playbackRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});

function checkRestScenario(req, service) {
  const userScope = getUserScope(req);
  const wsId = getWorkspaceId(req);
  const method = req.method;
  const subPath = '/' + (req.params[0] || '');
  const opKey = `${method} ${subPath}`;

  const scopes = [
    wsId ? `ws:${wsId}:${userScope}` : null,
    userScope,
    'global',
  ].filter(Boolean);

  for (const scope of scopes) {
    const exactKey = `${scope}:${service}:${opKey}`;
    if (scenarioStore[exactKey]) return scenarioStore[exactKey];
  }

  for (const scope of scopes) {
    const prefix = `${scope}:${service}:${method} `;
    for (const key of Object.keys(scenarioStore)) {
      if (!key.startsWith(prefix)) continue;
      const storedPath = key.slice(prefix.length);
      if (storedPath.includes('{') && pathMatchesTemplate(subPath, storedPath)) {
        return scenarioStore[key];
      }
    }
  }

  return null;
}

function pathMatchesTemplate(actualPath, templatePath) {
  const actualParts = actualPath.split('/');
  const templateParts = templatePath.split('/');
  if (actualParts.length !== templateParts.length) return false;
  return templateParts.every((tp, i) => tp.startsWith('{') || tp === actualParts[i]);
}

// NOTE: Template fallback is intentionally kept for ai-setup scenarios
// (which store keys with {param} templates). User-applied scenarios from
// the dashboard now store against the resolved path so each unique
// parameter value gets its own response.

function tryExampleDispatch(req, res, service) {
  const subPath = '/' + (req.params[0] || '');
  const dispatched = dispatchExample(service, req.method, subPath, req.query || {});
  if (!dispatched) return false;
  const { exampleName, response } = dispatched;
  const status = response.status || 200;
  if (response.headers) {
    for (const [k, v] of Object.entries(response.headers)) res.setHeader(k, v);
  }
  res.setHeader('X-Source', 'example-dispatcher');
  res.setHeader('X-Example-Name', exampleName);
  res.status(status);
  if (response.body === undefined || response.body === null) {
    res.end();
  } else {
    res.json(response.body);
  }
  return true;
}

function handleRestVersioned(req, res) {
  const service = req.params.service;
  const entry = checkRestScenario(req, service);
  if (entry && entry.data) {
    res.setHeader('X-Source', entry.source === 'ai-setup' ? 'ai-setup-workspace' : 'ai-scenario');
    return res.json(entry.data);
  }
  if (tryExampleDispatch(req, res, service)) return;
  const version = req.params.version;
  const subPath = req.params[0] || '';
  const search = req._parsedUrl.search || '';
  const restPath = `/rest/${service}/${version}/${subPath}${search}`;
  proxyToMicrocks(req, res, restPath);
}

function handleRestNoVersion(req, res) {
  const service = req.params.service;
  const entry = checkRestScenario(req, service);
  if (entry && entry.data) {
    res.setHeader('X-Source', entry.source === 'ai-setup' ? 'ai-setup-workspace' : 'ai-scenario');
    return res.json(entry.data);
  }
  if (tryExampleDispatch(req, res, service)) return;
  const subPath = req.params[0] || '';
  const search = req._parsedUrl.search || '';
  const restPath = `/rest/${service}/1.0/${subPath}${search}`;
  proxyToMicrocks(req, res, restPath);
}

router.all('/rest/:service/:version/*', playbackRateLimiter, handleRestVersioned);
router.all('/rest/:service/*', playbackRateLimiter, handleRestNoVersion);

router.all('/ws/:workspaceId/rest/:service/:version/*', playbackRateLimiter, (req, res) => {
  req.headers['x-workspace'] = req.params.workspaceId;
  handleRestVersioned(req, res);
});
router.all('/ws/:workspaceId/rest/:service/*', playbackRateLimiter, (req, res) => {
  req.headers['x-workspace'] = req.params.workspaceId;
  handleRestNoVersion(req, res);
});

module.exports = router;
