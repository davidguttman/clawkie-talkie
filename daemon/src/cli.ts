import { parseArgs } from 'node:util';
import { resolveClientOrigin } from './clientOrigin.js';
import { resolveDaemonPeerId } from './peerId.js';
import { resolveIceServers, resolveSignalServer } from './transportConfig.js';

export interface CliOptions {
  sessionId: string;
  threadId?: string;
  clientOrigin: string;
  sttLanguage?: string;
  peerId: string;
  signalServer: string;
  iceServers?: RTCIceServer[];
}

export function parseCli(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      'session-id': { type: 'string' },
      'client-origin': { type: 'string' },
      'stt-language': { type: 'string' },
      'thread-id': { type: 'string' },
      'signal-server': { type: 'string' },
      'ice-servers-json': { type: 'string' },
    },
  });

  return {
    sessionId: values['session-id'] || 'dev-local',
    threadId: values['thread-id'] || env.CT_THREAD_ID,
    clientOrigin: resolveClientOrigin(values['client-origin'], env),
    sttLanguage: values['stt-language'] || env.CT_STT_LANGUAGE,
    peerId: resolveDaemonPeerId(env),
    signalServer: resolveSignalServer(values['signal-server'], env),
    iceServers: resolveIceServers(values['ice-servers-json'], env),
  };
}
