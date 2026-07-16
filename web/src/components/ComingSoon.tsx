import { Card, Badge } from './ui';

export function ComingSoon({
  title,
  description,
  phase,
}: {
  title: string;
  description: string;
  phase?: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-3">
        <h1 className="text-2xl font-bold text-fg">{title}</h1>
        <Badge tone="purple">{phase ?? 'Planned'}</Badge>
      </header>
      <Card ai className="max-w-2xl">
        <p className="text-sm text-muted">{description}</p>
      </Card>
    </div>
  );
}
