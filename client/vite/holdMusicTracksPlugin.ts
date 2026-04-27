import { readdirSync } from 'node:fs';
import type { Plugin } from 'vite';

const HOLD_MUSIC_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg']);
const VIRTUAL_HOLD_MUSIC_ID = 'virtual:hold-music-tracks';
const RESOLVED_VIRTUAL_HOLD_MUSIC_ID = `\0${VIRTUAL_HOLD_MUSIC_ID}`;

export function holdMusicTracksPlugin(musicDir: string): Plugin {
  function readTracks(): string[] {
    try {
      return readdirSync(musicDir)
        .filter((name) => HOLD_MUSIC_EXTENSIONS.has(extname(name).toLowerCase()))
        .sort();
    } catch {
      return [];
    }
  }

  return {
    name: 'hold-music-tracks',
    resolveId(id) {
      if (id === VIRTUAL_HOLD_MUSIC_ID) return RESOLVED_VIRTUAL_HOLD_MUSIC_ID;
      return null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_HOLD_MUSIC_ID) return null;
      const tracks = readTracks();
      return `export const HOLD_MUSIC_TRACKS = ${JSON.stringify(tracks)};\n`;
    },
    configureServer(server) {
      server.watcher.add(musicDir);
      const invalidate = (path: string) => {
        if (!path.startsWith(musicDir)) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_HOLD_MUSIC_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
      };
      server.watcher.on('add', invalidate);
      server.watcher.on('unlink', invalidate);
      server.watcher.on('change', invalidate);
    },
  };
}

function extname(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot);
}
