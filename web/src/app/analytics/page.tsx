'use client';

import * as React from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { MetricsSummary } from '@/lib/types';
import { Card, Spinner, SectionTitle, StatusDot } from '@/components/ui';

const PROTO_COLOR: Record<string, string> = {
  REST: 'bg-success',
  GRAPHQL: 'bg-ring',
  EVENT: 'bg-warning',
  ASYNC: 'bg-warning',
};

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export default function AnalyticsPage() {
  const [data, setData] = React.useState<MetricsSummary | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    try {
      const d = await api.metricsSummary();
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load metrics');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) return <Spinner label="Loading analytics…" />;
  if (error) {
    return (
      <Card className="border-danger/40">
        <p className="text-sm text-danger">{error}</p>
      </Card>
    );
  }
  if (!data) return null;

  const total = data.windowRequests;
  const protoEntries = Object.entries(data.byProtocol).sort((a, b) => b[1] - a[1]);
  const maxLatency = Math.max(1, ...data.series.map((s) => s.latencyMs));

  const tiles = [
    { label: 'Requests (window)', value: total, hint: `${data.totalRequests} total since start` },
    { label: 'Avg Latency', value: `${data.avgLatencyMs}ms` },
    { label: 'Error Rate', value: `${(data.errorRate * 100).toFixed(1)}%` },
    { label: 'Routes Tracked', value: data.routes },
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-fg">Analytics</h1>
          <p className="mt-1 text-sm text-muted">
            Live traffic across the mock (GraphQL + REST). Auto-refreshes every 5s.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <StatusDot tone="green" pulse /> Live
        </span>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="flex flex-col gap-1 p-4">
            <span className="text-[11px] uppercase tracking-wide text-muted">{t.label}</span>
            <span className="text-2xl font-bold text-fg">{t.value}</span>
            {t.hint ? <span className="text-xs text-muted">{t.hint}</span> : null}
          </Card>
        ))}
      </section>

      {total === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-muted">
            No traffic recorded yet. Run some operations in the{' '}
            <Link href="/services" className="text-primary hover:underline">
              API Explorer
            </Link>
            , then come back.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.4fr]">
          {/* Traffic mix */}
          <div>
            <SectionTitle>Traffic Mix</SectionTitle>
            <Card className="flex flex-col gap-4">
              {protoEntries.map(([proto, count]) => {
                const pct = total ? Math.round((count / total) * 100) : 0;
                return (
                  <div key={proto}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium text-fg">{proto}</span>
                      <span className="text-muted">
                        {count} · {pct}%
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                      <div className={`h-full rounded-full ${PROTO_COLOR[proto] || 'bg-primary'}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </Card>
          </div>

          {/* Latency chart */}
          <div>
            <SectionTitle hint="Most recent requests (latency, ms).">Response Latency</SectionTitle>
            <Card>
              <div className="flex h-40 items-end gap-1">
                {data.series.map((s, i) => {
                  const h = Math.max(3, Math.round((s.latencyMs / maxLatency) * 100));
                  const err = s.status >= 400;
                  return (
                    <div
                      key={i}
                      title={`${s.protocol} · ${s.latencyMs}ms · ${s.status}`}
                      className={`flex-1 rounded-t ${err ? 'bg-danger/70' : 'bg-primary/60'} transition-all`}
                      style={{ height: `${h}%` }}
                    />
                  );
                })}
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-muted">
                <span>oldest</span>
                <span>peak {maxLatency.toFixed(0)}ms</span>
                <span>latest</span>
              </div>
            </Card>
          </div>
        </div>
      )}

      {total > 0 ? (
        <div>
          <SectionTitle>Recent Requests</SectionTitle>
          <Card className="overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[rgb(var(--border))] text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-2 font-medium">Method</th>
                  <th className="px-4 py-2 font-medium">Path</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Latency</th>
                  <th className="px-4 py-2 text-right font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {data.recentRequests.map((r, i) => (
                  <tr key={i} className="border-b border-[rgb(var(--border))] last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-2 font-mono text-xs font-bold text-muted">{r.method}</td>
                    <td className="px-4 py-2 font-mono text-xs text-fg">{r.path}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${r.status >= 400 ? 'text-danger' : 'text-success'}`}>
                        <StatusDot tone={r.status >= 400 ? 'red' : 'green'} /> {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-fg">{r.latencyMs}ms</td>
                    <td className="px-4 py-2 text-right text-xs text-muted">{timeAgo(r.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
