'use client';

import * as React from 'react';
import { api } from '@/lib/api';
import type { ServiceDetail, Operation, ScenarioInfo, EdgeCaseScenario, ChaosFault } from '@/lib/types';
import { Card, Button, Spinner, Badge, StatusDot, Field, Select, Input } from '@/components/ui';
import { IconSearch, IconStar } from '@/components/icons';
import { useExplorerStore, pinKey } from '@/lib/explorer-store';
import type { HistoryEntry } from '@/lib/explorer-store';

const PARAM_DEFAULTS: Record<string, string> = {
  id: '123',
  uuid: '006320e5-ceea-431e-9dab-8b5c368a8c0c',
  userId: '1',
  user_id: '1',
  slug: 'example',
  date: '2026-03-01',
};

function isGraphql(type: string) {
  return type === 'GRAPHQL' || type === 'GRAPH';
}

function methodOf(op: Operation): string {
  const first = op.name.split(' ')[0];
  return first && /^[A-Z]+$/.test(first) ? first : op.method || 'GET';
}

function restSubPath(op: Operation): string {
  const parts = op.name.split(' ');
  let sub = parts.length > 1 ? parts.slice(1).join(' ') : op.resourcePaths?.[0] || '/';
  sub = sub.replace(/\{([^}]+)\}/g, (_m, p) => PARAM_DEFAULTS[p] || PARAM_DEFAULTS[p.replace(/-/g, '_')] || 'example');
  if (!sub.startsWith('/')) sub = '/' + sub;
  return sub;
}

function restPathFor(service: ServiceDetail, op: Operation): { method: string; path: string } {
  return { method: methodOf(op), path: `/rest/${encodeURIComponent(service.name)}/${service.version || '1.0'}${restSubPath(op)}` };
}

// Top-level field names of a response body, used when injecting field-targeted
// scenarios (wrong-types, missing-fields, …).
function topLevelFields(service: ServiceDetail, op: Operation, body: unknown): string[] {
  let node: unknown = body;
  if (isGraphql(service.type)) {
    const data = (body as { data?: Record<string, unknown> })?.data;
    node = data ? data[op.name.replace(/^(QUERY|MUTATION)\s+/, '')] ?? data[op.name] : undefined;
  }
  const item = Array.isArray(node) ? node[0] : node;
  return item && typeof item === 'object' ? Object.keys(item as Record<string, unknown>) : [];
}

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-success',
  POST: 'text-ring',
  PUT: 'text-warning',
  PATCH: 'text-warning',
  DELETE: 'text-danger',
  QUERY: 'text-ring',
  MUTATION: 'text-warning',
};

type Resp = { status: number; body: unknown; timeMs: number; sizeBytes: number };

