# Unified Mockserver

**An AI-augmented API virtualization & resilience-testing platform.** Point any spec (GraphQL SDL, OpenAPI, AsyncAPI, Postman) at it and get a live, Microcks-powered mock for **GraphQL, REST, and Event/Async APIs** — then let the built-in AI agent (1) generate realistic mock data, (2) inject production-like failure scenarios ("chaos engineering for API contracts"), and (3) **auto-generate runnable consumer contract tests** that catch upstream breaking changes before they hit production.

### The production problem it solves

In API/microservice-heavy systems, two failure modes cost real time and cause real outages:

1. **Blocked development & flaky tests** — teams can't build or test reliably when upstream/third-party APIs are unavailable, rate-limited, or unstable in non-prod environments.
2. **"Worked in test, broke in prod"** — tests only cover happy paths. A provider quietly changes a field's type, returns `null`, or empties an array, and consumers break in production. Edge-case fixtures are written by hand and rot.

Unified Mockserver replaces the flaky dependency with a faithful mock **and** uses AI to turn each API's schema into an executable safety net — including negative tests for the exact ways APIs regress in production.

> **Flagship feature:** [AI Contract Test Generation](#flagship-ai-contract-test-generation) — schema in, a runnable test suite out, in milliseconds.

---

## Quick Start

```bash
# Full stack: Next.js frontend + Express API + Microcks
docker compose up --build
# Frontend (Next.js)   → http://localhost:3000
# API / legacy UI      → http://localhost:4010  (legacy dashboard at /legacy)
# Microcks UI          → http://localhost:8585
```

Run the two apps separately for development:

```bash
# 1) Backend API
npm install && npm start          # → http://localhost:4010

# 2) Frontend (in another terminal)
cd web && npm install
BACKEND_URL=http://localhost:4010 npm run dev   # → http://localhost:3000
```

The `artifacts/` folder ships with a couple of generic sample specs (`test`, `testql`) so the stack has something to serve out of the box. Drop your own specs there (or upload them) to add services.

### Stack

- **Frontend** (`web/`) — Next.js (App Router) + TypeScript + Tailwind. Talks to the API same-origin via a runtime proxy route (`/backend/*` → `BACKEND_URL`), so there's no CORS and the backend URL is configurable at container start.
- **Backend** (root) — Node/Express JSON API + Microcks integration + AI agents. The original server-rendered dashboard is preserved at **`/legacy`**.
- **Engine** — Microcks (GraphQL/REST/AsyncAPI/gRPC mocking).

---

## How To Use It

### 1. Direct API calls (development & testing)

Point your code, tests, or HTTP client at the mock server. It behaves like the real APIs.

**GraphQL** — POST to `/graphql/{ServiceName}`:

```bash
curl -X POST http://localhost:4010/graphql/test \
  -H "Content-Type: application/json" \
  -d '{"query": "{ resourceName { field1 field2 nestedObject { nestedField1 } } }"}'
```

**REST** — same paths as the real API, under `/rest/{ServiceName}/{Version}`:

```bash
curl http://localhost:4010/rest/test/1.0/test
curl http://localhost:4010/rest/test/1.0/test/123
```

**In test code** (Jest, Vitest, Pact, etc.):

```javascript
const MOCK_URL = 'http://localhost:4010';

const response = await fetch(`${MOCK_URL}/graphql/test`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: '{ resourceName { field1 field2 } }' })
});

const { data } = await response.json();
expect(data.resourceName.field1).toBeDefined();
```

### 2. Dashboard explorer (browsing & debugging)

Open the dashboard in a browser. Click any service in the sidebar, pick an operation, and click **Run**. The **Mock API Routes** page lists every URL for copy-pasting into curl, Postman, or test code.

### 3. AI agent (failure & edge-case testing)

Inject AI-generated bad data into any operation to test how your code handles provider regressions.

**Via the dashboard:**
1. Select a service and operation.
2. Pick a failure scenario from the dropdown (e.g. "Wrong Types").
3. Click **Inject** — the mock API now serves bad data.
4. Click **Clear** when done — original data is restored.

**Via API** (for CI/CD pipelines):

```bash
# Apply a failure scenario to an operation
curl -X POST http://localhost:4010/ai/scenario \
  -H "Content-Type: application/json" \
  -d '{
    "service": "test",
    "operation": "resourceName",
    "scenario": "wrong-types",
    "fields": ["field1", "field2"]
  }'

# Your tests now get bad data from the mock API
npm test

# Restore original data when done
curl -X POST http://localhost:4010/ai/restore \
  -H "Content-Type: application/json" \
  -d '{"service": "test"}'
```

**Available failure scenarios**: `wrong-types`, `missing-fields`, `null-values`, `empty-arrays`, `malformed-dates`, `deprecated-fields`, `extra-fields`, `encoding-issues`, `boundary-values`, `partial-response`

---

## Flagship: AI Contract Test Generation

Writing and maintaining consumer contract tests is tedious, so teams skip them — and skip the *negative* tests entirely. This feature turns any mocked service into a **runnable contract test suite** in one call: it reads the service's schema/spec, builds real requests, and emits per-field type assertions plus chaos/resilience tests that inject failure scenarios and assert the contract catches them.

Every generated suite has two layers, powered by the *same* validator so they can't drift:

- **Contract tests** (always on) — call the mock and assert every field promised by the contract is present and correctly typed. A clean mock passes 100%.
- **Resilience tests** (`RUN_RESILIENCE=1`) — inject an AI failure scenario, re-fetch, and assert the validator now reports violations. A passing resilience test == a real upstream breaking change the suite *would* catch.

Output targets **`node-test`** (zero-dependency, runs with `node --test`), **`jest`**, and **`vitest`**. Generation is deterministic by default (works offline, no API key) and optionally LLM-enhanced for richer assertions and comments.

### Generate tests

```bash
# From the dashboard: click the "Generate Tests" button (bottom-right), pick a
# service + framework, preview, and download.

# From the CLI (writes to ./generated-tests/<service>/):
npm run gen:tests                        # all loaded services, node-test
node scripts/generate-tests.cjs --service testql --framework jest
node scripts/generate-tests.cjs --all --llm --out generated-tests

# From the API:
curl -X POST http://localhost:4010/ai/generate-tests \
  -H "Content-Type: application/json" \
  -d '{"service":"testql","framework":"node-test"}'
```

### Run the generated tests

```bash
node --test generated-tests/**/*.test.mjs                 # contract tests (clean mock ⇒ 100% pass)
RUN_RESILIENCE=1 node --test generated-tests/**/*.test.mjs # + chaos: catch injected regressions
MOCK_BASE_URL=https://your-deployed-mock node --test ...   # point at any deployed instance
```

### Benchmark (quantifiable metrics)

The benchmark harness generates suites for every loaded service, runs them against the live mock, and reports coverage, generation latency, contract pass-rate, and — with `--resilience` — how many injected breaking changes the suites caught. Results are written to `benchmark-report.json`.

```bash
docker compose up -d          # stack must be running
npm run benchmark             # generate + run contract tests
npm run benchmark:chaos       # also inject & detect breaking changes
```

```
  AI Contract Test Generator — Benchmark
  ────────────────────────────────────────────────────────
  Services covered:    2
  Operations covered:  6
  Contract tests:      6
  Resilience tests:    6
  Avg gen latency:     <ms/service>
  ────────────────────────────────────────────────────────
  Contract pass:       6/6 (100%) against the clean mock
  Regressions caught:  6/6 injected breaking changes detected
```

> Numbers scale with the specs you load — run `npm run benchmark:chaos` against your own APIs to generate real figures for your résumé.

---

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard UI |
| `GET /health` | Health check (Microcks status, service counts) |
| `POST /graphql` | Unified GraphQL (auto-routes to the matching schema) |
| `POST /graphql/:service` | Specific subgraph proxy to Microcks |
| `ALL /rest/:service/:version/*` | REST proxy to Microcks |
| `ALL /rest/:service/*` | REST proxy (defaults to version `1.0`) |
| `ALL /ws/:workspaceId/rest/:service/*` | Workspace-scoped REST proxy |
| `POST /ai/setup` | Schema + prompt → auto-deploy a mock service |
| `POST /ai/scenario` | Apply an AI-generated failure scenario to Microcks |
| `POST /ai/restore` | Restore original examples for a service |
| `POST /ai/generate` | Preview AI-generated data (no injection) |
| `GET /ai/scenarios` | List available failure scenarios |
| `GET /ai/generate-tests/services` | List services + supported test frameworks |
| `POST /ai/generate-tests` | Generate a contract test suite for a service |

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│        Next.js Frontend (port 3000)               │
│  Overview · Services · Contract Tests · Chaos Lab │
│  TypeScript + Tailwind (App Router)               │
└───────────────────────┬──────────────────────────┘
                        │ /backend/*  (runtime proxy route)
                        ▼
┌──────────────────────────────────────────────────┐
│           Express JSON API (port 4010)            │
│  ┌──────────┐ ┌──────┐ ┌──────────┐ ┌─────────┐  │
│  │ GraphQL  │ │ REST │ │ AI Agent │ │ Contract │  │
│  │ proxy    │ │ proxy│ │ (Groq)   │ │ Test Gen │  │
│  └────┬─────┘ └──┬───┘ └────┬─────┘ └────┬─────┘  │
│       └──────────┴──────────┴────────────┘        │
│                      │ proxy      (legacy UI: /legacy)
└──────────────────────┼───────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────┐
│          Microcks (local, port 8585)              │
│  GraphQL / OpenAPI / Postman / AsyncAPI / gRPC    │
└──────────────────────────────────────────────────┘
```

**AI Inject flow**: delete the service from Microcks → re-import the main schema → upload the AI-only Postman collection. Microcks then has exactly one example: the AI data.

**AI Restore flow**: delete the service from Microcks → re-import the main schema → re-import the original Postman examples. The service is back to its original state.

When Microcks is unavailable, the standalone server falls back to `@graphql-tools/mock` for GraphQL.

---

## Deployment

- **Docker Compose / single VM** — see the [deployment guide](./deployment/MOCK-SERVER-DEPLOYMENT-GUIDE.md). Microcks runs as a **local instance** you start yourself (the `microcks` service in `docker-compose.yml`); there is no hosted/managed Microcks dependency.

---

## Environment Variables

See [`.env.example`](./.env.example) for the full list. The most common ones:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4010` | Server port |
| `MICROCKS_URL` | `http://localhost:8585` | Local Microcks instance URL |
| `MICROCKS_SERVICE_PREFIX` | `unified-` | Namespace prefix for services this server manages in the local catalog |
| `GROQ_API_KEY` | — | Groq API key for the AI agent (optional; falls back to deterministic generation) |
| `AI_MODEL` | `llama-3.3-70b-versatile` | LLM model to use |
| `S3_STATE_BUCKET` / `STATE_FILE_PATH` | — | Persist workspace/scenario state across restarts |

---

## Scoping

Pass an `X-User` header to isolate overrides and scenarios per person, and an `X-Workspace` header (or the `/ws/:workspaceId/...` routes) to scope AI-generated services to a workspace.

---

## Résumé & Interview Talking Points

**One-liner:** Built a self-serve API virtualization platform that uses AI to generate mock data, inject production-like failure scenarios, and auto-generate runnable consumer contract tests — turning any API spec into an executable safety net that catches upstream breaking changes before production.

**Résumé bullets** (fill in the numbers from `npm run benchmark:chaos`):

- Built a **full-stack developer platform** — **Next.js (App Router) + TypeScript + Tailwind** frontend over a **Node/Express** JSON API, **Microcks**, and a **Groq LLM** agent, all Dockerized — that mocks GraphQL, REST, and event/async APIs from their specs.
- Designed a **runtime reverse-proxy layer** (Next route handler → `BACKEND_URL`) so the SPA talks to the API same-origin with zero CORS and environment-portable config.
- Shipped an **AI contract-test generator** that converts an API schema into a runnable suite (`node-test`/`jest`/`vitest`) in **~<X> ms/service**, covering **<N> operations** with per-field type assertions — eliminating hand-written contract tests.
- Added **chaos/resilience testing** ("chaos engineering for API contracts"): injects failure scenarios (wrong types, missing/null fields, malformed dates, boundary values) and auto-generates negative tests that **caught <M>/<M> injected breaking changes** in benchmarks.
- Engineered a **deterministic-first generator with optional LLM enhancement**, so the tool works offline with zero API keys and degrades gracefully — a production-reliability pattern for LLM-backed features.
- Built a **benchmark harness** producing quantifiable coverage, latency, and regression-detection metrics, plus a one-click dashboard generator and a CLI that targets any deployed instance.

**Why it stands out in interviews:** it maps to a real, widely-felt production pain (contract drift / flaky integration tests), demonstrates pragmatic LLM engineering (deterministic fallback, JSON-mode prompting, guardrails), and is fully demonstrable end-to-end with measurable results.

### 90-second demo script

```bash
# 1. Bring up the stack (mock server + Microcks + sample specs)
docker compose up -d

# 2. Show a mock responding to the contract
curl http://localhost:4010/rest/test/1.0/test/123

# 3. Generate a contract test suite from the schema (open the dashboard's
#    "Generate Tests" button, or:)
npm run gen:tests

# 4. Run it green against the clean mock
node --test generated-tests/**/*.test.mjs

# 5. The money shot — inject breaking changes and prove the suite catches them
npm run benchmark:chaos        # → "Regressions caught: M/M"
```
