'use client';

import * as React from 'react';
import { IconBell } from './icons';
import { ThemeToggle } from './ThemeToggle';
import { api } from '@/lib/api';
import type { AuthMe, ActivityEvent } from '@/lib/types';

function initials(name: string) {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function Topbar() {
  const [me, setMe] = React.useState<AuthMe | null>(null);
  const [activity, setActivity] = React.useState<ActivityEvent[]>([]);
  const [bellOpen, setBellOpen] = React.useState(false);
  const bellRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    api.authMe().then(setMe).catch(() => setMe({ authEnabled: false }));
  }, []);

  const loadActivity = React.useCallback(() => {
    api
      .metricsSummary()
      .then((m) => setActivity(m.activity || []))
      .catch(() => setActivity([]));
  }, []);

  React.useEffect(() => {
    loadActivity();
    const id = setInterval(loadActivity, 15000);
    return () => clearInterval(id);
  }, [loadActivity]);

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const displayName = me?.authEnabled
    ? me.user?.name || 'Signed out'
    : 'Local';
  const sublabel = me?.authEnabled ? me.user?.email || 'SAML' : 'Auth disabled';

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b border-[rgb(var(--border))] bg-surface/80 px-6 backdrop-blur-md lg:px-10">
      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle compact />

        {/* Activity bell — real recent events from the metrics feed */}
        <div className="relative" ref={bellRef}>
          <button
            aria-label="Recent activity"
            onClick={() => {
              setBellOpen((v) => !v);
              if (!bellOpen) loadActivity();
            }}
            className="relative grid h-9 w-9 place-items-center rounded-md border border-[rgb(var(--border))] text-muted transition hover:border-border-strong hover:text-fg"
          >
            <IconBell width={16} height={16} />
            {activity.length > 0 ? (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary" />
            ) : null}
          </button>

          {bellOpen ? (
            <div className="absolute right-0 mt-2 w-80 overflow-hidden rounded-lg border border-[rgb(var(--border))] bg-surface shadow-ambient">
              <div className="border-b border-[rgb(var(--border))] px-4 py-2.5 text-sm font-semibold text-fg">
                Recent activity
              </div>
              <div className="max-h-96 overflow-y-auto">
                {activity.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted">
                    No activity yet. Generate a mock, run tests, or inject a scenario.
                  </p>
                ) : (
                  activity.map((e, i) => (
                    <div key={i} className="flex flex-col gap-0.5 border-b border-[rgb(var(--border))] px-4 py-2.5 last:border-0">
                      <span className="text-sm text-fg">{e.title}</span>
                      <span className="text-[11px] text-muted">
                        {e.detail ? `${e.detail} · ` : ''}
                        {timeAgo(e.ts)}
                        {e.actor && e.actor !== 'global' ? ` · ${e.actor}` : ''}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>

        {/* Identity — driven by /auth/me, never hardcoded */}
        <div className="flex items-center gap-2 rounded-md border border-[rgb(var(--border))] py-1 pl-1 pr-3">
          <div className="grid h-7 w-7 place-items-center rounded-full bg-ai-gradient text-[11px] font-bold text-white">
            {initials(displayName)}
          </div>
          <div className="hidden leading-tight sm:block">
            <div className="text-xs font-semibold text-fg">{displayName}</div>
            <div className="text-[10px] text-muted">{sublabel}</div>
          </div>
        </div>
      </div>
    </header>
  );
}
