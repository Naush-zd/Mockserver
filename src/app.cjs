const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const state = require('./state.cjs');
const auth = require('./middleware/auth.cjs');
const metrics = require('./lib/metrics.cjs');
const chaos = require('./lib/chaos.cjs');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.text({ type: 'text/*', limit: '5mb' }));

// Order matters: session must be set up before any route can read req.session;
// /health stays public so ALB target checks work; /auth/* stays public since
// it IS the login flow; everything below requireAuth is gated.
auth.initSession(app);
app.use(require('./routes/health.cjs'));
app.use(require('./routes/auth.cjs'));
app.use(auth.requireAuth);

// Instrument mock traffic (GraphQL/REST) for the Analytics / API Routes /
// Overview screens. Records on response finish; never blocks a request.
app.use(metrics.middleware);
app.use(require('./routes/metrics.cjs'));

// Chaos transport faults (latency/jitter/error-rate) run just before the mock
// playback routes so they can delay or short-circuit REST/GraphQL/gRPC responses.
app.use(chaos.middleware);
app.use(require('./routes/chaos.cjs'));

app.use(require('./routes/services.cjs'));
app.use(require('./routes/workspace.cjs'));
app.use(require('./routes/schema-api.cjs'));
app.use(require('./routes/graphql.cjs'));
app.use(require('./routes/rest.cjs'));
app.use(require('./routes/ai-generate.cjs'));
app.use(require('./routes/ai-scenario.cjs'));
app.use(require('./routes/ai-setup.cjs'));
app.use(require('./routes/async-api.cjs'));
// The Next.js frontend (see /web) is the only UI. The old server-rendered
// dashboard has been removed.

app.all('*', (req, res) => {
  const upstream = state.upstreamUrl;
  if (!upstream) {
    return res.status(404).json({ error: 'No route matched and no upstream URL configured' });
  }

  try {
    const url = new URL(upstream);
    const mod = url.protocol === 'https:' ? https : http;
    const fwdHeaders = {};
    const skip = new Set(['host', 'connection', 'content-length', 'x-user', 'x-workspace']);
    for (const [k, v] of Object.entries(req.headers)) {
      if (!skip.has(k.toLowerCase())) fwdHeaders[k] = v;
    }
    const targetPath = url.pathname.replace(/\/$/, '') + req.originalUrl;
    let payload = '';
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      payload = JSON.stringify(req.body);
      fwdHeaders['content-type'] = 'application/json';
      fwdHeaders['content-length'] = Buffer.byteLength(payload);
    } else if (typeof req.body === 'string' && req.body.length > 0) {
      payload = req.body;
      fwdHeaders['content-length'] = Buffer.byteLength(payload);
    }

    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: targetPath,
      method: req.method,
      headers: fwdHeaders,
      timeout: 30000,
    };

    const proxyReq = mod.request(opts, (proxyRes) => {
      res.setHeader('X-Mock-Source', 'upstream-proxy');
      for (const [hk, hv] of Object.entries(proxyRes.headers)) {
        if (!['transfer-encoding', 'connection'].includes(hk.toLowerCase())) {
          res.setHeader(hk, hv);
        }
      }
      res.status(proxyRes.statusCode);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      res.status(502).json({ error: 'Upstream proxy error', detail: err.message });
    });
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.status(504).json({ error: 'Upstream proxy timeout' });
    });

    if (payload) proxyReq.write(payload);
    proxyReq.end();
  } catch (err) {
    res.status(502).json({ error: 'Upstream proxy error', detail: err.message });
  }
});

module.exports = app;
