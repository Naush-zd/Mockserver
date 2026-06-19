# WM Sports Mock Server

Microcks-powered mock server for the entire WM Sports API surface — **14 GraphQL subgraphs**, **3 REST APIs**, **3 Event/Async APIs**, **442 operations** — with an AI agent for failure scenario testing.

**Live**: https://wmsports-mock-server.onrender.com
**Microcks**: https://microcks-uber-latest.onrender.com

---

## Quick Start

```bash
# Local (standalone — GraphQL mocks only)
npm install
npm start
# → http://localhost:4010

# Local with Microcks (full GraphQL + REST + Async support)
docker compose up
# Dashboard → http://localhost:4010
# Microcks UI → http://localhost:8585
```

---

## How Teams Use This

### 1. Direct API Calls (development & testing)

Point your code, tests, or HTTP client at the mock server. It behaves like the real APIs.

**GraphQL** — POST to `/graphql/{ServiceName}`:

```bash
curl -X POST https://wmsports-mock-server.onrender.com/graphql/StatsAPI \
  -H "Content-Type: application/json" \
  -d '{"query": "{ getGamecastBySlug { slug gameDate sport status jsonResponse } }"}'
```

**REST** — same paths as the real API:

```bash
# Census API
curl https://wmsports-mock-server.onrender.com/rest/Census%20API/1.0/v3/bleacherReport/push_notifications/237

# StatMilk
curl https://wmsports-mock-server.onrender.com/rest/StatMilk/1.0/api/leagues
```

**In test code** (Jest, Vitest, Pact, etc.):

```javascript
const MOCK_URL = 'https://wmsports-mock-server.onrender.com';

const response = await fetch(`${MOCK_URL}/graphql/StatsAPI`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: '{ getGamecastBySlug { slug gameDate sport status } }'
  })
});

const { data } = await response.json();
expect(data.getGamecastBySlug.slug).toBeDefined();
```

### 2. Dashboard Explorer (browsing & debugging)

Open the dashboard in a browser. Click any service in the sidebar, click an operation, click **Run**. The **Mock API Routes** page lists every URL for copy-pasting into curl, Postman, or test code.

### 3. AI Agent (failure & edge-case testing)

Inject AI-generated bad data into any operation to test how your code handles provider regressions.

**Via the dashboard**:
1. Select a service and operation (e.g., StatsAPI > getGamecastBySlug)
2. Pick a failure scenario from the dropdown (e.g., "Wrong Types")
3. Click **Inject** — the mock API now serves bad data
4. Click **Clear** when done — original data is restored

**Via API** (for CI/CD pipelines):

```bash
# Apply a failure scenario to an operation
curl -X POST https://wmsports-mock-server.onrender.com/ai/scenario \
  -H "Content-Type: application/json" \
  -d '{
    "service": "StatsAPI",
    "operation": "getGamecastBySlug",
    "scenario": "wrong-types",
    "fields": ["slug", "gameDate", "sport", "status"]
  }'

# Your tests now get bad data from the mock API
npm test

# Restore original data when done
curl -X POST https://wmsports-mock-server.onrender.com/ai/restore \
  -H "Content-Type: application/json" \
  -d '{"service": "StatsAPI"}'
```

**Available failure scenarios**: `wrong-types`, `missing-fields`, `null-values`, `empty-arrays`, `malformed-dates`, `deprecated-fields`, `extra-fields`, `encoding-issues`, `boundary-values`, `partial-response`

---

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard UI |
| `GET /health` | Health check (Microcks status, service counts) |
| `POST /graphql` | Unified GraphQL (auto-routes to matching schema) |
| `POST /graphql/:service` | Specific subgraph proxy to Microcks |
| `ALL /rest/:service/:version/*` | REST proxy to Microcks |
| `ALL /v3/*` | Census REST API (shortcut) |
| `ALL /statmilk/*` | StatMilk REST API (shortcut) |
| `POST /ai/scenario` | Apply AI-generated scenario data to Microcks |
| `POST /ai/restore` | Restore original examples for a service |
| `POST /ai/generate` | Preview AI-generated data (no injection) |
| `GET /ai/scenarios` | List available failure scenarios |

