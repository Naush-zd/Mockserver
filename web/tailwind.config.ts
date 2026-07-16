import type { Config } from 'tailwindcss';

const withVar = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: withVar('--bg'),
        surface: withVar('--surface'),
        'surface-2': withVar('--surface-2'),
        'surface-3': withVar('--surface-3'),
        'border-strong': withVar('--border-strong'),
        fg: withVar('--fg'),
        muted: withVar('--muted'),
        primary: {
          DEFAULT: withVar('--primary'),
          hover: withVar('--primary-hover'),
          fg: withVar('--primary-fg'),
        },
        ring: withVar('--ring'),
        success: withVar('--success'),
        danger: withVar('--danger'),
        warning: withVar('--warning'),
        'ai-from': withVar('--ai-from'),
        'ai-to': withVar('--ai-to'),
        'code-bg': withVar('--code-bg'),

        // ── Backward-compatible aliases (old pages still compile pre-redesign) ──
        panel: withVar('--surface'),
        panel2: withVar('--surface-2'),
        border: withVar('--border'),
        accent: withVar('--primary'),
        accentHover: withVar('--primary-hover'),
        blue: withVar('--ring'),
        green: withVar('--success'),
        red: withVar('--danger'),
        yellow: withVar('--warning'),
      },
      borderColor: {
        DEFAULT: withVar('--border'),
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        sm: '0.25rem',
        DEFAULT: '0.5rem',
        md: '0.75rem',
        lg: '1rem',
        xl: '1.5rem',
      },
      backgroundImage: {
        'ai-gradient': 'linear-gradient(135deg, rgb(var(--ai-from)), rgb(var(--ai-to)))',
      },
      boxShadow: {
        ambient: '0 20px 40px rgba(0, 0, 0, 0.4)',
      },
    },
  },
  plugins: [],
};

export default config;
