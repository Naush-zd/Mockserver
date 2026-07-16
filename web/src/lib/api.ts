import type {
  Health,
  ServicesDetailResponse,
  ScenarioInfo,
  MetricsSummary,
  RouteStat,
  DetectResult,
  SetupResult,
  ChaosFault,
  EdgeCaseScenario,
  AuthMe,
  HealthAi,
  Workspace,
} from './types';

// Everything is proxied through the Next.js rewrite to the Express backend, so
// the browser only ever talks same-origin.
const B = '/backend';

// ── Active workspace ─────────────────────────────────────────────────────────
// The backend scopes services + scenarios by the X-Workspace header. `null`
// means the default Global workspace (no header). We persist the choice so it
// survives reloads (switching workspaces triggers a reload so every page
// refetches scoped data).
const WS_KEY = 'active-workspace';
let activeWorkspace: string | null =
  typeof window !== 'undefined' ? window.localStorage.getItem(WS_KEY) || null : null;

export function getActiveWorkspace(): string | null {
  return activeWorkspace;
}

export function setActiveWorkspace(id: string | null) {
  activeWorkspace = id || null;
  if (typeof window !== 'undefined') {
    if (activeWorkspace) window.localStorage.setItem(WS_KEY, activeWorkspace);
    else window.localStorage.removeItem(WS_KEY);
  }
}

function wsHeaders(base?: HeadersInit): HeadersInit {
  const h = new Headers(base);
  if (activeWorkspace) h.set('x-workspace', activeWorkspace);
  return h;
}

function bfetch(path: string, init: RequestInit = {}) {
  return fetch(`${B}${path}`, { ...init, headers: wsHeaders(init.headers) });
}

async function asJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body as T;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

const KNOWN_SCENARIOS: ScenarioInfo[] = [
  { id: 'wrong-types', name: 'Wrong Types' },
  { id: 'missing-fields', name: 'Missing Fields' },
  { id: 'null-values', name: 'Null Values' },
  { id: 'empty-arrays', name: 'Empty Arrays' },
  { id: 'malformed-dates', name: 'Malformed Dates' },
  { id: 'deprecated-fields', name: 'Deprecated Fields' },
  { id: 'extra-fields', name: 'Extra Fields' },
  { id: 'encoding-issues', name: 'Encoding Issues' },
  { id: 'boundary-values', name: 'Boundary Values' },
  { id: 'partial-response', name: 'Partial Response' },
];

