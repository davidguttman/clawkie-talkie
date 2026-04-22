// hifi-tokens.js — design tokens for the Clawkie-Talkie hi-fi prototype
// Dark OLED-first. Accent switchable.

window.HIFI = {
  // Colors
  bg: '#000000',           // true OLED black
  surface: '#0c0c0e',      // cards / elevated panels
  surface2: '#151518',     // deeper tiers
  stroke: 'rgba(255,255,255,0.08)',
  strokeStrong: 'rgba(255,255,255,0.18)',
  ink: '#fafafa',
  ink2: '#b8b8bc',
  ink3: '#707076',
  ink4: '#3a3a3e',

  // State accents — switchable primary "amber" default
  accents: {
    amber:   { hue: 36,  rec: '#ff9e3b', recGlow: 'rgba(255,158,59,0.45)' },
    red:     { hue: 8,   rec: '#ff5a4a', recGlow: 'rgba(255,90,74,0.45)' },
    cyan:    { hue: 190, rec: '#5ad0e8', recGlow: 'rgba(90,208,232,0.45)' },
    green:   { hue: 150, rec: '#4ed29a', recGlow: 'rgba(78,210,154,0.45)' },
    magenta: { hue: 320, rec: '#e866c6', recGlow: 'rgba(232,102,198,0.45)' },
  },

  ai:   '#7fb8d0',                      // AI speaking (soft cyan, stays constant)
  aiGlow: 'rgba(127,184,208,0.4)',
  think: '#e8c25a',                     // thinking (warm gold)
  thinkGlow: 'rgba(232,194,90,0.4)',

  // Type stacks
  fonts: {
    mono: "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace",
    sans: "'IBM Plex Sans', -apple-system, system-ui, sans-serif",
    display: "'IBM Plex Mono', ui-monospace, monospace",
  },
};
