'use client';

import * as React from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { ServiceDetail, Operation, RouteStat } from '@/lib/types';
import { Card, Spinner, Badge, StatusDot, Input } from '@/components/ui';

const isGraphql = (t: string) => t === 'GRAPHQL' || t === 'GRAPH';

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-success',
  POST: 'text-ring',
  PUT: 'text-warning',
  PATCH: 'text-warning',
  DELETE: 'text-danger',
  QUERY: 'text-ring',
  MUTATION: 'text-warning',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeSeg(seg: string): string {
  if (/^\d+$/.test(seg)) return '{id}';
  if (UUID_RE.test(seg)) return '{id}';
  if (seg.length >= 20 && /[0-9]/.test(seg) && /[a-z]/i.test(seg)) return '{id}';
  return seg;
}
function normalizePath(p: string): string {
  return '/' + p.split('/').filter(Boolean).map(normalizeSeg).join('/');
}

type Row = {
  key: string;
  protocol: string;
  service: string;
  method: string;
  path: string;
  stat?: RouteStat;
};

function methodOf(op: Operation): string {
  const first = op.name.split(' ')[0];
  return first && /^[A-Z]+$/.test(first) ? first : op.method || 'GET';
}

function buildRows(services: ServiceDetail[], stats: RouteStat[]): Row[] {
  const index = new Map<string, RouteStat>();
  for (const s of stats) index.set(`${s.method} ${s.path}`, s);
  // GraphQL endpoints are shared per service; index by service too.
  const gqlByService = new Map<string, RouteStat>();
  for (const s of stats) if (s.protocol === 'GRAPHQL') gqlByService.set(s.service, s);

  const rows: Row[] = [];
  for (const svc of services) {
    for (const op of svc.operations || []) {
      if (isGraphql(svc.type)) {
        const path = `/graphql/${svc.name}`;
        rows.push({
          key: `${svc.name}:${op.name}`,
          protocol: 'GRAPHQL',
          service: svc.name,
          method: methodOf(op),
          path: `${path}  ·  ${op.name}`,
          stat: gqlByService.get(svc.name),
        });
      } else {
        const method = methodOf(op);
        const parts = op.name.split(' ');
        let sub = parts.length > 1 ? parts.slice(1).join(' ') : op.resourcePaths?.[0] || '/';
        if (!sub.startsWith('/')) sub = '/' + sub;
        const full = normalizePath(`/rest/${svc.name}/${svc.version || '1.0'}${sub}`);
        rows.push({
          key: `${svc.name}:${op.name}`,
          protocol: 'REST',
          service: svc.name,
          method,
          path: full,
          stat: index.get(`${method} ${full}`),
        });
      }
    }
  }
  return rows;
}

export default function RoutesPage() {
  const [services, setServices] = React.useState<ServiceDetail[]>([]);
  const [stats, setStats] = React.useState<RouteStat[]>([]);
  const [filter, setFilter] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    try {
      const [d, r] = await Promise.all([api.servicesDetail(), api.metricsRoutes()]);
      setServices(d.services);
      setStats(r.routes);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load routes');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) return <Spinner label="Loading routes…" />;
  if (error) {
    return (
      <Card className="border-danger/40">
        <p className="text-sm text-danger">{error}</p>
      </Card>
    );
  }

  const rows = buildRows(services, stats);
  const q = filter.trim().toLowerCase();
  const shown = rows.filter(
    (r) => !q || r.path.toLowerCase().includes(q) || r.service.toLowerCase().includes(q) || r.method.toLowerCase().includes(q)
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-fg">API Routes</h1>
          <p className="mt-1 text-sm text-muted">
            Every mockable operation in the catalog, enriched with live request metrics. Auto-refreshes every 5s.
          </p>
        </div>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter routes…"
          className="w-64"
        />
      </header>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[rgb(var(--border))] text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-2.5 font-medium">Method</th>
              <th className="px-4 py-2.5 font-medium">Route</th>
              <th className="px-4 py-2.5 font-medium">Type</th>
              <th className="px-4 py-2.5 text-right font-medium">Hits</th>
              <th className="px-4 py-2.5 text-right font-medium">Avg Latency</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key} className="border-b border-[rgb(var(--border))] last:border-0 hover:bg-surface-2">
                <td className="px-4 py-2.5">
                  <span className={`font-mono text-xs font-bold ${METHOD_COLOR[r.method] || 'text-muted'}`}>{r.method}</span>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-fg">{r.path}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={r.protocol === 'GRAPHQL' ? 'blue' : 'green'}>{r.protocol}</Badge>
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-xs text-fg">{r.stat ? r.stat.count : '—'}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs text-fg">
                  {r.stat ? `${r.stat.avgLatencyMs}ms` : '—'}
                </td>
                <td className="px-4 py-2.5">
                  {r.stat ? (
                    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${r.stat.lastStatus >= 400 ? 'text-danger' : 'text-success'}`}>
                      <StatusDot tone={r.stat.lastStatus >= 400 ? 'red' : 'green'} /> {r.stat.lastStatus}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                      <StatusDot tone="yellow" /> idle
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted">
                  No routes match “{filter}”.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>

      <p className="text-xs text-muted">
        Tip: run operations in the{' '}
        <Link href="/services" className="text-primary hover:underline">
          API Explorer
        </Link>{' '}
        to populate hits &amp; latency. GraphQL rows share one endpoint, so their metrics are endpoint-level.
      </p>
    </div>
  );
}
