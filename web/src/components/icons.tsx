import * as React from 'react';

type P = React.SVGProps<SVGSVGElement>;

const base = (props: P) => ({
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...props,
});

export const IconOverview = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
);

export const IconExplorer = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15 9-3.5 1.5L10 14l3.5-1.5L15 9Z" />
  </svg>
);

export const IconAI = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    <path d="m6 6 2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
);

export const IconTests = (p: P) => (
  <svg {...base(p)}>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M9 8h6M9 12h6M9 16h4" />
  </svg>
);

export const IconChaos = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 3h6M10 3v5l-4.5 8A2 2 0 0 0 7.3 19h9.4a2 2 0 0 0 1.8-3L14 8V3" />
  </svg>
);

export const IconRoutes = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M8.5 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.5" />
  </svg>
);

export const IconAnalytics = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 20V4M4 20h16" />
    <path d="M8 16v-4M12 16V8M16 16v-6" />
  </svg>
);

export const IconDeployments = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3c3 1.5 5 5 5 9l-2 5H9l-2-5c0-4 2-7.5 5-9Z" />
    <circle cx="12" cy="10" r="1.8" />
  </svg>
);

export const IconTeam = (p: P) => (
  <svg {...base(p)}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3 20a6 6 0 0 1 12 0" />
    <path d="M16 5.5a3 3 0 0 1 0 5M21 20a6 6 0 0 0-4-5.6" />
  </svg>
);

export const IconSettings = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19 12a7 7 0 0 0-.12-1.3l2-1.55-2-3.46-2.35.95a7 7 0 0 0-2.26-1.3L13.9 2h-3.8l-.4 2.34a7 7 0 0 0-2.27 1.3L5.1 4.7l-2 3.46 2 1.55A7 7 0 0 0 5 12c0 .44.04.87.12 1.3l-2 1.55 2 3.46 2.35-.95a7 7 0 0 0 2.26 1.3l.4 2.34h3.8l.4-2.34a7 7 0 0 0 2.27-1.3l2.34.95 2-3.46-2-1.55c.08-.43.11-.86.11-1.3Z" />
  </svg>
);

export const IconDocs = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 4a2 2 0 0 1 2-2h8l4 4v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z" />
    <path d="M14 2v5h5M9 13h6M9 17h6" />
  </svg>
);

export const IconSupport = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3M12 17h.01" />
  </svg>
);

export const IconPlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const IconBell = (p: P) => (
  <svg {...base(p)}>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
);

export const IconStar = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3.5l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 17.1 6.75 19.7l1-5.85L3.5 9.65l5.9-.85L12 3.5Z" />
  </svg>
);

export const IconExternal = (p: P) => (
  <svg {...base(p)}>
    <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </svg>
);
