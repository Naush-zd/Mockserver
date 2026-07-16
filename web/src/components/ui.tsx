import * as React from 'react';

export function Card({
  children,
  className = '',
  ai = false,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { ai?: boolean }) {
  return (
    <div
      className={`rounded-lg border border-[rgb(var(--border))] bg-surface p-5 ${
        ai ? 'ai-border' : ''
      } ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  hint,
  action,
}: {
  children: React.ReactNode;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold text-fg">{children}</h2>
        {hint ? <p className="mt-1 text-sm text-muted">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

type Tone = 'default' | 'green' | 'blue' | 'red' | 'yellow' | 'purple';

export function Badge({ children, tone = 'default' }: { children: React.ReactNode; tone?: Tone }) {
  const tones: Record<Tone, string> = {
    default: 'bg-surface-2 text-muted border-[rgb(var(--border))]',
    green: 'bg-success/10 text-success border-success/30',
    blue: 'bg-ring/10 text-ring border-ring/30',
    red: 'bg-danger/10 text-danger border-danger/30',
    yellow: 'bg-warning/10 text-warning border-warning/30',
    purple: 'bg-ai-from/10 text-ai-from border-ai-from/30',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusDot({ tone = 'green', pulse = false }: { tone?: 'green' | 'red' | 'yellow' | 'blue'; pulse?: boolean }) {
  const color =
    tone === 'green' ? 'bg-success' : tone === 'red' ? 'bg-danger' : tone === 'yellow' ? 'bg-warning' : 'bg-ring';
  return <span className={`inline-block h-2 w-2 rounded-full ${color} ${pulse ? 'pulse-dot' : ''}`} />;
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'blue' | 'danger' | 'ghost';
};

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const variants: Record<string, string> = {
    primary: 'bg-primary hover:bg-primary-hover text-primary-fg',
    blue: 'bg-primary hover:bg-primary-hover text-primary-fg',
    secondary: 'bg-surface-2 hover:bg-surface-3 text-fg border border-[rgb(var(--border))]',
    ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
    danger: 'bg-danger/90 hover:bg-danger text-white',
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}

export function Select({ className = '', ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`rounded-md border border-[rgb(var(--border))] bg-surface-2 px-3 py-2 text-sm text-fg outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30 ${className}`}
      {...props}
    />
  );
}

export function Input({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`rounded-md border border-[rgb(var(--border))] bg-surface-2 px-3 py-2 text-sm text-fg outline-none transition placeholder:text-muted focus:border-ring focus:ring-2 focus:ring-ring/30 ${className}`}
      {...props}
    />
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-[rgb(var(--border))] border-t-fg" />
      {label}
    </span>
  );
}

export function Stat({
  label,
  value,
  tone = 'default',
  hint,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'green' | 'red';
  hint?: string;
}) {
  const color = tone === 'green' ? 'text-success' : tone === 'red' ? 'text-danger' : 'text-fg';
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className={`text-2xl font-bold ${color}`}>{value}</span>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </Card>
  );
}
