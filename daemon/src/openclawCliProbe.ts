import { spawn } from 'node:child_process';

const PROBE_TIMEOUT_MS = 4_000;

export interface OpenClawCliProbe {
  ok: boolean;
  warning?: string;
}

export async function probeOpenClawCli(
  run: () => Promise<boolean> = openClawVersionSucceeds,
): Promise<OpenClawCliProbe> {
  let ok = false;
  try {
    ok = await run();
  } catch {
    ok = false;
  }
  if (ok) return { ok: true };
  return {
    ok: false,
    warning: [
      '[daemon] warning: openclaw is not usable from this process (`openclaw --version` failed or timed out).',
      '[daemon] The Join URL will still print, but voice turns fail until the same OS user can run OpenClaw.',
      '[daemon] On Linux, a global npm install often puts the binary in ~/.local/bin, which may not be on PATH.',
      '[daemon] Check `command -v openclaw` and `npm prefix -g`, then run `npm run agent-install-preflight` from this repo.',
    ].join('\n'),
  };
}

async function openClawVersionSucceeds(): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const child = spawn('openclaw', ['--version'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(false);
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}
