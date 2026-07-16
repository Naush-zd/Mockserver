'use client';

import * as React from 'react';

type Theme = 'dark' | 'light';

function getInitial(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return (document.documentElement.getAttribute('data-theme') as Theme) || 'dark';
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = React.useState<Theme>('dark');

  React.useEffect(() => {
    setTheme(getInitial());
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* ignore */
    }
  };

  const icon = theme === 'dark' ? '☀' : '☾';
  const label = theme === 'dark' ? 'Light mode' : 'Dark mode';

  if (compact) {
    return (
      <button
        onClick={toggle}
        aria-label={label}
        title={label}
        className="grid h-9 w-9 place-items-center rounded-md border border-[rgb(var(--border))] text-muted transition hover:border-border-strong hover:text-fg"
      >
        <span className="text-base leading-none">{icon}</span>
      </button>
    );
  }

  return (
    <button
      onClick={toggle}
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs text-muted transition hover:bg-surface-2 hover:text-fg"
    >
      <span className="w-4 text-center text-base leading-none">{icon}</span>
      {label}
    </button>
  );
}
