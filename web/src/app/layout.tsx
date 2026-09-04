import './globals.css';
import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Unified Mock Server',
  description: 'AI-augmented API virtualization & resilience-testing platform',
};

// Applied before paint to avoid a light/dark flash on first load.
const noFlashScript = `
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t !== 'light' && t !== 'dark') t = 'dark';
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${inter.variable} ${jetbrains.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body className="h-screen overflow-hidden bg-bg font-sans text-fg antialiased">
        <div className="flex h-screen">
          <Sidebar />
          <div className="flex h-screen flex-1 flex-col overflow-hidden">
            <Topbar />
            <main className="flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-7xl px-6 py-8 lg:px-10">{children}</div>
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
