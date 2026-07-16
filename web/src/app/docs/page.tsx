import Link from 'next/link';
import { Card, SectionTitle, Badge } from '@/components/ui';

const STEPS = [
  {
    title: '1 · Create a mock',
    href: '/ai-studio',
    body: 'Open AI Studio, paste a GraphQL SDL, OpenAPI, AsyncAPI, or Protobuf spec. The server detects the format, generates realistic mock data (LLM when a key is set, deterministic faker otherwise), and imports it into Microcks.',
  },
  {
    title: '2 · Explore & call it',
    href: '/services',
    body: 'The API Explorer lists every service in Microcks. Pick an operation, run a request against the live mock, and pin/save the ones you use often.',
  },
  {
    title: '3 · Inject edge cases',
    href: '/services',
    body: 'In the API Explorer, run an operation then open "Edge cases & scenarios" to get schema-driven edge-case suggestions, inject broken data, and re-run — all inline with the request you just made.',
  },
  {
    title: '4 · Add transport faults',
    href: '/services',
    body: 'From the same panel, add latency, jitter, or a probabilistic error rate to a whole service to prove your clients survive degraded conditions.',
  },
];

const ENDPOINTS = [
  ['GET', '/health', 'System + Microcks status'],
  ['GET', '/services', 'Services visible in the workspace'],
  ['POST', '/ai/detect', 'Inspect a schema (type, validity, op count)'],
  ['POST', '/ai/setup', 'Generate mock data + deploy to Microcks'],
  ['POST', '/ai/scenario', 'Inject a scenario / edge case'],
  ['POST', '/ai/suggest-scenarios', 'Suggest edge cases for an operation'],
  ['POST', '/ai/scenario', 'Inject an edge case / scenario into a mock'],
  ['GET/POST/DELETE', '/chaos/faults', 'Manage transport faults'],
  ['GET/POST/DELETE', '/workspaces', 'Manage workspaces'],
  ['GET', '/auth/me', 'Current user / auth mode'],
];

export default function DocsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold text-fg">Documentation</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          A quick tour of the Unified Mock Server. Full details live in <code className="rounded bg-surface-2 px-1 py-0.5 font-mono">README.md</code> and{' '}
          <code className="rounded bg-surface-2 px-1 py-0.5 font-mono">deployment/MOCK-SERVER-DEPLOYMENT-GUIDE.md</code> in the repo.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {STEPS.map((s) => (
          <Link key={s.href} href={s.href}>
            <Card className="h-full transition hover:border-border-strong">
              <h3 className="mb-2 font-semibold text-fg">{s.title}</h3>
              <p className="text-sm text-muted">{s.body}</p>
            </Card>
          </Link>
        ))}
      </section>

      <Card>
        <SectionTitle hint="The frontend talks to these through the /backend proxy.">Backend API reference</SectionTitle>
        <div className="overflow-hidden rounded-md border border-[rgb(var(--border))]">
          {ENDPOINTS.map(([method, path, desc], i) => (
            <div
              key={path}
              className={`flex items-center gap-4 px-4 py-2.5 text-sm ${i % 2 ? 'bg-surface-2/40' : ''}`}
            >
              <Badge tone="blue">{method}</Badge>
              <code className="font-mono text-xs text-fg">{path}</code>
              <span className="ml-auto text-right text-muted">{desc}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
