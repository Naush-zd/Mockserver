# Deploying to Render + Vercel (free demo)

This hosts the **backend on Render** and the **Next.js frontend on Vercel**. It's
tuned for a free, publicly reachable demo — state is ephemeral and free instances
cold-start after idle. For a durable/shared deployment see
`MOCK-SERVER-DEPLOYMENT-GUIDE.md` (AWS).

## Architecture

```
Vercel (web / Next.js)  ──HTTPS──▶  Render: mockserver-dashboard (Express, public)
   env: BACKEND_URL                        │
                                           └─▶ Render: mockserver-microcks (private)
```

- The browser only ever calls the Vercel app at same-origin `/backend/*`. Vercel's
  route handler (`web/src/app/backend/[[...path]]/route.ts`) proxies that to the
  Render dashboard server-side using `BACKEND_URL` — so there's **no CORS** and the
  backend URL is configurable at runtime.
- The dashboard reaches Microcks over Render's private network via `MICROCKS_URL`,
  wired automatically by `render.yaml` (`fromService` → `hostport`).

## Part 1 — Render (backend)

1. Push this repo (including `render.yaml`) to GitHub.
2. In the Render dashboard: **New → Blueprint**, pick this repo. Render reads
   `render.yaml` and proposes two services:
   - `mockserver-microcks` — private service, the mock engine.
   - `mockserver-dashboard` — public web service, the Express API + dashboard.
3. Click **Apply**. Wait for both to reach **Live**. First build pulls the
   `microcks-uber` image and builds the dashboard `Dockerfile`.
4. Copy the dashboard's public URL, e.g. `https://mockserver-dashboard.onrender.com`.

### Verify the backend

```bash
curl https://mockserver-dashboard.onrender.com/health          # → 200
curl https://mockserver-dashboard.onrender.com/rest/... # a mock endpoint
```

In the dashboard service **Logs**, look for `Microcks: N services (...)` on boot —
that confirms the `preDeployCommand` imported the baked-in specs. If you instead see
`⚠ Microcks not reachable`, the Microcks service is still starting or OOMed (see
Troubleshooting).

## Part 2 — Vercel (frontend)

1. In Vercel: **Add New → Project**, import the same repo.
2. Set **Root Directory = `web`**. Framework auto-detects as **Next.js** — leave
   build/output settings at their defaults.
3. Add an Environment Variable (Production **and** Preview):
   - `BACKEND_URL` = `https://mockserver-dashboard.onrender.com` (your dashboard URL,
     no trailing slash)
4. **Deploy.** Open the Vercel URL, go to the **Services** / **Routes** page — it
   should list the mock services fetched through the proxy. Trigger a mock call to
   confirm the full path `Vercel → Render dashboard → Microcks` works.

If you change `BACKEND_URL` later, redeploy the Vercel project for it to take effect.

## Troubleshooting

- **Everything slow on first hit after a while** — free instances spin down after
  ~15 min idle. First request wakes them (can take 30–60s) and Microcks re-imports
  specs. Expected on free tier.
- **Microcks OOM / dashboard shows "Microcks not reachable"** — `microcks-uber` is
  memory-heavy for the 512 MB free plan. Bump `mockserver-microcks` to
  `plan: starter` in `render.yaml` and re-apply. The dashboard still serves
  `@graphql-tools/mock` fallback responses while Microcks is down.
- **`pserv` rejected / private services not on your plan** — change
  `mockserver-microcks` to `type: web` in `render.yaml`, redeploy, then set the
  dashboard's `MICROCKS_URL` to the Microcks **public** `.onrender.com` URL (remove
  the `fromService` block and use a literal `value`). This works but exposes the raw
  engine publicly.
- **AI Studio features do nothing** — expected. They run in fallback mode until you
  set `AI_API_KEY` (and `AI_BASE_URL` if using a custom endpoint) on the
  `mockserver-dashboard` service. The old compose pointed at a host-local proxy that
  doesn't exist on Render.
- **CORS errors in the browser** — you shouldn't get any; the browser calls the
  Vercel origin only. If you do, confirm `BACKEND_URL` is set on Vercel and you're
  not calling the Render URL directly from client code.
