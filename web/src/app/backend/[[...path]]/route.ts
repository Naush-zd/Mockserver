import { NextRequest } from 'next/server';

// Runtime reverse-proxy to the Express API backend. The browser calls
// same-origin `/backend/*`; this handler forwards to BACKEND_URL server-side,
// so there's no CORS and the backend URL is read fresh on every request.

export const dynamic = 'force-dynamic';

function backendBase(): string {
  return (process.env.BACKEND_URL || 'http://localhost:4010').replace(/\/$/, '');
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'host',
  'content-length',
]);

async function proxy(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path } = await ctx.params;
  const suffix = (path ?? []).map(encodeURIComponent).join('/');
  const target = `${backendBase()}/${suffix}${req.nextUrl.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });

  const init: RequestInit = { method: req.method, headers, redirect: 'manual' };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.text();
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Backend unreachable', detail: err instanceof Error ? err.message : String(err) }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  }

  const respHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) respHeaders.set(key, value);
  });

  const body = await upstream.arrayBuffer();
  return new Response(body, { status: upstream.status, headers: respHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
