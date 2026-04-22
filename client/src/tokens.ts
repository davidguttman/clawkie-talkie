// Design tokens ported from docs/design/hifi-tokens.js.
// Dark OLED-first. Accent switchable.

export type AccentKey = 'amber' | 'red' | 'cyan' | 'green' | 'magenta';

export interface Accent {
  hue: number;
  rec: string;
  recGlow: string;
}

export const HIFI = {
  bg: '#000000',
  surface: '#0c0c0e',
  surface2: '#151518',
  stroke: 'rgba(255,255,255,0.1)',
  strokeStrong: 'rgba(255,255,255,0.22)',
  ink: '#fafafa',
  ink2: '#c4c4c8',
  ink3: '#8c8c94',
  ink4: '#5c5c62',

  accents: {
    amber: { hue: 36, rec: '#ff9e3b', recGlow: 'rgba(255,158,59,0.45)' },
    red: { hue: 8, rec: '#ff5a4a', recGlow: 'rgba(255,90,74,0.45)' },
    cyan: { hue: 190, rec: '#5ad0e8', recGlow: 'rgba(90,208,232,0.45)' },
    green: { hue: 150, rec: '#4ed29a', recGlow: 'rgba(78,210,154,0.45)' },
    magenta: { hue: 320, rec: '#e866c6', recGlow: 'rgba(232,102,198,0.45)' },
  } as Record<AccentKey, Accent>,

  ai: '#7fb8d0',
  aiGlow: 'rgba(127,184,208,0.4)',
  think: '#e8c25a',
  thinkGlow: 'rgba(232,194,90,0.4)',

  fonts: {
    mono: "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace",
    sans: "'IBM Plex Sans', -apple-system, system-ui, sans-serif",
    display: "'IBM Plex Mono', ui-monospace, monospace",
  },
};
