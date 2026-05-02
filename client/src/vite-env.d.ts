/// <reference types="vite/client" />

interface ImportMetaEnv {
  VITE_SIGNAL_SERVER?: string;
  VITE_ICE_SERVERS_JSON?: string;
  [key: string]: unknown;
}

declare module 'virtual:hold-music-tracks' {
  export const HOLD_MUSIC_TRACKS: readonly string[];
}