import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

function readLanding(): string {
  return readFileSync(resolve(root, 'client/index.html'), 'utf8');
}

describe('landing page scripted demo', () => {
  it('keeps the root page static while adding an accessible demo control', () => {
    const html = readLanding();

    expect(html).not.toContain('/src/main.tsx');
    expect(html).toContain('data-demo-device');
    expect(html).toContain('<button type="button" class="device-ptt" data-demo-advance');
    expect(html).not.toMatch(/<div class="device"[^>]*aria-hidden=/);
  });

  it('defines the approved conceptual demo flow order', () => {
    const html = readLanding();
    const orderedStepIds = [
      'idle-ready',
      'recording-auth-plan',
      'thinking-transcribing',
      'ai-readback',
      'idle-next-turn',
      'recording-follow-up',
      'thinking-follow-up',
      'ai-follow-up',
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
    expect(html).toContain("label: 'TRANSCRIBING · OPENCLAW'");
    expect(html).toContain("label: 'AI · READING ALOUD'");
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
