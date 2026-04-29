import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { holdMusicTracksPlugin } from './vite/holdMusicTracksPlugin';

export default defineConfig({
  plugins: [react(), holdMusicTracksPlugin(resolve(__dirname, 'public/music'))],
  define: {
    global: 'globalThis',
    process: 'globalThis.__clawkieProcess',
    'process.env': {},
  },
  resolve: {
    alias: {
      events: 'events/',
      util: 'util/',
    },
  },
  optimizeDeps: {
    include: ['events', 'util'],
  },
  server: {
    host: true,
    allowedHosts: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        voice: resolve(__dirname, 'voice/index.html'),
      },
    },
  },
});
