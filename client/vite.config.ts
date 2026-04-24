import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Signaling now uses a rambly-style server (SSE + HTTP POST). The browser
// reaches it directly via the URL configured in VITE_SIGNAL_SERVER (or the
// default in client/src/rtc/client.ts), so vite needs no proxy for it.

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: true,
  },
});
