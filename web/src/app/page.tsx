'use client';

import * as React from 'react';
import Link from 'next/link';
import { api, getActiveWorkspace, onCatalogChanged } from '@/lib/api';
import type { Health, HealthAi, ServiceDetail, Workspace, ActivityEvent } from '@/lib/types';
import { Card, Badge, Spinner, SectionTitle, StatusDot } from '@/components/ui';
import { IconAI, IconExplorer, IconPlus } from '@/components/icons';

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

const ACTIVITY_TONE: Record<string, 'green' | 'blue' | 'red' | 'yellow' | 'purple' | 'default'> = {
  'scenario-injection': 'purple',
  chaos: 'yellow',
  restore: 'green',
  deploy: 'blue',
};

function typeTone(type: string): 'blue' | 'green' | 'yellow' | 'default' {
  const t = type.toUpperCase();
  if (t.startsWith('GRAPH')) return 'blue';
  if (t === 'REST') return 'green';
  if (t === 'EVENT' || t === 'ASYNC' || t === 'ASYNC_API') return 'yellow';
  return 'default';
}

export default function OverviewPage() {
  const [health, setHealth] = React.useState<Health | null>(null);
  const [ai, setAi] = React.useState<HealthAi | null>(null);
  const [services, setServices] = React.useState<ServiceDetail[]>([]);
  const [workspaceName, setWorkspaceName] = React.useState<string>(getActiveWorkspace() ? '…' : 'Global');
  const [activity, setActivity] = React.useState<ActivityEvent[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [h, a, d] = await Promise.all([api.health(), api.healthAi(), api.servicesDetail()]);
        if (!alive) return;
        setHealth(h);
        setAi(a);
        setServices(d.services);
        const activeId = getActiveWorkspace();
        if (activeId) {
          api
            .listWorkspaces()
            .then((r: { workspaces: Workspace[] }) => {
              if (alive) setWorkspaceName(r.workspaces.find((w) => w.id === activeId)?.name || activeId);
            })
            .catch(() => alive && setWorkspaceName(activeId));
        }
        api
          .metricsSummary()
          .then((m) => alive && setActivity(m.activity))
          .catch(() => {});
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    // Deploying/restoring a mock elsewhere (e.g. AI Studio) changes these
    // counts — refetch so the tiles below don't go stale.
    const unsubscribe = onCatalogChanged(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  if (loading) return <Spinner label="Loading platform status…" />;

  if (error) {
    return (
      <Card className="border-danger/40">
        <p className="text-sm text-danger">Could not reach the backend: {error}</p>
        <p className="mt-2 text-xs text-muted">
          Is the API running? Start it with <code className="font-mono">docker compose up -d</code> or set{' '}
          <code className="font-mono">BACKEND_URL</code>.
        </p>
      </Card>
    );
  }

  const online = !!health?.microcksReachable;
  const aiLLM = !!ai?.available;

  const tiles = [
    { label: 'Total Services', value: health?.services.total ?? 0 },
    { label: 'GraphQL', value: health?.services.graphql ?? 0 },
    { label: 'REST', value: health?.services.rest ?? 0 },
    { label: 'Async / Event', value: health?.services.event ?? 0 },
    { label: 'Operations', value: health?.totalOperations ?? 0 },
    { label: 'AI Engine', value: aiLLM ? 'LLM' : 'Deterministic' },
  ];

  return (
    <div className="flex flex-col gap-8">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Workspace</div>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight text-fg">{workspaceName}</h1>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                online ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'
              }`}
            >
              <StatusDot tone={online ? 'green' : 'red'} pulse={online} />
              {online ? 'Connected & Healthy' : 'Backend Unreachable'}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted">
            Microcks · <span className="font-mono">{health?.microcks}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/ai-studio"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-fg transition hover:bg-primary-hover"
          >
            <IconPlus width={16} height={16} /> Generate Mock
          </Link>
          <Link
            href="/services"
            className="inline-flex items-center gap-2 rounded-md border border-[rgb(var(--border))] bg-surface px-3.5 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2"
          >
            <IconExplorer width={16} height={16} /> API Explorer
          </Link>
        </div>
      </header>

      {/* Stat tiles */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <Card key={t.label} className="flex flex-col gap-1 p-4">
            <span className="text-[11px] uppercase tracking-wide text-muted">{t.label}</span>
            <span className="text-2xl font-bold text-fg">{t.value}</span>
          </Card>
        ))}
      </section>

      {/* Main grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        {/* Services inventory */}
        <section>
          <SectionTitle
            hint="Every service currently loaded into the local Microcks catalog for this workspace."
            action={
              <Link href="/services" className="text-sm font-medium text-primary hover:underline">
                Open Explorer →
              </Link>
            }
          >
            Services
          </SectionTitle>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {services.map((s) => (
              <Link key={s.name} href="/services">
                <Card className="flex h-full items-center justify-between transition hover:border-border-strong">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold text-fg">{s.displayName || s.name}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">{s.operations?.length ?? 0} operations</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone="green">
                      <StatusDot tone="green" /> Healthy
                    </Badge>
                    <Badge tone={typeTone(s.type)}>{s.type}</Badge>
                  </div>
                </Card>
              </Link>
            ))}
            <Link href="/ai-studio">
              <Card className="flex h-full min-h-[76px] items-center justify-center gap-2 border-dashed text-sm font-medium text-muted transition hover:border-border-strong hover:text-fg">
                <IconPlus width={16} height={16} /> New API
              </Card>
            </Link>
          </div>
          {services.length === 0 ? (
            <Card className="mt-3">
              <p className="text-sm text-muted">
                No services in this workspace yet. Drop specs into the backend&apos;s{' '}
                <code className="font-mono">artifacts/</code> folder or use AI Studio.
              </p>
            </Card>
          ) : null}

          <div className="mt-8">
            <SectionTitle
              hint="Deploy, scenario, and restore events recorded this session."
              action={
                <Link href="/analytics" className="text-sm font-medium text-primary hover:underline">
                  Analytics →
                </Link>
              }
            >
              Recent Activity
            </SectionTitle>
            {activity.length === 0 ? (
              <Card className="border-dashed">
                <p className="text-sm text-muted">
                  No activity yet. Generate a mock or inject a scenario and it&apos;ll show up here.
                </p>
              </Card>
            ) : (
              <Card className="flex flex-col divide-y divide-[rgb(var(--border))] p-0">
                {activity.map((a, i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-3">
                    <span className="mt-1">
                      <StatusDot tone="green" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-fg">{a.title}</span>
                        <Badge tone={ACTIVITY_TONE[a.type] ?? 'default'}>{a.type}</Badge>
                      </div>
                      <div className="mt-0.5 text-xs text-muted">
                        {a.detail ? `${a.detail} · ` : ''}
                        {a.actor ? `by ${a.actor} · ` : ''}
                        {timeAgo(a.ts)}
                      </div>
                    </div>
                  </div>
                ))}
              </Card>
            )}
          </div>
        </section>

        {/* Right rail */}
        <aside className="flex flex-col gap-6">
          <div>
            <SectionTitle>Platform Health</SectionTitle>
            <Card className="flex flex-col divide-y divide-[rgb(var(--border))] p-0">
              <HealthRow
                name="Microcks"
                detail={online ? 'Local engine reachable' : 'Not reachable'}
                tone={online ? 'green' : 'red'}
                status={online ? 'Active' : 'Down'}
                pulse={online}
              />
              <HealthRow
                name="AI Engine"
                detail={aiLLM ? 'LLM key configured' : 'Deterministic fallback'}
                tone={aiLLM ? 'green' : 'yellow'}
                status={aiLLM ? 'Active' : 'Fallback'}
              />
              <HealthRow name="Mock API" detail="Express proxy responding" tone="green" status="Active" pulse />
            </Card>
          </div>

          <div>
            <SectionTitle>Quick Start</SectionTitle>
            <Card ai className="flex flex-col gap-3">
              <p className="text-sm text-muted">Recommended next steps for this workspace:</p>
              <QuickLink href="/ai-studio" icon={IconAI} label="Generate a new mock from a spec" />
              <QuickLink href="/services" icon={IconExplorer} label="Explore APIs & inject edge cases" />
            </Card>
          </div>
        </aside>
      </div>
    </div>
  );
}

function HealthRow({
  name,
  detail,
  tone,
  status,
  pulse,
}: {
  name: string;
  detail: string;
  tone: 'green' | 'red' | 'yellow' | 'blue';
  status: string;
  pulse?: boolean;
}) {
  const chip =
    tone === 'green'
      ? 'text-success'
      : tone === 'red'
      ? 'text-danger'
      : tone === 'yellow'
      ? 'text-warning'
      : 'text-ring';
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div className="flex items-center gap-3">
        <StatusDot tone={tone} pulse={pulse} />
        <div className="leading-tight">
          <div className="text-sm font-medium text-fg">{name}</div>
          <div className="text-xs text-muted">{detail}</div>
        </div>
      </div>
      <span className={`text-xs font-semibold uppercase tracking-wide ${chip}`}>{status}</span>
    </div>
  );
}

function QuickLink({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-md border border-[rgb(var(--border))] bg-surface-2 px-3 py-2 text-sm text-fg transition hover:border-border-strong"
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
        <Icon width={15} height={15} />
      </span>
      {label}
    </Link>
  );
}
