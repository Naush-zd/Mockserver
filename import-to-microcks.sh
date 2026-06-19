#!/bin/bash
# Auto-import all artifacts into the Microcks sidecar on startup
set -e

MICROCKS_URL="${MICROCKS_URL:-http://localhost:8585}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-/app/artifacts}"

echo "Waiting for Microcks at $MICROCKS_URL..."
for i in $(seq 1 60); do
  if curl -sf "$MICROCKS_URL/api/services" > /dev/null 2>&1; then
    echo "Microcks is ready"
    break
  fi
  [ "$i" -eq 60 ] && echo "ERROR: Microcks not ready after 3 minutes" && exit 1
  sleep 3
done

echo ""
echo "=== Importing main artifacts (schemas + OpenAPI specs) ==="
for f in "$ARTIFACTS_DIR"/*-schema.graphql "$ARTIFACTS_DIR"/*-openapi.json "$ARTIFACTS_DIR"/*-openapi.yaml "$ARTIFACTS_DIR"/*-asyncapi.yaml; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  case "$name" in
    *.graphql) mime="text/plain" ;;
    *.json)    mime="application/json" ;;
    *.yaml)    mime="text/yaml" ;;
  esac
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$MICROCKS_URL/api/artifact/upload?mainArtifact=true" \
    -F "file=@$f;type=$mime")
  [ "$code" = "201" ] || [ "$code" = "200" ] && echo "  ✓ $name" || echo "  ✗ $name (HTTP $code)"
done

echo ""
echo "Waiting for indexing..."
sleep 5

echo "=== Importing Postman examples ==="
for f in "$ARTIFACTS_DIR"/*-examples.postman.json; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$MICROCKS_URL/api/artifact/upload?mainArtifact=false" \
    -F "file=@$f;type=application/json")
  [ "$code" = "201" ] || [ "$code" = "200" ] && echo "  ✓ $name" || echo "  ✗ $name (HTTP $code)"
done

echo ""
echo "=== Clearing QUERY_ARGS dispatchers ==="
curl -s "$MICROCKS_URL/api/services?page=0&size=200" 2>/dev/null | python3 -c "
import sys, json, urllib.request, urllib.parse
microcks = '$MICROCKS_URL'
try:
    data = json.load(sys.stdin)
except:
    sys.exit(0)
for svc in data:
    for op in svc.get('operations', []):
        if op.get('dispatcher') in ('QUERY_ARGS',):
            url = microcks + '/api/services/' + svc['id'] + '/operation?operationName=' + urllib.parse.quote(op['name'])
            req = urllib.request.Request(url, json.dumps({'dispatcher': None, 'dispatcherRules': None}).encode(),
                {'Content-Type': 'application/json'}, method='PUT')
            try:
                urllib.request.urlopen(req, timeout=5)
                print('  cleared ' + svc['name'] + '/' + op['name'])
            except:
                pass
" 2>/dev/null || true

echo ""
total=$(curl -s "$MICROCKS_URL/api/services?page=0&size=200" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
echo "Done. $total services loaded in Microcks."