export const api = {
  health: () => bfetch('/health').then((r) => asJson<Health>(r)),

  healthAi: () => bfetch('/health/ai').then((r) => asJson<HealthAi>(r)),

  authMe: async (): Promise<AuthMe> => {
    try {
      const r = await bfetch('/auth/me');
      const body = (await r.json()) as AuthMe;
      // 401 (auth on, not logged in) still carries { authEnabled, user:null }.
      return body ?? { authEnabled: false };
    } catch {
      return { authEnabled: false };
    }
  },

  // ── Workspaces ─────────────────────────────────────────────────────────────
  listWorkspaces: () => bfetch('/workspaces').then((r) => asJson<{ workspaces: Workspace[] }>(r)),

  createWorkspace: (body: { name: string; description?: string; isolated?: boolean }) =>
    bfetch('/workspaces', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }).then((r) =>
      asJson<Workspace>(r)
    ),

  deleteWorkspace: (id: string, deleteServices = false) =>
    bfetch(`/workspaces/${encodeURIComponent(id)}${deleteServices ? '?deleteServices=true' : ''}`, {
      method: 'DELETE',
    }).then((r) => asJson<{ deleted: boolean }>(r)),

  servicesDetail: () =>
    bfetch('/', { headers: { accept: 'application/json' } }).then((r) => asJson<ServicesDetailResponse>(r)),

  metricsSummary: () => bfetch('/metrics/summary').then((r) => asJson<MetricsSummary>(r)),

  metricsRoutes: () => bfetch('/metrics/routes').then((r) => asJson<{ routes: RouteStat[] }>(r)),

  detectSchema: (schema: string) =>
    bfetch('/ai/detect', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ schema }) }).then((r) =>
      asJson<DetectResult>(r)
    ),

  aiSetup: (body: { schema: string; prompt: string; serviceName?: string }) =>
    bfetch('/ai/setup', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }).then((r) =>
      asJson<SetupResult>(r)
    ),

  suggestScenarios: (body: { service: string; operation: string; apiType: string; prompt?: string }) =>
    bfetch('/ai/suggest-scenarios', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }).then((r) =>
      asJson<{ scenarios: EdgeCaseScenario[]; fallback?: boolean }>(r)
    ),

  chaosFaults: () => bfetch('/chaos/faults').then((r) => asJson<{ faults: ChaosFault[] }>(r)),

  setChaosFault: (body: {
    service: string;
    latencyMs?: number;
    jitterMs?: number;
    errorRate?: number;
    errorStatus?: number;
    enabled?: boolean;
  }) =>
    bfetch('/chaos/faults', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }).then((r) =>
      asJson<{ fault: ChaosFault }>(r)
    ),

  clearChaosFault: (service?: string) =>
    bfetch('/chaos/faults', {
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: JSON.stringify(service ? { service } : {}),
    }).then((r) => asJson<{ cleared: number | boolean }>(r)),

  async scenarios(): Promise<ScenarioInfo[]> {
    const normalize = (d: unknown): ScenarioInfo | null => {
      if (typeof d === 'string') return { id: d, name: d };
      if (d && typeof d === 'object') {
        const o = d as Partial<ScenarioInfo>;
        if (o.id) return { id: o.id, name: o.name ?? o.id, description: o.description };
      }
      return null;
    };
    const dedupe = (list: ScenarioInfo[]): ScenarioInfo[] => {
      const seen = new Set<string>();
      return list.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
    };
    try {
      const res = await bfetch('/ai/scenarios');
      const data = await res.json();
      // Accept either a raw array or { scenarios: [...] }, of strings or objects.
      const arr: unknown[] = Array.isArray(data)
        ? data
        : data && typeof data === 'object' && Array.isArray((data as { scenarios?: unknown[] }).scenarios)
        ? (data as { scenarios: unknown[] }).scenarios
        : data && typeof data === 'object'
        ? Object.keys(data as Record<string, unknown>)
        : [];
      const mapped = dedupe(arr.map(normalize).filter((s): s is ScenarioInfo => s !== null));
      if (mapped.length) return mapped;
    } catch {
      /* fall through to known list */
    }
    return KNOWN_SCENARIOS;
  },

  injectScenario: (body: {
    service: string;
    operation: string;
    scenario?: string;
    prompt?: string;
    apiType: string;
    fields?: string[];
    method?: string;
    path?: string;
  }) =>
    bfetch('/ai/scenario', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }).then((r) =>
      asJson<Record<string, unknown>>(r)
    ),

  restore: (service: string) =>
    bfetch('/ai/restore', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ service }) }).then((r) =>
      asJson<Record<string, unknown>>(r)
    ),

  queryFields: (operation: string, service: string) =>
    bfetch(`/schema/query-fields?operation=${encodeURIComponent(operation)}&service=${encodeURIComponent(service)}`)
      .then((r) => asJson<{ fields: string | null; returnType: string | null; method: string | null }>(r))
      .catch(() => ({ fields: null, returnType: null, method: null })),

  async runGraphql(
    service: string,
    query: string,
    variables?: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    const res = await bfetch(`/graphql/${encodeURIComponent(service)}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  },

  async runRest(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: unknown }> {
    const opts: RequestInit = { method };
    if (body !== undefined && body !== null && method !== 'GET') {
      opts.headers = JSON_HEADERS;
      opts.body = JSON.stringify(body);
    }
    const res = await bfetch(path, opts);
    let out: unknown = null;
    const text = await res.text();
    try {
      out = text ? JSON.parse(text) : null;
    } catch {
      out = text;
    }
    return { status: res.status, body: out };
  },
};
