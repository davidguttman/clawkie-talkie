import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { holdMusicTracksPlugin } from './vite/holdMusicTracksPlugin';
import { pwaHtmlPlugin } from './vite/pwaPlugin';

export default defineConfig({
  plugins: [react(), holdMusicTracksPlugin(resolve(__dirname, 'public/music')), pwaHtmlPlugin()],
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
        voiceHtml: resolve(__dirname, 'voice.html'),
        voice: resolve(__dirname, 'voice/index.html'),
        dashboard: resolve(__dirname, 'dashboard/index.html'),
      },
    },
  },
});
