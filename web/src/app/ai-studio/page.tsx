'use client';

import * as React from 'react';
import Link from 'next/link';
import { Card, SectionTitle, Badge, Button, Field, Input, StatusDot, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import type { DetectResult, SetupResult, SetupStep, EdgeCaseScenario } from '@/lib/types';

const STEPS = ['Schema', 'Describe', 'Preview', 'Deploy'] as const;

const TEMPLATES: { label: string; kind: string; prompt: string; schema: string }[] = [
  {
    label: 'GraphQL — Blog',
    kind: 'GraphQL SDL',
    prompt: 'Generate 3 realistic blog posts with authors and comments.',
    schema: `type Author {
  id: ID!
  name: String!
  email: String!
}

type Post {
  id: ID!
  title: String!
  body: String!
  author: Author!
  tags: [String!]!
}

type Query {
  posts: [Post!]!
  post(id: ID!): Post
}`,
  },
  {
    label: 'OpenAPI — Products',
    kind: 'OpenAPI JSON',
    prompt: 'Generate 5 realistic products across categories with prices in USD.',
    schema: `{
  "openapi": "3.0.0",
  "info": { "title": "ProductsAPI", "version": "1.0.0" },
  "paths": {
    "/products": {
      "get": {
        "operationId": "listProducts",
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": { "$ref": "#/components/schemas/Product" }
                }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "Product": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "name": { "type": "string" },
          "category": { "type": "string" },
          "price": { "type": "number" }
        }
      }
    }
  }
}`,
  },
];

function StepIndicator({ active }: { active: number }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((label, i) => {
        const state = i < active ? 'done' : i === active ? 'current' : 'todo';
        return (
          <React.Fragment key={label}>
            <div className="flex items-center gap-2">
              <span
                className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold transition ${
                  state === 'done'
                    ? 'bg-success text-white'
                    : state === 'current'
                    ? 'bg-primary text-primary-fg'
                    : 'bg-surface-2 text-muted'
                }`}
              >
                {state === 'done' ? '✓' : i + 1}
              </span>
              <span
                className={`text-sm font-medium ${
                  state === 'todo' ? 'text-muted' : 'text-fg'
                }`}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 ? (
              <span className={`h-px w-8 ${i < active ? 'bg-success' : 'bg-[rgb(var(--border))]'}`} />
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function stepTone(status: string): 'green' | 'red' | 'yellow' | 'blue' {
  if (status === 'done') return 'green';
  if (status === 'error') return 'red';
  if (status === 'warning') return 'yellow';
  return 'blue';
}

function StepLog({ steps }: { steps: SetupStep[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {steps.map((s, i) => (
        <div key={i} className="flex items-start gap-2 text-sm">
          <span className="mt-1.5">
            <StatusDot tone={stepTone(s.status)} pulse={s.status === 'running'} />
          </span>
          <span className={s.status === 'warning' || s.status === 'error' ? 'text-muted' : 'text-fg'}>
            {s.step}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function AIStudioPage() {
  const [schema, setSchema] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [serviceName, setServiceName] = React.useState('');

  const [detecting, setDetecting] = React.useState(false);
  const [detect, setDetect] = React.useState<DetectResult | null>(null);

  const [deploying, setDeploying] = React.useState(false);
  const [result, setResult] = React.useState<SetupResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Edge-case suggestions (post-deploy): analyze a deployed operation and
  // inject the chosen edge cases as callable mock variants.
  const [edgeOp, setEdgeOp] = React.useState('');
  const [suggestions, setSuggestions] = React.useState<EdgeCaseScenario[] | null>(null);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [suggestErr, setSuggestErr] = React.useState<string | null>(null);
  const [injectingId, setInjectingId] = React.useState<string | null>(null);
  const [injected, setInjected] = React.useState<Record<string, 'ok' | 'fail'>>({});

  const active = result ? 4 : deploying ? 3 : detect ? 2 : prompt.trim() ? 1 : 0;

  const applyTemplate = (t: (typeof TEMPLATES)[number]) => {
    setSchema(t.schema);
    setPrompt(t.prompt);
    setDetect(null);
    setResult(null);
    setError(null);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setSchema(text);
    setDetect(null);
    setResult(null);
    setError(null);
  };

  const handleDetect = async () => {
    if (!schema.trim()) return;
    setDetecting(true);
    setError(null);
    setResult(null);
    try {
      const d = await api.detectSchema(schema);
      setDetect(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Detection failed');
      setDetect(null);
    } finally {
      setDetecting(false);
    }
  };

  const handleDeploy = async () => {
    if (!schema.trim() || !prompt.trim()) return;
    setDeploying(true);
    setError(null);
    try {
      const r = await api.aiSetup({
        schema,
        prompt,
        serviceName: serviceName.trim() || undefined,
      });
      setResult(r);
      setEdgeOp(r.mockRoutes?.[0]?.operation || '');
      setSuggestions(null);
      setInjected({});
      setSuggestErr(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deployment failed');
    } finally {
      setDeploying(false);
    }
  };

  const reset = () => {
    setSchema('');
    setPrompt('');
    setServiceName('');
    setDetect(null);
    setResult(null);
    setError(null);
    setEdgeOp('');
    setSuggestions(null);
    setInjected({});
    setSuggestErr(null);
  };

  const endpoint =
    result?.graphqlEndpoint || result?.restEndpoint || result?.grpcEndpoint || null;

  // Map the setup schemaType to the apiType expected by scenario endpoints.
  const apiType = result?.schemaType === 'openapi' ? 'rest' : result?.schemaType || 'graphql';

  const analyzeEdgeCases = async () => {
    if (!result || !edgeOp) return;
    setAnalyzing(true);
    setSuggestErr(null);
    setSuggestions(null);
    setInjected({});
    try {
      const { scenarios } = await api.suggestScenarios({
        service: result.serviceName,
        operation: edgeOp,
        apiType,
      });
      setSuggestions(scenarios);
    } catch (e) {
      setSuggestErr(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  const injectEdgeCase = async (s: EdgeCaseScenario) => {
    if (!result || !edgeOp) return;
    setInjectingId(s.id);
    try {
      await api.injectScenario({
        service: result.serviceName,
        operation: edgeOp,
        prompt: s.prompt,
        apiType,
      });
      setInjected((prev) => ({ ...prev, [s.id]: 'ok' }));
    } catch {
      setInjected((prev) => ({ ...prev, [s.id]: 'fail' }));
    } finally {
      setInjectingId(null);
    }
  };

  const SEVERITY_TONE: Record<string, 'red' | 'yellow' | 'blue' | 'default'> = {
    critical: 'red',
    high: 'red',
    medium: 'yellow',
    low: 'blue',
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-fg">AI Studio</h1>
          <Badge tone="purple">AI</Badge>
        </div>
        <StepIndicator active={active} />
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
        {/* Left: inputs */}
        <div className="flex flex-col gap-6">
          <Card>
            <SectionTitle hint="Paste a GraphQL SDL, OpenAPI/JSON, AsyncAPI, or Protobuf spec — or upload a file.">
              1. Schema
            </SectionTitle>
            <div className="flex flex-col gap-3">
              <textarea
                value={schema}
                onChange={(e) => {
                  setSchema(e.target.value);
                  setDetect(null);
                  setResult(null);
                }}
                spellCheck={false}
                placeholder="type Query { ... }"
                className="h-64 w-full resize-y rounded-md border border-[rgb(var(--border))] bg-code-bg p-3 font-mono text-xs leading-relaxed text-fg outline-none transition placeholder:text-muted focus:border-ring focus:ring-2 focus:ring-ring/30"
              />
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-[rgb(var(--border))] bg-surface-2 px-3 py-2 text-sm text-fg transition hover:bg-surface-3">
                  Upload file
                  <input
                    type="file"
                    accept=".graphql,.gql,.json,.yaml,.yml,.proto,.txt"
                    onChange={onFile}
                    className="hidden"
                  />
                </label>
                <span className="text-xs text-muted">or start from a template →</span>
                {TEMPLATES.map((t) => (
                  <button
                    key={t.label}
                    onClick={() => applyTemplate(t)}
                    className="rounded-md border border-[rgb(var(--border))] px-2.5 py-1 text-xs font-medium text-muted transition hover:border-border-strong hover:text-fg"
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          <Card>
            <SectionTitle hint="Describe the mock data you want. Tip: include a count, e.g. “Generate 5 …”.">
              2. Describe
            </SectionTitle>
            <div className="flex flex-col gap-3">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Generate 5 realistic products across categories with prices in USD."
                className="h-24 w-full resize-y rounded-md border border-[rgb(var(--border))] bg-surface-2 p-3 text-sm leading-relaxed text-fg outline-none transition placeholder:text-muted focus:border-ring focus:ring-2 focus:ring-ring/30"
              />
              <Field label="Service name (optional)">
                <Input
                  value={serviceName}
                  onChange={(e) => setServiceName(e.target.value)}
                  placeholder="Auto-detected from schema"
                />
              </Field>
            </div>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={handleDetect} disabled={!schema.trim() || detecting}>
              {detecting ? <Spinner /> : 'Preview'}
            </Button>
            <Button
              onClick={handleDeploy}
              disabled={!schema.trim() || !prompt.trim() || deploying}
            >
              {deploying ? <Spinner label="Generating & deploying…" /> : 'Generate & Deploy'}
            </Button>
            {(schema || prompt || result) && (
              <Button variant="ghost" onClick={reset} disabled={deploying}>
                Reset
              </Button>
            )}
          </div>

          {error ? (
            <Card className="border-danger/40">
              <div className="flex items-center gap-2 text-sm text-danger">
                <StatusDot tone="red" /> {error}
              </div>
            </Card>
          ) : null}
        </div>

        {/* Right: preview + result */}
        <aside className="flex flex-col gap-6">
          <Card ai>
            <SectionTitle hint="Read-only inspection — no mocks are created yet.">Preview</SectionTitle>
            {!detect ? (
              <p className="text-sm text-muted">
                Run <span className="font-medium text-fg">Preview</span> to detect the schema format and
                validate before deploying.
              </p>
            ) : (
              <div className="flex flex-col gap-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted">Format</span>
                  <Badge tone="blue">{detect.schemaType}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">Valid</span>
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot tone={detect.valid ? 'green' : 'red'} />
                    <span className={detect.valid ? 'text-success' : 'text-danger'}>
                      {detect.valid ? 'Yes' : 'No'}
                    </span>
                  </span>
                </div>
                {detect.operations != null ? (
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Operations</span>
                    <span className="font-mono text-fg">{detect.operations}</span>
                  </div>
                ) : null}
                {detect.types != null ? (
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Types</span>
                    <span className="font-mono text-fg">{detect.types}</span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between">
                  <span className="text-muted">AI generation</span>
                  <Badge tone={detect.aiAvailable ? 'green' : 'yellow'}>
                    {detect.aiAvailable ? 'Available' : 'Schema fallback'}
                  </Badge>
                </div>
                {detect.issues.length > 0 ? (
                  <div className="mt-1 flex flex-col gap-1.5 border-t border-[rgb(var(--border))] pt-3">
                    {detect.issues.slice(0, 8).map((iss, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className="mt-1">
                          <StatusDot tone={iss.level === 'error' ? 'red' : 'yellow'} />
                        </span>
                        <span className="text-muted">{iss.message}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </Card>

          {result ? (
            <Card>
              <SectionTitle
                action={endpoint ? <Badge tone="green">Live</Badge> : undefined}
              >
                Deployed
              </SectionTitle>
              <div className="flex flex-col gap-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted">Service</span>
                  <span className="font-mono text-fg">{result.displayName || result.serviceName}</span>
                </div>
                {result.operationCount != null ? (
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Operations</span>
                    <span className="font-mono text-fg">{result.operationCount}</span>
                  </div>
                ) : null}
                {endpoint ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-muted">Endpoint</span>
                    <code className="break-all rounded bg-code-bg px-2 py-1 font-mono text-xs text-fg">
                      {endpoint}
                    </code>
                  </div>
                ) : null}
                <div className="mt-1 flex gap-2">
                  <Link href="/services">
                    <Button variant="secondary">Open in API Explorer</Button>
                  </Link>
                </div>
              </div>
            </Card>
          ) : null}
        </aside>
      </div>

      {/* Deploy log spans full width when present */}
      {result ? (
        <Card>
          <SectionTitle hint="Pipeline steps from the generate & deploy run.">Deployment log</SectionTitle>
          <StepLog steps={result.steps || []} />
        </Card>
      ) : null}

      {result?.mockRoutes && result.mockRoutes.length > 0 ? (
        <Card className="p-0">
          <div className="border-b border-[rgb(var(--border))] px-5 py-3">
            <h2 className="text-lg font-semibold text-fg">Mock routes</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[rgb(var(--border))] text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-5 py-2.5 font-medium">Operation</th>
                  <th className="px-5 py-2.5 font-medium">Method</th>
                  <th className="px-5 py-2.5 font-medium">URL</th>
                  <th className="px-5 py-2.5 font-medium">Example</th>
                </tr>
              </thead>
              <tbody>
                {result.mockRoutes.map((r, i) => (
                  <tr key={i} className="border-b border-[rgb(var(--border))] last:border-0">
                    <td className="px-5 py-2.5 font-medium text-fg">{r.operation}</td>
                    <td className="px-5 py-2.5">
                      <Badge tone="blue">{r.method}</Badge>
                    </td>
                    <td className="px-5 py-2.5 font-mono text-xs text-muted">{r.url}</td>
                    <td className="px-5 py-2.5">
                      <StatusDot tone={r.exampleGenerated ? 'green' : 'yellow'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {/* Edge-case suggestions — analyze a deployed operation, then inject
          the chosen edge cases as callable mock variants. */}
      {result ? (
        <Card ai>
          <SectionTitle
            hint="AI (or fallback) inspects the schema and suggests edge cases. Inject one and it's served on the live mock route immediately."
            action={<Badge tone="purple">Edge cases</Badge>}
          >
            Suggested Edge Cases
          </SectionTitle>

          <div className="flex flex-wrap items-end gap-3">
            <Field label="Operation">
              <select
                value={edgeOp}
                onChange={(e) => {
                  setEdgeOp(e.target.value);
                  setSuggestions(null);
                  setInjected({});
                }}
                className="min-w-56 rounded-md border border-[rgb(var(--border))] bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
              >
                {(result.mockRoutes || []).map((r) => (
                  <option key={r.operation} value={r.operation}>
                    {r.operation}
                  </option>
                ))}
              </select>
            </Field>
            <Button variant="secondary" onClick={analyzeEdgeCases} disabled={analyzing || !edgeOp}>
              {analyzing ? <Spinner label="Analyzing…" /> : 'Suggest edge cases'}
            </Button>
          </div>

          {suggestErr ? (
            <div className="mt-3 flex items-center gap-2 text-sm text-danger">
              <StatusDot tone="red" /> {suggestErr}
            </div>
          ) : null}

          {suggestions ? (
            suggestions.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No suggestions returned.</p>
            ) : (
              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                {suggestions.map((s) => {
                  const state = injected[s.id];
                  return (
                    <div
                      key={s.id}
                      className="flex flex-col gap-2 rounded-lg border border-[rgb(var(--border))] bg-surface-2 p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-semibold text-fg">{s.name}</span>
                        <span className="flex shrink-0 gap-1">
                          <Badge tone={SEVERITY_TONE[s.severity] || 'default'}>{s.severity}</Badge>
                        </span>
                      </div>
                      <span className="text-xs text-muted">{s.category}</span>
                      <p className="text-sm text-muted">{s.description}</p>
                      <div className="mt-auto flex items-center justify-between pt-1">
                        {state === 'ok' ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-success">
                            <StatusDot tone="green" /> Injected — callable now
                          </span>
                        ) : state === 'fail' ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-danger">
                            <StatusDot tone="red" /> Failed
                          </span>
                        ) : (
                          <span />
                        )}
                        <Button
                          variant={state === 'ok' ? 'ghost' : 'secondary'}
                          onClick={() => injectEdgeCase(s)}
                          disabled={injectingId === s.id}
                        >
                          {injectingId === s.id ? 'Injecting…' : state === 'ok' ? 'Re-inject' : 'Inject'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <p className="mt-4 text-sm text-muted">
              Pick a deployed operation and <span className="font-medium text-fg">Suggest edge cases</span> to see
              schema-tailored failure modes you can inject.
            </p>
          )}

          {endpoint && Object.values(injected).includes('ok') ? (
            <p className="mt-3 text-xs text-muted">
              Injected edge cases are now served at <code className="rounded bg-code-bg px-1.5 py-0.5 font-mono text-fg">{endpoint}</code>.
              Restore original data from the Chaos Lab.
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
