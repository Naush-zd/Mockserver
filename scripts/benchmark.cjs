#!/usr/bin/env node
'use strict';

// Benchmark harness for the AI Contract Test Generator.
//
// Produces the quantifiable, resume-ready numbers:
//   - services & operations covered
//   - contract tests generated + generation latency
//   - contract pass-rate against the clean virtualized API
//   - injected regressions caught (chaos): resilience tests that pass when an
//     AI failure scenario is injected == breaking changes the suite would catch
//
//   node scripts/benchmark.cjs                 # generate + run contract tests
//   node scripts/benchmark.cjs --resilience    # also run chaos/regression tests
//
// Requires the full stack running (docker compose up -d).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const a = { base: process.env.MOCK_BASE_URL || 'http://localhost:4010', out: '.benchmark-tests', resilience: false, framework: 'node-test' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--resilience') a.resilience = true;
    else if (argv[i] === '--base') a.base = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
  }
  return a;
}

function runNodeTest(files, env) {
  try {
    const out = execFileSync(process.execPath, ['--test', ...files], {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseTap(out);
  } catch (e) {
    // node --test exits non-zero when tests fail; output is still on stdout.
    return parseTap((e.stdout || '') + (e.stderr || ''));
  }
}

function parseTap(out) {
  const num = (re) => { const m = out.match(re); return m ? parseInt(m[1], 10) : 0; };
  return {
    tests: num(/#\s*tests\s+(\d+)/),
    pass: num(/#\s*pass\s+(\d+)/),
    fail: num(/#\s*fail\s+(\d+)/),
    skipped: num(/#\s*skipped\s+(\d+)/),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const base = args.base.replace(/\/$/, '');

  const listRes = await fetch(`${base}/ai/generate-tests/services`);
  if (!listRes.ok) throw new Error(`Cannot reach mock server at ${base} (${listRes.status}). Run: docker compose up -d`);
  const { services, aiAvailable } = await listRes.json();
  if (!services.length) throw new Error('No services loaded in the mock server.');

  fs.rmSync(args.out, { recursive: true, force: true });
  fs.mkdirSync(args.out, { recursive: true });

  const perService = [];
  const testFiles = [];
  let totalOps = 0;
  let totalContract = 0;
  let totalResilience = 0;
  let totalGenMs = 0;
  let totalFields = 0;

  for (const s of services) {
    const t0 = Date.now();
    const res = await fetch(`${base}/ai/generate-tests`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: s.name, framework: args.framework }),
    });
    const genMs = Date.now() - t0;
    if (!res.ok) { perService.push({ service: s.name, error: `${res.status}` }); continue; }
    const { files, stats } = await res.json();

    const filePath = path.join(args.out, `${s.name.replace(/[^a-zA-Z0-9._-]/g, '_')}.${files[0].path.split('.').slice(1).join('.')}`);
    fs.writeFileSync(filePath, files[0].content, 'utf-8');
    testFiles.push(filePath);

    totalOps += stats.operations;
    totalContract += stats.positiveTests;
    totalResilience += stats.resilienceTests;
    totalGenMs += genMs;
    totalFields += stats.fieldsAsserted;
    perService.push({ service: s.name, type: stats.type, ...stats, genMs });
  }

  // Run contract tests against the clean mock.
  const contract = runNodeTest(testFiles, { MOCK_BASE_URL: base });
  // Optionally run resilience/chaos tests (inject → detect → restore).
  const resilience = args.resilience ? runNodeTest(testFiles, { MOCK_BASE_URL: base, RUN_RESILIENCE: '1' }) : null;

  const contractPassRate = contract.tests ? Math.round((contract.pass / contract.tests) * 100) : 0;
  const regressionsCaught = resilience ? resilience.pass - contract.pass : null; // resilience-run passes beyond the contract ones
  const report = {
    generatedAt: new Date().toISOString(),
    base,
    aiAvailable,
    framework: args.framework,
    totals: {
      services: services.length,
      operations: totalOps,
      contractTests: totalContract,
      resilienceTests: totalResilience,
      fieldsAsserted: totalFields,
      avgGenLatencyMs: services.length ? Math.round(totalGenMs / services.length) : 0,
    },
    contractRun: { ...contract, passRate: contractPassRate },
    resilienceRun: resilience,
    regressionsCaught,
    perService,
  };

  fs.writeFileSync('benchmark-report.json', JSON.stringify(report, null, 2));

  // ── Pretty print ──────────────────────────────────────────────
  const line = '─'.repeat(56);
  console.log(`\n  AI Contract Test Generator — Benchmark`);
  console.log(`  ${line}`);
  console.log(`  Target:              ${base}`);
  console.log(`  AI generation:       ${aiAvailable ? 'LLM-enhanced available' : 'deterministic (no API key)'}`);
  console.log(`  Services covered:    ${report.totals.services}`);
  console.log(`  Operations covered:  ${report.totals.operations}`);
  console.log(`  Contract tests:      ${report.totals.contractTests}`);
  console.log(`  Resilience tests:    ${report.totals.resilienceTests}`);
  console.log(`  Fields asserted:     ${report.totals.fieldsAsserted}`);
  console.log(`  Avg gen latency:     ${report.totals.avgGenLatencyMs} ms/service`);
  console.log(`  ${line}`);
  console.log(`  Contract pass:       ${contract.pass}/${contract.tests} (${contractPassRate}%) against the clean mock`);
  if (resilience) {
    console.log(`  Regressions caught:  ${regressionsCaught}/${totalResilience} injected breaking changes detected`);
  } else {
    console.log(`  Regressions:         (run with --resilience to inject & detect breaking changes)`);
  }
  console.log(`  ${line}`);
  console.log(`  Full report → benchmark-report.json\n`);

  process.exit(contract.fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Benchmark failed:', e.message); process.exit(1); });
