#!/usr/bin/env node
'use strict';

// CLI: generate consumer contract tests for services in a running mock server.
//
//   node scripts/generate-tests.cjs --all
//   node scripts/generate-tests.cjs --service testql --framework jest
//   node scripts/generate-tests.cjs --all --llm --out generated-tests
//
// Talks to the mock server's /ai/generate-tests API, so it works against any
// deployed instance (local Docker, Render, etc.), not just this checkout.

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { base: process.env.MOCK_BASE_URL || 'http://localhost:4010', framework: 'node-test', out: 'generated-tests', all: false, llm: false, service: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--llm') args.llm = true;
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--service') args.service = argv[++i];
    else if (a === '--framework') args.framework = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/generate-tests.cjs [--all | --service NAME] [--framework node-test|jest|vitest] [--out DIR] [--llm] [--base URL]');
    return;
  }

  const base = args.base.replace(/\/$/, '');
  let targets = [];
  if (args.service) {
    targets = [args.service];
  } else {
    const res = await fetch(`${base}/ai/generate-tests/services`);
    if (!res.ok) throw new Error(`Cannot list services (${res.status}). Is the mock server running at ${base}?`);
    const data = await res.json();
    targets = data.services.map((s) => s.name);
    if (!args.all && targets.length > 1) {
      console.log('Multiple services found — pass --all or --service NAME:');
      data.services.forEach((s) => console.log(`  - ${s.name} (${s.type}, ${s.operations} ops)`));
      return;
    }
  }

  let totalFiles = 0;
  let totalTests = 0;
  for (const service of targets) {
    const res = await fetch(`${base}/ai/generate-tests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service, framework: args.framework, useLLM: args.llm }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`  ✗ ${service}: ${res.status} ${err}`);
      continue;
    }
    const { files, stats } = await res.json();
    const dir = path.join(args.out, service.replace(/[^a-zA-Z0-9._-]/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      fs.writeFileSync(path.join(dir, f.path), f.content, 'utf-8');
      totalFiles++;
    }
    totalTests += stats.totalTests;
    console.log(`  ✓ ${service}: ${stats.totalTests} tests (${stats.positiveTests} contract, ${stats.resilienceTests} resilience) across ${stats.operations} ops [${stats.source}] → ${dir}`);
  }

  console.log(`\nGenerated ${totalTests} tests in ${totalFiles} file(s) under "${args.out}/".`);
  if (args.framework === 'node-test') {
    console.log(`Run them:            node --test ${args.out}/**/*.test.mjs`);
    console.log(`Run with chaos:      RUN_RESILIENCE=1 node --test ${args.out}/**/*.test.mjs`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
