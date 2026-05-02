#!/usr/bin/env node
import http from 'node:http';
import { createSignalingService } from './app.js';

const port = Number.parseInt(process.env.PORT ?? process.env.CT_SIGNALING_PORT ?? '8787', 10);
const host = process.env.CT_SIGNALING_HOST ?? '127.0.0.1';

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`Invalid signaling port: ${process.env.PORT ?? process.env.CT_SIGNALING_PORT}`);
}

const signaling = createSignalingService();
const server = http.createServer(signaling.handler);
server.listen(port, host, () => {
  console.log(`[signaling] listening on http://${host}:${port}`);
  if (host === '127.0.0.1' || host === 'localhost') {
    console.log('[signaling] localhost-only by default; set CT_SIGNALING_HOST=0.0.0.0 to expose it');
  }
});

const shutdown = () => {
  signaling.closeAllSubscribers();
  server.close((err) => {
    if (err) {
      console.error('[signaling] shutdown failed', err);
      process.exit(1);
    }
    process.exit(0);
  });
  server.closeAllConnections?.();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
