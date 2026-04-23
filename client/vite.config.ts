import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port must match DEFAULT_SIGNALING_PORT in daemon/src/signaling.ts.
const SIGNALING_PORT = Number(process.env.CT_SIGNALING_PORT) || 9000;
const SIGNALING_TARGET = `http://127.0.0.1:${SIGNALING_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: true,
    // Proxy PeerJS signaling (HTTP + WebSocket upgrade) to the daemon's
    // local PeerServer. This lets the browser reach signaling via
    // same-origin, which is the only shape that works through jump.sh.
    proxy: {
      '/peerjs': {
        target: SIGNALING_TARGET,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