export default function ExplorerPage() {
  const [services, setServices] = React.useState<ServiceDetail[]>([]);
  const [selected, setSelected] = React.useState<ServiceDetail | null>(null);
  const [opName, setOpName] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [restMethod, setRestMethod] = React.useState('GET');
  const [restPath, setRestPath] = React.useState('');
  const [response, setResponse] = React.useState<Resp | null>(null);
  const [tab, setTab] = React.useState<'pretty' | 'raw'>('pretty');
  const [filter, setFilter] = React.useState('');
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [panel, setPanel] = React.useState<'apis' | 'history' | 'saved'>('apis');

  // Edge cases + scenario injection + transport faults (formerly the Chaos Lab)
  const [showLab, setShowLab] = React.useState(false);
  const [scenarios, setScenarios] = React.useState<ScenarioInfo[]>([]);
  const [scenario, setScenario] = React.useState('wrong-types');
  const [edgePrompt, setEdgePrompt] = React.useState('');
  const [edgeCases, setEdgeCases] = React.useState<EdgeCaseScenario[]>([]);
  const [suggesting, setSuggesting] = React.useState(false);
  const [injecting, setInjecting] = React.useState(false);
  const [labMsg, setLabMsg] = React.useState<{ tone: 'green' | 'red' | 'default'; text: string } | null>(null);
  const [faults, setFaults] = React.useState<ChaosFault[]>([]);
  const [latencyMs, setLatencyMs] = React.useState('0');
  const [jitterMs, setJitterMs] = React.useState('0');
  const [errorPct, setErrorPct] = React.useState('0');
  const [errorStatus, setErrorStatus] = React.useState('503');
  const [faultBusy, setFaultBusy] = React.useState(false);

  const store = useExplorerStore();
  // When set, the autofill effect applies this saved request instead of
  // recomputing a default query/path for the selected operation.
  const pendingLoad = React.useRef<Partial<HistoryEntry> | null>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const d = await api.servicesDetail();
        setServices(d.services);
        if (d.services[0]) {
          setSelected(d.services[0]);
          setOpName(d.services[0].operations?.[0]?.name || '');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load services');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  React.useEffect(() => {
    if (!selected) return;
    const ops = selected.operations || [];
    const op = ops.find((o) => o.name === opName) || ops[0];
    if (!op) return;
    if (op.name !== opName) setOpName(op.name);

    // Applying a loaded history/saved entry — use its stored request verbatim.
    if (pendingLoad.current) {
      const p = pendingLoad.current;
      pendingLoad.current = null;
      if (isGraphql(selected.type)) {
        setQuery(p.query || '');
      } else {
        setRestMethod(p.method || 'GET');
        setRestPath(p.path || '');
      }
      setResponse(null);
      return;
    }

    if (isGraphql(selected.type)) {
      (async () => {
        const { fields } = await api.queryFields(op.name, selected.name);
        setQuery(fields ? `query {\n  ${op.name} {\n    ${fields}\n  }\n}` : `query {\n  ${op.name}\n}`);
      })();
    } else {
      const { method, path } = restPathFor(selected, op);
      setRestMethod(method);
      setRestPath(path);
    }
    setResponse(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, opName]);

  const loadEntry = (entry: HistoryEntry) => {
    const svc = services.find((s) => s.name === entry.service);
    if (!svc) {
      setError(`Service "${entry.service}" is no longer available.`);
      return;
    }
    pendingLoad.current = entry;
    setSelected(svc);
    setOpName(entry.opName);
    setPanel('apis');
  };

  const saveCurrent = () => {
    if (!selected) return;
    const gqlNow = isGraphql(selected.type);
    const label = window.prompt('Save request as…', `${selected.name} · ${opName}`);
    if (!label) return;
    store.saveEntry(
      {
        service: selected.name,
        type: selected.type,
        gql: gqlNow,
        opName,
        query: gqlNow ? query : undefined,
        method: gqlNow ? undefined : restMethod,
        path: gqlNow ? undefined : restPath,
        status: response?.status ?? 0,
        timeMs: response?.timeMs ?? 0,
      },
      label
    );
  };

  const run = async () => {
    if (!selected) return;
    setRunning(true);
    setError(null);
    setResponse(null);
    const t0 = performance.now();
    try {
      const gqlNow = isGraphql(selected.type);
      const res = gqlNow
        ? await api.runGraphql(selected.name, query)
        : await api.runRest(restPath, restMethod, restMethod === 'GET' ? undefined : {});
      const timeMs = Math.round(performance.now() - t0);
      const sizeBytes = new Blob([JSON.stringify(res.body ?? '')]).size;
      setResponse({ ...res, timeMs, sizeBytes });
      store.addHistory({
        service: selected.name,
        type: selected.type,
        gql: gqlNow,
        opName,
        query: gqlNow ? query : undefined,
        method: gqlNow ? undefined : restMethod,
        path: gqlNow ? undefined : restPath,
        status: res.status,
        timeMs,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setRunning(false);
    }
  };

  const refreshFaults = React.useCallback(async () => {
    try {
      const { faults: f } = await api.chaosFaults();
      setFaults(f);
    } catch {
      /* ignore */
    }
  }, []);

  React.useEffect(() => {
    api.scenarios().then(setScenarios).catch(() => setScenarios([]));
    refreshFaults();
  }, [refreshFaults]);

  const currentOp = selected?.operations.find((o) => o.name === opName) || selected?.operations[0];

  const suggestEdgeCases = async () => {
    if (!selected || !currentOp) return;
    setSuggesting(true);
    setLabMsg(null);
    setEdgeCases([]);
    try {
      const { scenarios: sc } = await api.suggestScenarios({
        service: selected.name,
        operation: currentOp.name,
        apiType: isGraphql(selected.type) ? 'graphql' : 'rest',
        prompt: edgePrompt || undefined,
      });
      setEdgeCases(sc);
      if (!sc.length) setLabMsg({ tone: 'default', text: 'No edge cases suggested for this operation.' });
    } catch (e) {
      setLabMsg({ tone: 'red', text: e instanceof Error ? e.message : 'Suggestion failed' });
    } finally {
      setSuggesting(false);
    }
  };

  const injectAndRun = async (opts: { scenario?: string; prompt?: string; label?: string }) => {
    if (!selected || !currentOp) return;
    setInjecting(true);
    setLabMsg({ tone: 'default', text: `Injecting ${opts.label || opts.scenario || 'edge case'}…` });
    try {
      let baseBody = response?.body;
      if (baseBody == null) {
        const r = isGraphql(selected.type)
          ? await api.runGraphql(selected.name, query)
          : await api.runRest(restPath, restMethod, restMethod === 'GET' ? undefined : {});
        baseBody = r.body;
      }
      const fields = topLevelFields(selected, currentOp, baseBody);
      const payload: Parameters<typeof api.injectScenario>[0] = {
        service: selected.name,
        operation: currentOp.name,
        apiType: isGraphql(selected.type) ? 'graphql' : 'rest',
        fields,
      };
      if (opts.scenario) payload.scenario = opts.scenario;
      if (opts.prompt) payload.prompt = opts.prompt;
      if (!isGraphql(selected.type)) {
        payload.method = methodOf(currentOp);
        payload.path = restSubPath(currentOp);
      }
      await api.injectScenario(payload);
      await run();
      setLabMsg({ tone: 'green', text: 'Injected — the response above now reflects the scenario.' });
    } catch (e) {
      setLabMsg({ tone: 'red', text: e instanceof Error ? e.message : 'Injection failed' });
    } finally {
      setInjecting(false);
    }
  };

  const restoreData = async () => {
    if (!selected) return;
    setInjecting(true);
    setLabMsg({ tone: 'default', text: 'Restoring…' });
    try {
      await api.restore(selected.name);
      await run();
      setLabMsg({ tone: 'green', text: 'Restored to original mock data.' });
    } catch (e) {
      setLabMsg({ tone: 'red', text: e instanceof Error ? e.message : 'Restore failed' });
    } finally {
      setInjecting(false);
    }
  };

  const applyFault = async () => {
    if (!selected) return;
    setFaultBusy(true);
    try {
      await api.setChaosFault({
        service: selected.name,
        latencyMs: Number(latencyMs) || 0,
        jitterMs: Number(jitterMs) || 0,
        errorRate: (Number(errorPct) || 0) / 100,
        errorStatus: Number(errorStatus) || 503,
        enabled: true,
      });
      await refreshFaults();
    } finally {
      setFaultBusy(false);
    }
  };

  const clearFault = async (svc: string) => {
    setFaultBusy(true);
    try {
      await api.clearChaosFault(svc || undefined);
      await refreshFaults();
    } finally {
      setFaultBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading services…" />;

  const q = filter.trim().toLowerCase();
  const filtered = services
    .map((s) => ({
      ...s,
      operations: (s.operations || []).filter(
        (o) => !q || o.name.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
      ),
    }))
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.operations.length > 0);

  const gql = selected ? isGraphql(selected.type) : false;
  const bodyStr = response ? JSON.stringify(response.body, null, 2) : '';

  const pinnedOps = store.pins
    .map((key) => {
      const [svcName, ...rest] = key.split('::');
      const opFullName = rest.join('::');
      const svc = services.find((s) => s.name === svcName);
      const op = svc?.operations.find((o) => o.name === opFullName);
      return svc && op ? { svc, op } : null;
    })
    .filter((x): x is { svc: ServiceDetail; op: Operation } => x !== null);

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold text-fg">API Explorer</h1>
        <p className="mt-1 text-sm text-muted">
          Browse mocked services and run operations against the live mock — GraphQL and REST.
        </p>
      </header>

      {error ? (
        <Card className="border-danger/40">
          <p className="text-sm text-danger">{error}</p>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        {/* Left: tabs → APIs / History / Saved */}
        <Card className="flex h-fit flex-col gap-3 p-3">
          <div className="flex gap-1 rounded-md bg-surface-2 p-1">
            {(['apis', 'history', 'saved'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setPanel(t)}
                className={`flex-1 rounded px-2 py-1 text-xs font-medium capitalize transition ${
                  panel === t ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'
                }`}
              >
                {t === 'apis' ? 'APIs' : t}
                {t === 'history' && store.history.length ? ` (${store.history.length})` : ''}
                {t === 'saved' && store.saved.length ? ` (${store.saved.length})` : ''}
              </button>
            ))}
          </div>

          {panel === 'apis' ? (
            <>
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
                  <IconSearch width={15} height={15} />
                </span>
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Search APIs…"
                  className="w-full rounded-md border border-[rgb(var(--border))] bg-surface-2 py-1.5 pl-8 pr-2 text-sm text-fg outline-none placeholder:text-muted focus:border-ring"
                />
              </div>

              {pinnedOps.length > 0 ? (
                <div>
                  <div className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-warning">Pinned</div>
                  <div className="flex flex-col">
                    {pinnedOps.map(({ svc, op }) => {
                      const active = selected?.name === svc.name && opName === op.name;
                      const m = methodOf(op);
                      return (
                        <div
                          key={pinKey(svc.name, op.name)}
                          className={`group flex items-center gap-2 rounded-md px-2 py-1.5 transition ${
                            active ? 'bg-primary/10' : 'hover:bg-surface-2'
                          }`}
                        >
                          <button
                            onClick={() => {
                              setSelected(services.find((x) => x.name === svc.name) || null);
                              setOpName(op.name);
                            }}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm text-fg"
                          >
                            <span className={`w-14 shrink-0 font-mono text-[10px] font-bold ${METHOD_COLOR[m] || 'text-muted'}`}>
                              {m}
                            </span>
                            <span className="truncate font-mono text-xs">{op.name.replace(/^[A-Z]+ /, '')}</span>
                          </button>
                          <button
                            onClick={() => store.togglePin(svc.name, op.name)}
                            aria-label="Unpin"
                            className="shrink-0 text-warning"
                          >
                            <IconStar width={14} height={14} fill="currentColor" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-col gap-3">
                {filtered.map((s) => (
                  <div key={s.name}>
                    <div className="mb-1 flex items-center justify-between px-1">
                      <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted">
                        {s.displayName || s.name}
                      </span>
                      <Badge tone={isGraphql(s.type) ? 'blue' : s.type === 'REST' ? 'green' : 'yellow'}>{s.type}</Badge>
                    </div>
                    <div className="flex flex-col">
                      {s.operations.map((o) => {
                        const active = selected?.name === s.name && opName === o.name;
                        const m = methodOf(o);
                        const pinned = store.isPinned(s.name, o.name);
                        return (
                          <div
                            key={o.name}
                            className={`group flex items-center gap-2 rounded-md px-2 py-1.5 transition ${
                              active ? 'bg-primary/10' : 'hover:bg-surface-2'
                            }`}
                          >
                            <button
                              onClick={() => {
                                setSelected(services.find((x) => x.name === s.name) || null);
                                setOpName(o.name);
                              }}
                              className={`flex min-w-0 flex-1 items-center gap-2 text-left text-sm ${
                                active ? 'text-fg' : 'text-muted group-hover:text-fg'
                              }`}
                            >
                              <span className={`w-14 shrink-0 font-mono text-[10px] font-bold ${METHOD_COLOR[m] || 'text-muted'}`}>
                                {m}
                              </span>
                              <span className="truncate font-mono text-xs">{o.name.replace(/^[A-Z]+ /, '')}</span>
                            </button>
                            <button
                              onClick={() => store.togglePin(s.name, o.name)}
                              aria-label={pinned ? 'Unpin' : 'Pin'}
                              className={`shrink-0 transition ${
                                pinned ? 'text-warning' : 'text-muted opacity-0 group-hover:opacity-100 hover:text-fg'
                              }`}
                            >
                              <IconStar width={14} height={14} fill={pinned ? 'currentColor' : 'none'} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {filtered.length === 0 ? <p className="px-1 text-sm text-muted">No matches.</p> : null}
              </div>
            </>
          ) : null}

          {panel === 'history' ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between px-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">Recent</span>
                {store.history.length ? (
                  <button onClick={store.clearHistory} className="text-xs text-muted hover:text-danger">
                    Clear
                  </button>
                ) : null}
              </div>
              {store.history.length === 0 ? (
                <p className="px-1 text-sm text-muted">No requests yet.</p>
              ) : (
                store.history.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => loadEntry(h)}
                    className="flex flex-col gap-0.5 rounded-md border border-[rgb(var(--border))] bg-surface-2 px-2.5 py-2 text-left transition hover:border-border-strong"
                  >
                    <span className="flex items-center gap-2">
                      <StatusDot tone={h.status >= 200 && h.status < 300 ? 'green' : h.status === 0 ? 'yellow' : 'red'} />
                      <span className="truncate font-mono text-xs text-fg">{h.opName}</span>
                    </span>
                    <span className="truncate text-[11px] text-muted">
                      {h.service} · {h.timeMs}ms
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}

          {panel === 'saved' ? (
            <div className="flex flex-col gap-1.5">
              <span className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Saved requests</span>
              {store.saved.length === 0 ? (
                <p className="px-1 text-sm text-muted">Save a request from the editor to reuse it later.</p>
              ) : (
                store.saved.map((s) => (
                  <div
                    key={s.id}
                    className="group flex items-center gap-2 rounded-md border border-[rgb(var(--border))] bg-surface-2 px-2.5 py-2 transition hover:border-border-strong"
                  >
                    <button onClick={() => loadEntry(s)} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                      <span className="truncate text-xs font-medium text-fg">{s.label}</span>
                      <span className="truncate text-[11px] text-muted">
                        {s.service} · {s.opName}
                      </span>
                    </button>
                    <button
                      onClick={() => store.removeSaved(s.id)}
                      aria-label="Delete"
                      className="shrink-0 text-muted opacity-0 transition group-hover:opacity-100 hover:text-danger"
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </Card>

        {/* Right: editor + response — only on the APIs tab. History/Saved are
            just lists; picking one loads it here and switches back to APIs. */}
        {panel !== 'apis' ? (
          <Card className="flex min-h-[200px] items-center justify-center">
            <p className="text-sm text-muted">
              Select a {panel === 'history' ? 'recent' : 'saved'} request to load it into the editor.
            </p>
          </Card>
        ) : selected ? (
          <div className="flex flex-col gap-4">
            <Card className="p-0">
              <div className="flex items-center justify-between gap-3 border-b border-[rgb(var(--border))] px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`font-mono text-xs font-bold ${METHOD_COLOR[gql ? 'QUERY' : restMethod] || 'text-muted'}`}>
                    {gql ? 'POST' : restMethod}
                  </span>
                  <span className="truncate font-mono text-sm text-fg">
                    {gql ? `/graphql/${selected.name}` : restPath}
                  </span>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="secondary" onClick={saveCurrent}>
                    Save
                  </Button>
                  <Button onClick={run} disabled={running}>
                    {running ? 'Running…' : '▸ Execute'}
                  </Button>
                </div>
              </div>

              <div className="p-4">
                {gql ? (
                  <textarea
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    rows={8}
                    spellCheck={false}
                    className="w-full resize-y rounded-md border border-[rgb(var(--border))] bg-code-bg p-3 font-mono text-xs leading-relaxed text-fg outline-none focus:border-ring"
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={restMethod}
                      onChange={(e) => setRestMethod(e.target.value)}
                      className="rounded-md border border-[rgb(var(--border))] bg-surface-2 px-2 py-2 font-mono text-xs text-fg outline-none focus:border-ring"
                    >
                      {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <input
                      value={restPath}
                      onChange={(e) => setRestPath(e.target.value)}
                      className="min-w-0 flex-1 rounded-md border border-[rgb(var(--border))] bg-surface-2 px-3 py-2 font-mono text-xs text-fg outline-none focus:border-ring"
                    />
                  </div>
                )}
              </div>
            </Card>

            {/* Response */}
            <Card className="p-0">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgb(var(--border))] px-4 py-2.5">
                <div className="flex items-center gap-4 text-xs">
                  {response ? (
                    <>
                      <span className="inline-flex items-center gap-1.5 font-semibold">
                        <StatusDot tone={response.status >= 200 && response.status < 300 ? 'green' : 'red'} />
                        <span className={response.status >= 200 && response.status < 300 ? 'text-success' : 'text-danger'}>
                          {response.status} {response.status >= 200 && response.status < 300 ? 'OK' : ''}
                        </span>
                      </span>
                      <span className="text-muted">
                        TIME <span className="font-mono text-fg">{response.timeMs}ms</span>
                      </span>
                      <span className="text-muted">
                        SIZE <span className="font-mono text-fg">{(response.sizeBytes / 1024).toFixed(1)}KB</span>
                      </span>
                    </>
                  ) : (
                    <span className="text-muted">Response</span>
                  )}
                </div>
                <div className="flex gap-1">
                  {(['pretty', 'raw'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition ${
                        tab === t ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <pre className="max-h-[52vh] overflow-auto bg-code-bg p-4 font-mono text-xs leading-relaxed text-fg">
                {response ? (tab === 'pretty' ? bodyStr : JSON.stringify(response.body)) : '// Execute a request to see the response'}
              </pre>
            </Card>

            {/* Edge cases, scenarios & transport faults for the selected operation */}
            <Card className="p-0">
              <button
                onClick={() => setShowLab((v) => !v)}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <div>
                  <span className="text-sm font-semibold text-fg">Edge cases &amp; scenarios</span>
                  <span className="ml-2 text-xs text-muted">
                    Suggest schema-driven edge cases, inject broken data, or degrade the transport.
                  </span>
                </div>
                <span className="text-muted">{showLab ? '▴' : '▾'}</span>
              </button>

              {showLab ? (
                <div className="flex flex-col gap-5 border-t border-[rgb(var(--border))] p-4">
                  {labMsg ? (
                    <div className="flex items-center gap-2 text-sm">
                      {labMsg.tone === 'default' ? (
                        <Spinner />
                      ) : (
                        <StatusDot tone={labMsg.tone === 'green' ? 'green' : 'red'} />
                      )}
                      <span
                        className={
                          labMsg.tone === 'green' ? 'text-success' : labMsg.tone === 'red' ? 'text-danger' : 'text-muted'
                        }
                      >
                        {labMsg.text}
                      </span>
                    </div>
                  ) : null}

                  {/* AI-suggested edge cases from the schema */}
                  <div>
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                      Suggested edge cases
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <input
                        value={edgePrompt}
                        onChange={(e) => setEdgePrompt(e.target.value)}
                        placeholder="Optional: describe what to stress (e.g. 'invalid dates and huge numbers')"
                        className="min-w-0 flex-1 rounded-md border border-[rgb(var(--border))] bg-surface-2 px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus:border-ring"
                      />
                      <Button variant="secondary" onClick={suggestEdgeCases} disabled={suggesting || !currentOp}>
                        {suggesting ? 'Analyzing…' : 'Suggest'}
                      </Button>
                    </div>
                    {edgeCases.length > 0 ? (
                      <div className="mt-3 flex flex-col gap-2">
                        {edgeCases.map((ec, i) => (
                          <div
                            key={ec.id || i}
                            className="flex items-start justify-between gap-3 rounded-md border border-[rgb(var(--border))] bg-surface-2 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-fg">{ec.name || `Edge case ${i + 1}`}</span>
                                {ec.severity ? (
                                  <Badge tone={ec.severity === 'high' ? 'red' : ec.severity === 'medium' ? 'yellow' : 'default'}>
                                    {ec.severity}
                                  </Badge>
                                ) : null}
                              </div>
                              {ec.description ? <div className="text-xs text-muted">{ec.description}</div> : null}
                            </div>
                            <Button
                              variant="ghost"
                              onClick={() => injectAndRun({ prompt: ec.prompt || ec.description, label: ec.name })}
                              disabled={injecting}
                            >
                              Inject &amp; run
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {/* Scenario library (deterministic) */}
                  <div className="flex flex-wrap items-end gap-3">
                    <Field label="Scenario">
                      <Select value={scenario} onChange={(e) => setScenario(e.target.value)} className="min-w-56">
                        {scenarios.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button onClick={() => injectAndRun({ scenario })} disabled={injecting || !currentOp}>
                      {injecting ? 'Working…' : 'Inject & run'}
                    </Button>
                    <Button variant="secondary" onClick={restoreData} disabled={injecting}>
                      Restore
                    </Button>
                  </div>

                  {/* Transport faults for the whole service */}
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                        Transport faults · {selected.displayName || selected.name}
                      </span>
                      {faults.length > 0 ? (
                        <button onClick={() => clearFault('')} className="text-xs text-muted hover:text-danger">
                          Clear all
                        </button>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-end gap-3">
                      <Field label="Latency (ms)">
                        <Input type="number" min={0} value={latencyMs} onChange={(e) => setLatencyMs(e.target.value)} className="w-24" />
                      </Field>
                      <Field label="Jitter (± ms)">
                        <Input type="number" min={0} value={jitterMs} onChange={(e) => setJitterMs(e.target.value)} className="w-24" />
                      </Field>
                      <Field label="Error rate (%)">
                        <Input type="number" min={0} max={100} value={errorPct} onChange={(e) => setErrorPct(e.target.value)} className="w-24" />
                      </Field>
                      <Field label="Error status">
                        <Input type="number" min={400} max={599} value={errorStatus} onChange={(e) => setErrorStatus(e.target.value)} className="w-24" />
                      </Field>
                      <Button onClick={applyFault} disabled={faultBusy || !selected}>
                        {faultBusy ? 'Applying…' : 'Apply fault'}
                      </Button>
                    </div>
                    {faults.length > 0 ? (
                      <div className="mt-3 flex flex-col gap-1.5">
                        {faults.map((f) => (
                          <div
                            key={f.service}
                            className="flex items-center justify-between rounded-md border border-[rgb(var(--border))] bg-surface-2 px-3 py-1.5 text-sm"
                          >
                            <span className="inline-flex items-center gap-2 font-medium text-fg">
                              <StatusDot tone="yellow" pulse />
                              {f.service}
                            </span>
                            <span className="flex items-center gap-3 font-mono text-xs text-muted">
                              <span>{f.latencyMs}±{f.jitterMs}ms</span>
                              <span>{Math.round(f.errorRate * 100)}% → {f.errorStatus}</span>
                              <button onClick={() => clearFault(f.service)} className="text-muted hover:text-danger">
                                Clear
                              </button>
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-muted">No transport faults active.</p>
                    )}
                  </div>
                </div>
              ) : null}
            </Card>
          </div>
        ) : (
          <Card>
            <p className="text-sm text-muted">No services loaded.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
