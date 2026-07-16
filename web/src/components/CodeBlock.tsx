'use client';

import * as React from 'react';

export function CodeBlock({
  code,
  filename,
  language = '',
  maxHeight = '60vh',
}: {
  code: string;
  filename?: string;
  language?: string;
  maxHeight?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const download = () => {
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="group overflow-hidden rounded-lg border border-[rgb(var(--border))] bg-surface">
      <div className="flex items-center justify-between border-b border-[rgb(var(--border))] bg-surface-2 px-3 py-2">
        <span className="font-mono text-xs text-muted">{filename || language || 'code'}</span>
        <div className="flex gap-2 opacity-0 transition group-hover:opacity-100">
          <button
            onClick={copy}
            className="rounded-md border border-[rgb(var(--border))] bg-surface px-2.5 py-1 text-xs font-medium text-muted transition hover:text-fg"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          {filename ? (
            <button
              onClick={download}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-fg transition hover:bg-primary-hover"
            >
              Download
            </button>
          ) : null}
        </div>
      </div>
      <pre
        className="overflow-auto bg-code-bg p-4 font-mono text-xs leading-relaxed text-fg"
        style={{ maxHeight }}
      >
        {code}
      </pre>
    </div>
  );
}
