'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './ThemeToggle';
import { api, getActiveWorkspace, setActiveWorkspace } from '@/lib/api';
import type { Health, Workspace } from '@/lib/types';
import {
  IconOverview,
  IconExplorer,
  IconAI,
  IconRoutes,
  IconAnalytics,
  IconSettings,
  IconDocs,
  IconSupport,
  IconPlus,
} from './icons';

type NavItem = { href: string; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>> };

const PRIMARY: NavItem[] = [
  { href: '/', label: 'Overview', icon: IconOverview },
  { href: '/services', label: 'API Explorer', icon: IconExplorer },
  { href: '/ai-studio', label: 'AI Studio', icon: IconAI },
  { href: '/routes', label: 'API Routes', icon: IconRoutes },
];

const ANALYSIS: NavItem[] = [
  { href: '/analytics', label: 'Analytics', icon: IconAnalytics },
  { href: '/settings', label: 'Settings', icon: IconSettings },
];

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'GL';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  const [health, setHealth] = React.useState<Health | null>(null);
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([]);
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  // Read the persisted workspace only after mount. Reading localStorage during
  // render makes the client's first paint differ from the server (which always
  // sees "Global"), triggering a React hydration mismatch.
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setActiveId(getActiveWorkspace());
    api.health().then(setHealth).catch(() => setHealth(null));
    api.listWorkspaces().then((r) => setWorkspaces(r.workspaces || [])).catch(() => setWorkspaces([]));
  }, []);

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const active = workspaces.find((w) => w.id === activeId) || null;
  const activeName = activeId ? active?.name || activeId : 'Global';

  const switchTo = (id: string | null) => {
    setActiveWorkspace(id);
    window.location.reload();
  };

  const submitCreate = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setErr(null);
    try {
      const ws = await api.createWorkspace({ name });
      switchTo(ws.id);
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Failed to create workspace');
      setBusy(false);
    }
  };

  const confirmDelete = async (id: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api.deleteWorkspace(id, false);
      if (activeId === id) {
        switchTo(null);
      } else {
        setWorkspaces((ws) => ws.filter((w) => w.id !== id));
        setConfirmId(null);
        setBusy(false);
      }
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Failed to delete workspace');
      setBusy(false);
    }
  };

  const renderItem = (item: NavItem) => {
    const on = isActive(item.href);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        className={`group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition ${
          on ? 'bg-primary/10 font-semibold text-primary' : 'text-muted hover:bg-surface-2 hover:text-fg'
        }`}
      >
        <Icon className={on ? 'text-primary' : 'text-muted group-hover:text-fg'} />
        {item.label}
      </Link>
    );
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-[rgb(var(--border))] bg-surface">
      <div className="flex items-center gap-2 border-b border-[rgb(var(--border))] px-5 py-4">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-ai-gradient text-sm font-bold text-white">U</div>
        <div className="leading-tight">
          <div className="text-sm font-bold text-fg">Unified Mock Server</div>
          <div className="text-[11px] text-muted">API Virtualization Studio</div>
        </div>
      </div>

      {/* Workspace switcher */}
      <div className="relative px-3 pt-3" ref={boxRef}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-3 rounded-md border border-[rgb(var(--border))] bg-surface-2 px-3 py-2 text-left transition hover:border-border-strong"
        >
          <div className="grid h-8 w-8 place-items-center rounded-md bg-primary/15 text-xs font-bold text-primary">
            {initials(activeName)}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-semibold text-fg">{activeName}</div>
            <div className="truncate text-[11px] text-muted">
              {activeId ? 'Isolated workspace' : 'Default workspace'}
            </div>
          </div>
          <span className="text-muted">⌄</span>
        </button>

        {open ? (
          <div className="absolute left-3 right-3 z-30 mt-1 overflow-hidden rounded-md border border-[rgb(var(--border))] bg-surface shadow-ambient">
            <button
              onClick={() => switchTo(null)}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition hover:bg-surface-2 ${
                !activeId ? 'text-primary' : 'text-fg'
              }`}
            >
              Global
              {!activeId ? <span className="text-xs">✓</span> : null}
            </button>
            {workspaces
              .filter((w) => w.id !== 'global')
              .map((w) => (
                <div key={w.id} className="group flex items-center hover:bg-surface-2">
                  <button
                    onClick={() => switchTo(w.id)}
                    className={`flex min-w-0 flex-1 items-center justify-between px-3 py-2 text-left text-sm ${
                      activeId === w.id ? 'text-primary' : 'text-fg'
                    }`}
                  >
                    <span className="truncate">{w.name}</span>
                    {activeId === w.id ? <span className="text-xs">✓</span> : null}
                  </button>
                  {confirmId === w.id ? (
                    <span className="flex items-center gap-2 pr-2 text-xs">
                      <span className="text-muted">Delete?</span>
                      <button
                        onClick={() => confirmDelete(w.id)}
                        disabled={busy}
                        aria-label="Confirm delete"
                        title="Delete — its mocks move back to Global"
                        className="font-medium text-danger hover:opacity-80 disabled:opacity-50"
                      >
                        Yes
                      </button>
                      <button
                        onClick={() => setConfirmId(null)}
                        aria-label="Cancel delete"
                        className="text-muted hover:text-fg"
                      >
                        No
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => {
                        setConfirmId(w.id);
                        setErr(null);
                      }}
                      aria-label="Delete workspace"
                      className="px-2 text-muted opacity-0 transition group-hover:opacity-100 hover:text-danger"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}

            {creating ? (
              <form onSubmit={submitCreate} className="border-t border-[rgb(var(--border))] p-2">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setCreating(false);
                      setNewName('');
                      setErr(null);
                    }
                  }}
                  placeholder="Workspace name"
                  className="w-full rounded border border-[rgb(var(--border))] bg-surface-2 px-2 py-1.5 text-sm text-fg outline-none focus:border-primary"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="submit"
                    disabled={busy || !newName.trim()}
                    className="rounded bg-primary px-2.5 py-1 text-xs font-medium text-white transition disabled:opacity-50"
                  >
                    {busy ? 'Creating…' : 'Create'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setNewName('');
                      setErr(null);
                    }}
                    className="rounded px-2.5 py-1 text-xs text-muted transition hover:text-fg"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                onClick={() => {
                  setCreating(true);
                  setErr(null);
                }}
                className="flex w-full items-center gap-2 border-t border-[rgb(var(--border))] px-3 py-2 text-left text-sm font-medium text-primary transition hover:bg-surface-2"
              >
                <IconPlus width={14} height={14} /> New workspace
              </button>
            )}

            {err ? <div className="px-3 py-2 text-xs text-danger">{err}</div> : null}
          </div>
        ) : null}
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        {PRIMARY.map(renderItem)}
        <div className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted">Analysis</div>
        {ANALYSIS.map(renderItem)}
      </nav>

      <div className="border-t border-[rgb(var(--border))] p-3">
        <div className="mb-2 flex items-center gap-2 px-3 text-[11px] text-muted">
          <span className={`h-2 w-2 rounded-full ${health?.microcksReachable ? 'bg-success' : 'bg-danger'}`} />
          Microcks {health ? (health.microcksReachable ? 'connected' : 'unreachable') : '…'}
          {health ? ` · ${health.services.total}` : ''}
        </div>
        <Link
          href="/docs"
          className="flex items-center gap-3 rounded-md px-3 py-2 text-xs text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          <IconDocs width={16} height={16} /> Documentation
        </Link>
        <Link
          href="/support"
          className="flex items-center gap-3 rounded-md px-3 py-2 text-xs text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          <IconSupport width={16} height={16} /> Support
        </Link>
        <ThemeToggle />
      </div>
    </aside>
  );
}
