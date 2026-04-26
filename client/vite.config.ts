import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
        voice: resolve(__dirname, 'voice.html'),
        voicePath: resolve(__dirname, 'voice/index.html'),
      },
    },
  },
});
