import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the file-tracing root to this app so Next doesn't get confused by the
  // sibling backend lockfile in the repo root.
  outputFileTracingRoot: __dirname,
  // Proxying to the Express API is handled at runtime by the route handler at
  // src/app/backend/[[...path]]/route.ts (reads BACKEND_URL per request), so the
  // backend URL is configurable at container start — not baked in at build time.
};

export default nextConfig;
