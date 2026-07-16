'use client';

import * as React from 'react';
import { api } from '@/lib/api';
import type { Health, HealthAi, AuthMe } from '@/lib/types';
import { Card, SectionTitle, Badge, Spinner, StatusDot } from '@/components/ui';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[rgb(var(--border))] py-2.5 last:border-0">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-right text-sm text-fg">{children}</span>
    </div>
  );
}

export default function SettingsPage() {
  const [health, setHealth] = React.useState<Health | null>(null);
  const [ai, setAi] = React.useState<HealthAi | null>(null);
  const [me, setMe] = React.useState<AuthMe | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    (async () => {
      const [h, a, m] = await Promise.allSettled([api.health(), api.healthAi(), api.authMe()]);
      if (h.status === 'fulfilled') setHealth(h.value);
      if (a.status === 'fulfilled') setAi(a.value);
      if (m.status === 'fulfilled') setMe(m.value);
      setLoading(false);
    })();
  }, []);

  if (loading) return <Spinner label="Loading system status…" />;

  const uptime = health?.uptime
    ? `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m`
    : '—';

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold text-fg">Settings</h1>
        <p className="mt-1 text-sm text-muted">
          Live system configuration. These values come from server environment variables — set them in
          <code className="mx-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-fg">.env</code> or your deployment config.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <SectionTitle
            action={
              <Badge tone={health?.microcksReachable ? 'green' : 'red'}>
                {health?.microcksReachable ? 'Connected' : 'Unreachable'}
              </Badge>
            }
          >
            Microcks
          </SectionTitle>
          <Row label="Endpoint">
            <code className="font-mono text-xs">{health?.microcks || '—'}</code>
          </Row>
          <Row label="Services">{health?.services.total ?? '—'}</Row>
          <Row label="GraphQL / REST / Event">
            {health ? `${health.services.graphql} / ${health.services.rest} / ${health.services.event}` : '—'}
          </Row>
          <Row label="Total operations">{health?.totalOperations ?? '—'}</Row>
          <Row label="Server uptime">{uptime}</Row>
        </Card>

        <Card>
          <SectionTitle
            action={
              <Badge tone={ai?.available ? 'green' : 'yellow'}>{ai?.available ? 'Available' : 'Fallback'}</Badge>
            }
          >
            AI Provider
          </SectionTitle>
          <Row label="Provider">{ai?.provider || '—'}</Row>
          <Row label="Model">
            <code className="font-mono text-xs">{ai?.model || '—'}</code>
          </Row>
          <Row label="API key configured">
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone={ai?.configured ? 'green' : 'yellow'} />
              {ai?.configured ? 'Yes' : 'No (deterministic fallback)'}
            </span>
          </Row>
          <Row label="Mode">{ai?.message || '—'}</Row>
        </Card>

        <Card>
          <SectionTitle
            action={<Badge tone={me?.authEnabled ? 'green' : 'default'}>{me?.authEnabled ? 'Enabled' : 'Disabled'}</Badge>}
          >
            Authentication
          </SectionTitle>
          <Row label="Mode">{me?.authEnabled ? 'SAML / Okta SSO' : 'Disabled (local)'}</Row>
          <Row label="Current user">{me?.authEnabled ? me.user?.name || 'Signed out' : 'Local'}</Row>
          {me?.authEnabled && me.user?.email ? <Row label="Email">{me.user.email}</Row> : null}
          <Row label="Change">
            <span className="text-xs text-muted">Set AUTH_ENABLED + SAML_* env vars</span>
          </Row>
        </Card>

        <Card>
          <SectionTitle>Appearance</SectionTitle>
          <p className="text-sm text-muted">
            Use the theme toggle in the sidebar (or the top bar) to switch between dark and light. Your choice is saved
            in this browser.
          </p>
        </Card>
      </div>
    </div>
  );
}
