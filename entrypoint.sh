#!/bin/bash
# Container entrypoint for the dashboard.
#
# Two boot-time concerns are handled before exec'ing the Node server:
#
# 1. Artifact seeding — /app/artifacts is a writable persistent volume (EBS in
#    EC2 days, EFS in ECS). On first boot it's empty, so we seed it from
#    /app/artifacts-seed which is baked read-only into the image. Subsequent
#    boots leave runtime-generated artifacts (AI scenarios, overrides) alone.
#
# 2. Secrets fan-out — AWS Secrets Manager → ECS task def can inject the
#    entire JSON secret as a single SECRETS_JSON env var. We parse it once
#    here and re-export each key as its own env var so the Node app reads
#    MICROCKS_URL etc. via process.env.<KEY> with no code changes. Adding a
#    new secret key in Secrets Manager Just Works without touching the
#    task definition.
set -e

ARTIFACTS_DIR="${ARTIFACTS_DIR:-/app/artifacts}"
SEED_DIR="${SEED_DIR:-/app/artifacts-seed}"

mkdir -p "$ARTIFACTS_DIR"

# Seed only when the volume is empty so we never clobber runtime-generated
# artifacts on container restart.
if [ -d "$SEED_DIR" ] && [ -z "$(ls -A "$ARTIFACTS_DIR" 2>/dev/null)" ]; then
  echo "[entrypoint] Seeding $ARTIFACTS_DIR from $SEED_DIR"
  cp -R "$SEED_DIR"/. "$ARTIFACTS_DIR"/
else
  echo "[entrypoint] $ARTIFACTS_DIR already populated, skipping seed"
fi

# Fan out a single SECRETS_JSON blob into individual env vars. The `@sh`
# filter in jq quotes values safely (handles quotes / spaces / $ in values),
# which the more common `="\(.[$k])"` pattern doesn't. Skipped silently when
# SECRETS_JSON is unset (e.g. local dev where vars come from .env directly).
if [ -n "$SECRETS_JSON" ]; then
  KEY_COUNT=$(echo "$SECRETS_JSON" | jq 'length')
  echo "[entrypoint] Exporting $KEY_COUNT keys from SECRETS_JSON"
  eval "$(echo "$SECRETS_JSON" | jq -r 'keys[] as $k | "export \($k)=\(.[$k] | @sh)"')"
fi

exec "$@"
