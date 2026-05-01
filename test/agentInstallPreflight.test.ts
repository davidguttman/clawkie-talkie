import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyPreflightFailure,
  parseArgs,
  REQUIRED_AGENT_SCOPES,
  runPreflight,
} from '../scripts/agent-install-preflight.mjs';

function successfulCommand(calls: Array<{ command: string; args: string[] }>) {
  return async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === 'npm') return { exitCode: 0, stdout: '10.9.0\n', stderr: '' };
    if (args[0] === '--version') return { exitCode: 0, stdout: 'openclaw 2026.4.25\n', stderr: '' };
    if (args[0] === 'status') return { exitCode: 0, stdout: JSON.stringify({ ok: true, gateway: { ok: true } }), stderr: '' };
    if (args.includes('--output')) {
      await writeFile(args[args.indexOf('--output') + 1], Buffer.from([1]));
    }
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, outputs: [{ text: '' }] }), stderr: '' };
  };
}

describe('agent install preflight', () => {
  it('runs early status and infer checks without claiming agent-turn readiness', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'clawkie-preflight-test-'));
    const calls: Array<{ command: string; args: string[] }> = [];
    try {
      const result = await runPreflight({ skipInfer: false }, {
        tempRoot,
        runCommand: successfulCommand(calls),
      });

      expect(result.ok).toBe(true);
      expect(result.checks.map((check) => check.name)).toEqual([
        'node-version',
        'npm-presence',
        'openclaw-version',
        'openclaw-status',
        'openclaw-infer-stt',
        'openclaw-infer-tts',
      ]);
      expect(calls.some((call) => call.args[0] === 'agent')).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('runs agent-turn smoke without delivery by default', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await runPreflight({ sessionId: 'agent:main:main', skipInfer: true, timeoutSeconds: 9 }, {
      runCommand: successfulCommand(calls),
    });

    expect(result.ok).toBe(true);
    const agentCall = calls.find((call) => call.args[0] === 'agent');
    expect(agentCall?.args).toEqual([
      'agent',
      '--agent', 'main',
      '--session-id', 'agent:main:main',
      '--channel', 'last',
      '--json',
      '--timeout', '9',
      '-m', 'Clawkie Talkie install smoke test. Reply with exactly: ok',
    ]);
    expect(agentCall?.args).not.toContain('--deliver');
  });

  it('derives the spawned agent command timeout from --timeout', async () => {
    const calls: Array<{ command: string; args: string[]; opts?: { timeoutMs?: number } }> = [];
    const result = await runPreflight({ sessionId: 'agent:main:main', skipInfer: true, timeoutSeconds: 9 }, {
      runCommand: async (command: string, args: string[], opts?: { timeoutMs?: number }) => {
        calls.push({ command, args, opts });
        return successfulCommand([])(command, args);
      },
    });

    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.args[0] === 'agent')?.opts?.timeoutMs).toBe(14_000);
  });

  it('adds --deliver only when explicitly requested', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await runPreflight({ sessionId: 'agent:main:main', deliver: true, skipInfer: true, timeoutSeconds: 12 }, {
      runCommand: successfulCommand(calls),
    });

    expect(result.ok).toBe(true);
    const agentCall = calls.find((call) => call.args[0] === 'agent');
    expect(agentCall?.args).toContain('--deliver');
    expect(agentCall?.args).toEqual(expect.arrayContaining(['--timeout', '12']));
  });

  it('fails before status checks when --require-agent-turn has no session id', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await runPreflight({ requireAgentTurn: true, skipInfer: true }, {
      runCommand: successfulCommand(calls),
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      name: 'openclaw-agent-turn',
      status: 'fail',
      code: 'missing_session_id',
    });
    expect(result.checks[0].summary).toContain('--require-agent-turn');
  });

  it('uses openclaw status --json and validates JSON status output', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await runPreflight({ skipInfer: true }, {
      runCommand: successfulCommand(calls),
    });

    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.args[0] === 'status')?.args).toEqual(['status', '--json']);
  });

  it('fails when a parseable openclaw --version is below 2026.4.25', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await runPreflight({ skipInfer: true }, {
      runCommand: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (command === 'npm') return { exitCode: 0, stdout: '10.9.0\n', stderr: '' };
        if (args[0] === '--version') return { exitCode: 0, stdout: 'openclaw 2026.4.24\n', stderr: '' };
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)).toMatchObject({
      name: 'openclaw-version',
      status: 'fail',
      code: 'openclaw_version_too_old',
    });
    expect(calls.some((call) => call.args[0] === 'status')).toBe(false);
  });

  it('treats agent-turn scope upgrade approval as the relevant nonzero blocker even when status and infer pass', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'clawkie-preflight-test-'));
    const requestId = 'a8b414c2-0d4b-4266-85b8-ab94662dce18';
    try {
      const result = await runPreflight({ sessionId: 'agent:main:main' }, {
        tempRoot,
        runCommand: async (command: string, args: string[]) => {
          if (command === 'npm') return { exitCode: 0, stdout: '10.9.0\n', stderr: '' };
          if (args[0] === '--version') return { exitCode: 0, stdout: 'openclaw 2026.4.25\n', stderr: '' };
          if (args[0] === 'status') return { exitCode: 0, stdout: JSON.stringify({ ok: true, gateway: { ok: true } }), stderr: '' };
          if (args.includes('--output')) {
            await writeFile(args[args.indexOf('--output') + 1], Buffer.from([1]));
          }
          if (args[0] === 'agent') {
            return {
              exitCode: 1,
              stdout: '',
              stderr: `scope upgrade pending approval for scopes operator.pairing operator.read operator.write\nRun: openclaw devices approve ${requestId}`,
            };
          }
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, outputs: [{ text: '' }] }), stderr: '' };
        },
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(20);
      expect(result.checks.slice(0, -1).every((check) => check.status === 'pass')).toBe(true);
      expect(result.checks.at(-1)).toMatchObject({
        name: 'openclaw-agent-turn',
        status: 'fail',
        code: 'openclaw_scope_approval_pending',
        requestId,
        approveCommand: `openclaw devices approve ${requestId}`,
        requiredScopes: REQUIRED_AGENT_SCOPES,
      });
      expect(result.checks.at(-1)?.summary).toContain('openclaw status and infer may pass');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('classifies pending device approval text and preserves the approval command', () => {
    const requestId = 'req-123';
    const classified = classifyPreflightFailure(
      `pending device approval; approve with openclaw devices approve ${requestId}`,
    );

    expect(classified).toMatchObject({
      code: 'openclaw_scope_approval_pending',
      requestId,
      approveCommand: `openclaw devices approve ${requestId}`,
      requiredScopes: REQUIRED_AGENT_SCOPES,
    });
  });

  it('parses agent-turn, delivery, and timeout options', () => {
    expect(parseArgs(['--session-id', 'agent:main:main', '--deliver', '--timeout', '12'])).toMatchObject({
      agentTurn: true,
      deliver: true,
      sessionId: 'agent:main:main',
      timeoutSeconds: 12,
    });

    expect(parseArgs(['--require-agent-turn'])).toMatchObject({
      agentTurn: true,
      requireAgentTurn: true,
    });
  });
});