## GraphQL Services

| Service | Endpoint | Operations |
|---------|----------|------------|
| AdsAPI | `/graphql/AdsAPI` | Queries + Mutations |
| CmsAPI | `/graphql/CmsAPI` | Queries |
| ContentModulesAPI | `/graphql/ContentModulesAPI` | Queries + Mutations |
| DataServiceAPI | `/graphql/DataServiceAPI` | Queries |
| EpisodeAPI | `/graphql/EpisodeAPI` | Queries |
| HydrationStationAPI | `/graphql/HydrationStationAPI` | Queries + Mutations |
| LivelikeAPI | `/graphql/LivelikeAPI` | Queries |
| PushNotificationAPI | `/graphql/PushNotificationAPI` | Queries + Mutations |
| ReferenceStreamAPI | `/graphql/ReferenceStreamAPI` | Queries |
| SocialProcessorAPI | `/graphql/SocialProcessorAPI` | Queries + Mutations |
| SportsSearchAPI | `/graphql/SportsSearchAPI` | Queries |
| StatsAPI | `/graphql/StatsAPI` | Queries |
| TagAPI | `/graphql/TagAPI` | Queries |
| UserAPI | `/graphql/UserAPI` | Queries |

## REST APIs

| Service | Base Path |
|---------|-----------|
| Census API | `/rest/Census API/1.0/v3/...` or `/v3/...` |
| Census Push Notifications API | `/rest/Census Push Notifications API/1.0/v3/...` |
| StatMilk | `/rest/StatMilk/1.0/api/...` or `/statmilk/...` |

## Event/Async APIs

| Service | Protocols |
|---------|-----------|
| Push Notifications Async Events | WebSocket |
| Push Notifications Kafka Events | Kafka |
| Push Notifications RabbitMQ Messages | RabbitMQ / AMQP |

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│              Express Dashboard (port 4010)        │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ GraphQL  │  │  REST    │  │   AI Agent     │  │
│  │ Explorer │  │  Try     │  │  (Groq LLM)    │  │
│  └────┬─────┘  └────┬─────┘  └───────┬────────┘  │
│       │              │                │           │
│       └──────────────┼────────────────┘           │
│                      │ proxy                      │
└──────────────────────┼───────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────┐
│          Microcks (port 8585 / Render)            │
│                                                   │
│  14 GraphQL schemas    (.graphql)                 │
│  17 Postman collections (.postman.json)           │
│   3 OpenAPI specs      (.openapi.json/.yaml)      │
│   3 AsyncAPI specs     (.asyncapi.yaml)           │
│                                                   │
│  442 total operations                             │
└──────────────────────────────────────────────────┘
```

**AI Inject flow**: Delete service from Microcks → re-import main schema → upload AI-only Postman collection. Microcks has exactly 1 example: the AI data.

**AI Restore flow**: Delete service from Microcks → re-import main schema → re-import original Postman examples. Service is back to its original state.

---

## Production deployment (AWS)

For EC2 sizing, security groups, Docker Compose, health checks, and operations, see the **[Mock Server deployment guide](./deployment/MOCK-SERVER-DEPLOYMENT-GUIDE.md)**.

---

## Deploy to Render

1. Push this repo to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com) → New → Web Service
3. Connect repo, set Root Directory to `.`
4. Build: `npm install --production` | Start: `node server.cjs`
5. Add env vars: `PORT=4010`, `MICROCKS_URL=https://your-microcks.onrender.com`, `GROQ_API_KEY=your-key`

Or use the `render.yaml` blueprint.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4010` | Server port |
| `MICROCKS_URL` | `http://localhost:8585` | Microcks instance URL |
| `GROQ_API_KEY` | — | Groq API key for AI agent |
| `AI_MODEL` | `llama-3.3-70b-versatile` | LLM model to use |

## Documentation

For detailed design and implementation, refer to the [WM Sports Mock Server Confluence Page](https://wbddigital.atlassian.net/wiki/x/bYD8yQ).
