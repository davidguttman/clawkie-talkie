import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

function readLanding(): string {
  return readFileSync(resolve(root, 'client/index.html'), 'utf8');
}

// Canonical scripted dialogue from docs/design/hifi-script.jsx (turns 3 + 4).
const USER_LINE =
  "Keep exploring. What's the counterargument? Someone could say you think better at a desk with tools.";
const AI_LINE =
  "Right. The counter is that tools create affordances for editing, not for thinking. At a desk you start shaping words before you have the idea. In the car you have to finish the thought because you can't backspace.";

describe('landing page scripted demo', () => {
  it('keeps the root page static while adding an accessible demo control', () => {
    const html = readLanding();

    expect(html).not.toContain('/src/main.tsx');
    expect(html).toContain('data-demo-device');
    expect(html).toContain('<button type="button" class="device-ptt" data-demo-advance');
    expect(html).not.toMatch(/<div class="device"[^>]*aria-hidden=/);
  });

  it('defines the corrected state sequence in order', () => {
    const html = readLanding();
    const orderedStepIds = [
      'idle-ready',
      'recording-counter',
      'thinking-transcribing',
      'thinking-pending',
      'ai-readback',
      'idle-ai-last',
    ];

    let previous = -1;
    for (const stepId of orderedStepIds) {
      const current = html.indexOf(`id: '${stepId}'`);
      expect(current, `${stepId} is present`).toBeGreaterThan(-1);
      expect(current, `${stepId} follows the prior step`).toBeGreaterThan(previous);
      previous = current;
    }

    expect(html).toContain("phase: 'idle'");
    expect(html).toContain("phase: 'recording'");
    expect(html).toContain("phase: 'thinking'");
    expect(html).toContain("phase: 'ai'");
    expect(html).toContain("label: 'READY'");
    expect(html).toContain("label: 'YOU · LIVE'");
    expect(html).toContain("label: 'TRANSCRIBING · OPENCLAW'");
    expect(html).toContain("label: 'THINKING'");
    expect(html).toContain("label: 'AI · READING ALOUD'");
    expect(html).toContain("label: 'AI · LAST'");
    expect(html).toContain("pill: 'READING REPLY'");
  });

  it('uses the canonical hifi-script dialogue, not invented copy', () => {
    const html = readLanding();

    // Source-of-truth strings from docs/design/hifi-script.jsx.
    expect(html).toContain(USER_LINE);
    expect(html).toContain(AI_LINE);

    // Invented strings that must not regress back into the demo.
    const forbiddenCopy = [
      'Tap to continue the conversation.',
      'walk me through the deploy plan',
      'finalizing your turn and preparing the reply',
      'checking the rollback path',
      'database migration',
      'feature flag',
      'rollback starts looking likely',
      'auth callback failures',
      'CLWK · DEMO',
    ];
    for (const phrase of forbiddenCopy) {
      expect(html, `forbidden copy "${phrase}"`).not.toContain(phrase);
    }
  });

  it('does not market the product as literally hands-free', () => {
    const html = readLanding();
    // The product requires pressing the on-screen PTT button —
    // marketing copy must not imply zero physical interaction.
    expect(html).not.toMatch(/hands[-\s]?free/i);
    // And the press/push-to-talk framing should still be present.
    expect(html.toLowerCase()).toMatch(/push-to-talk|tap-to-talk|press the big button/);
  });

  it('frames the product as long-form steering of the same OpenClaw session', () => {
    const html = readLanding();
    const lower = html.toLowerCase();

    // Positioning aligned with README: car / long-form / same OpenClaw
    // session / canonical transcript readable later.
    expect(lower).toMatch(/\bcar\b/);
    expect(lower).toContain('long-form');
    expect(lower).toContain('openclaw session');
    expect(lower).toMatch(/transcript|read.*(later|canonical)|canonical/);

    // Stale short-chat / pair-programming framing must not regress.
    const stalePositioning = [
      'Three taps. Zero friction.',
      'Pair-program from the car.',
      'walk through a stack trace',
      'Tap once to record',
      'cooking',
      'earbuds',
      'chatbot',
    ];
    for (const phrase of stalePositioning) {
      expect(html, `stale positioning "${phrase}"`).not.toContain(phrase);
    }
  });

  it('shows the user transcript on the transcribing/thinking page, not filler', () => {
    const html = readLanding();

    // The transcribing step must carry the same user line that was just
    // recorded — that is the visual contract David called out.
    const transcribingIdx = html.indexOf("id: 'thinking-transcribing'");
    expect(transcribingIdx).toBeGreaterThan(-1);
    const aiIdx = html.indexOf("id: 'ai-readback'");
    expect(aiIdx).toBeGreaterThan(transcribingIdx);

    const transcribingBlock = html.slice(transcribingIdx, aiIdx);
    expect(transcribingBlock).toContain("label: 'TRANSCRIBING · OPENCLAW'");
    expect(transcribingBlock).toContain('USER_LINE');

    // The "thinking-pending" beat between transcribe → ai must be empty
    // text, mirroring drivingLoop.displayedCaptionText after stt.done.
    const pendingIdx = html.indexOf("id: 'thinking-pending'");
    expect(pendingIdx).toBeGreaterThan(transcribingIdx);
    const pendingBlock = html.slice(pendingIdx, aiIdx);
    expect(pendingBlock).toMatch(/text:\s*''/);
  });

  it('uses the mock-faithful header and mono device font', () => {
    const html = readLanding();

    expect(html).toContain('CLWK · f3c1 · agent');
    expect(html).not.toContain('CLWK · DEMO');

    // Device subtree should render in the IBM Plex Mono treatment used by
    // the actual app's caption (Driving.tsx default baseFont = mono).
    expect(html).toMatch(/\.device-screen\s*\{[^}]*font-family:\s*var\(--mono\)/);
    expect(html).toMatch(/\.device-caption\s*\{[^}]*font-family:\s*var\(--mono\)/);
  });

  it('uses the same advance path for autoplay and manual activation', () => {
    const html = readLanding();

    expect(html).toContain('function advance(reason)');
    expect(html).toContain("advance('auto')");
    expect(html).toContain("advance('manual')");
    expect(html).toContain("control.addEventListener('click'");
    expect(html).not.toMatch(/\.click\s*\(/);
  });

  it('clears autoplay timers and respects reduced motion', () => {
    const html = readLanding();

    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
    expect(html).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')");
    expect(html).toContain('function clearDemoTimer()');
    expect(html).toContain('window.clearTimeout(timer)');
    expect(html).toContain('if (motionQuery.matches) return;');
    expect(html).toContain("motionQuery.addEventListener('change', scheduleAutoplay)");
  });

  it('does not call real voice, mic, WebRTC, or browser TTS APIs from the landing page', () => {
    const html = readLanding();
    const forbidden = [
      'speechSynthesis',
      'SpeechSynthesisUtterance',
      'navigator.mediaDevices',
      'mediaDevices.getUserMedia',
      'getUserMedia',
      'RTCPeerConnection',
      'SimplePeer',
      'simple-peer',
    ];

    for (const token of forbidden) {
      expect(html, `${token} is not used`).not.toContain(token);
    }
  });
});
