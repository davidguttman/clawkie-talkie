import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
    process: { env: {} },
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
});
