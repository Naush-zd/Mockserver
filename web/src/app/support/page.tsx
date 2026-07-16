import Link from 'next/link';
import { Card, SectionTitle } from '@/components/ui';

export default function SupportPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold text-fg">Support</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Ways to get help with the Unified Mock Server.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <SectionTitle>Troubleshooting</SectionTitle>
          <ul className="flex flex-col gap-2 text-sm text-muted">
            <li>
              Check live status on the{' '}
              <Link href="/settings" className="text-primary hover:underline">
                Settings
              </Link>{' '}
              page — Microcks connectivity, AI provider, and auth mode.
            </li>
            <li>
              If services don&apos;t appear, confirm Microcks is running and reachable at the endpoint shown in the
              sidebar.
            </li>
            <li>
              If AI generation falls back to deterministic mode, set an AI API key in <code className="rounded bg-surface-2 px-1 py-0.5 font-mono">.env</code>.
            </li>
          </ul>
        </Card>

        <Card>
          <SectionTitle>Documentation</SectionTitle>
          <ul className="flex flex-col gap-2 text-sm text-muted">
            <li>
              In-app{' '}
              <Link href="/docs" className="text-primary hover:underline">
                quickstart & API reference
              </Link>
              .
            </li>
            <li>
              <code className="rounded bg-surface-2 px-1 py-0.5 font-mono">README.md</code> — architecture and local
              setup.
            </li>
            <li>
              <code className="rounded bg-surface-2 px-1 py-0.5 font-mono">deployment/MOCK-SERVER-DEPLOYMENT-GUIDE.md</code>{' '}
              — deployment.
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
