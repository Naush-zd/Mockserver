'use strict';

// Read-only metrics API backed by the in-memory instrumentation in
// lib/metrics.cjs. Powers the Analytics, API Routes, and Overview screens.

const express = require('express');
const router = express.Router();
const metrics = require('../lib/metrics.cjs');

router.get('/metrics/summary', (_req, res) => {
  res.json(metrics.summary());
});

router.get('/metrics/routes', (_req, res) => {
  res.json({ routes: metrics.routes() });
});

module.exports = router;
