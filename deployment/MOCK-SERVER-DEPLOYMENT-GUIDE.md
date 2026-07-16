# Unified Mockserver — Deployment Guide

This guide covers deploying the **Unified Mockserver** (Node/Express dashboard, port **4010**) together with **Microcks**. The dashboard proxies GraphQL/REST to Microcks, runs the `/ai/*` flows, and exposes `GET /health`.

The deployment model documented here:

1. **[Docker Compose (recommended)](#docker-compose-deployment)** — dashboard + a **locally-run** Microcks + one-shot importer on a single host or VM.

Microcks always runs as a **local instance** you spin up yourself (the `microcks` container in compose); there is no hosted/managed Microcks dependency.

The repo root [`docker-compose.yml`](../docker-compose.yml) is the source of truth for the local-dev / single-VM layout.

---

## Docker Compose Deployment

### What gets deployed

Three Docker services ([`docker-compose.yml`](../docker-compose.yml)):

| Container | Image / build | Port | Purpose |
|-----------|---------------|------|---------|
| **dashboard** | `build: .` (Node 20) | **4010** | GraphQL/REST proxy, AI agent (`/ai/*`), explorer UI, `GET /health` |
| **microcks** | `quay.io/microcks/microcks-uber:latest` | **8585** | Mock engine, spec-backed examples |
| **import** | `microcks-uber` (one-shot) | — | Imports `artifacts/` into Microcks on startup; exits when done |

A shared Docker named volume `artifacts` is mounted into all three containers. The dashboard mounts it **read-write** (so AI-generated specs persist); Microcks and the importer mount it **read-only**.

### Quick start

```bash
docker compose up -d
docker compose ps
docker compose logs -f import      # confirm artifacts loaded

curl -s http://localhost:4010/health        # dashboard
curl -s http://localhost:8585/api/services  # Microcks catalog
```

Startup sequence:

1. **microcks** boots and passes its healthcheck.
2. **dashboard** boots; its entrypoint seeds `/app/artifacts` from the baked-in baseline if empty, then starts the Node server. Healthcheck waits for `GET /health` to return 200.
3. **import** runs once after the dashboard is healthy, scans `/app/artifacts/`, and bulk-uploads everything into Microcks. Exits when done.

### Configuration

Create a `.env` (see [`.env.example`](../.env.example)) or inject env vars into the `dashboard` service.

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | Optional | Default **4010** |
| `MICROCKS_URL` | Set in compose | `http://microcks:8080` on the Docker network |
| `ARTIFACTS_DIR` | Set in compose | Default `/app/artifacts` |
| `STATE_FILE_PATH` | Optional | Path on the artifacts volume (e.g. `/app/artifacts/state.json`) to persist workspaces across restarts |
| `S3_STATE_BUCKET` | Optional | S3 bucket for workspace state (preferred when running on cloud infra) |
| `MICROCKS_SERVICE_PREFIX` | Optional | Default `unified-`; namespace isolation within your local Microcks catalog |
| `GROQ_API_KEY` | Optional | Groq API key for `/ai/*` routes (or set `AI_PROVIDER=together` with `TOGETHER_API_KEY`). If unset, AI routes use deterministic fallback. |
| `AI_PROVIDER`, `AI_MODEL` | Optional | Override LLM provider/model defaults |

Never commit secrets. Inject `GROQ_API_KEY` and any Microcks credentials from your platform's secret store at deploy time.

### Persistent storage

Two pieces of state are worth preserving across restarts:

#### 1. `artifacts/` directory

Holds the Git-tracked baseline specs plus runtime-generated specs from `POST /ai/setup` (which never reach Git). The dashboard image bakes the baseline into `/app/artifacts-seed/`, and the entrypoint copies it into `/app/artifacts/` **only when the volume is empty**. After first boot, runtime-generated artifacts persist on the volume.

For a durable host mount, pin the named volume to a real path with a `docker-compose.prod.yml` override:

```yaml
volumes:
  artifacts:
    driver: local
    driver_opts:
      type: none
      device: /mnt/artifacts
      o: bind
```

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

#### 2. Workspace state

Workspaces, scenarios, and service-to-workspace mappings live in memory by default. To survive restarts, choose one:

- **S3:** set `S3_STATE_BUCKET` (+ optional `S3_STATE_KEY`, `S3_STATE_REGION`). The app reads state on boot and writes back on changes.
- **File:** set `STATE_FILE_PATH=/app/artifacts/state.json` on a persistent volume.

#### 3. Microcks data (optional)

The `microcks-uber` image bundles embedded storage. After a Microcks restart, the **import** sidecar re-runs and reloads everything from `/app/artifacts/`, so an explicit Microcks volume is not required.

### Operations

```bash
# Logs
docker compose logs -f
docker compose logs -f dashboard

# Restart
docker compose restart dashboard

# Update
git pull
docker compose build --no-cache dashboard
docker compose pull microcks
docker compose up -d

# Re-import artifacts to Microcks (after a Microcks restart or drift)
docker compose run --rm import
```

The dashboard's seed step is idempotent: an existing artifacts volume is left untouched on redeploy, so AI-generated services and workspace state survive image rebuilds.

### Networking

Expose port **4010** (dashboard + API) and, if you call Microcks directly, **8585**. There is no need for broad public exposure — put it behind a VPN, internal load balancer, or reverse proxy and allow inbound only from trusted networks. `/ai/*` routes make outbound HTTPS calls to the configured LLM provider (Groq by default).

### Monitoring

| Service | Endpoint | Expected |
|---------|----------|----------|
| Dashboard | `GET /health` | JSON with Microcks status / counts |
| Microcks | `GET /api/services` | `200 OK` with the list of services |

Run HTTP checks against both and alert on consecutive failures. If a load balancer targets the dashboard, use `/health` as the health path.

### Troubleshooting

| Issue | Fix |
|-------|-----|
| Dashboard up, GraphQL/REST errors | Check `MICROCKS_URL` from inside the dashboard container; verify Microcks is healthy; review the `import` sidecar logs |
| `/health` shows Microcks disconnected | Network, startup order, or wrong `MICROCKS_URL` |
| AI routes fail | Check `GROQ_API_KEY` / `AI_API_KEY`, outbound HTTPS, and provider rate limits |
| `/ai/setup` fails with "Failed to persist artifacts" | The artifacts volume is read-only or full; check the mount and disk usage |
| Empty Microcks catalog after deploy | The `import` sidecar didn't run or exited early — check `docker compose logs import` |
| Workspace/scenario data lost on restart | Set `S3_STATE_BUCKET` (preferred) or `STATE_FILE_PATH` on a persistent volume |
| Port conflict | Adjust host ports in compose |

---

## References

- [`README.md`](../README.md) — routes, examples, environment variables
- [`Dockerfile`](../Dockerfile) — dashboard image build
- [`entrypoint.sh`](../entrypoint.sh) — first-boot artifact seeding
- [`docker-compose.yml`](../docker-compose.yml) — service composition
- [`import-to-microcks.sh`](../import-to-microcks.sh) — bulk-import logic for the `import` sidecar
- [`.env.example`](../.env.example) — all configuration variables

Microcks runs as a local instance you start yourself (via the `microcks` service in `docker-compose.yml`, or a standalone container). Point `MICROCKS_URL` at that local instance (default `http://localhost:8585`, or `http://microcks:8080` on the compose network). The namespace prefix (`unified-`) still keeps the catalog tidy if that local instance is shared with other local tools.
