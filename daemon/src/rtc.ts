// Daemon-side WebRTC peer. Answerer role — phone creates the offer and
// the `ct-control` DataChannel; daemon answers.
//
// `@roamhq/wrtc` exposes the exact browser RTCPeerConnection API so
// setLocalDescription / setRemoteDescription / addIceCandidate /
// ondatachannel semantics match what the phone-side client does.

import wrtc from '@roamhq/wrtc';
import type { XaiSttSession } from './sttSession.js';

const { RTCPeerConnection } = wrtc as unknown as {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection;
};

export interface DaemonRtcOptions {
  iceServers?: RTCIceServer[];
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  openSttSession: (send: (msg: string | Uint8Array) => void) => XaiSttSession;
}

type ControlMessageIn =
  | { t: 'stt.start' }
  | { t: 'stt.audio.done' }
  | { t: 'stt.cancel' };

export class DaemonPeer {
  private readonly pc: RTCPeerConnection;
  private control: RTCDataChannel | null = null;
  private sttSession: XaiSttSession | null = null;

  constructor(private readonly opts: DaemonRtcOptions) {
    this.pc = new RTCPeerConnection({
      iceServers: opts.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) opts.onIceCandidate(ev.candidate.toJSON());
    };

    this.pc.onconnectionstatechange = () => {
      opts.onConnectionStateChange?.(this.pc.connectionState);
    };

    this.pc.ondatachannel = (ev) => {
      if (ev.channel.label !== 'ct-control') return;
      this.bindControl(ev.channel);
    };
  }

  async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    const local = this.pc.localDescription;
    if (!local) throw new Error('no local description after setLocalDescription');
    return { type: local.type, sdp: local.sdp };
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      console.error('[daemon] addIceCandidate failed:', err);
    }
  }

  close(): void {
    this.sttSession?.close();
    try {
      this.pc.close();
    } catch {
      // already closed
    }
  }

  private bindControl(channel: RTCDataChannel): void {
    this.control = channel;
    channel.binaryType = 'arraybuffer';

    const send = (msg: string | Uint8Array) => {
      if (channel.readyState !== 'open') return;
      try {
        if (typeof msg === 'string') {
          channel.send(msg);
        } else {
          // `@roamhq/wrtc`'s RTCDataChannel.send typing wants an
          // `ArrayBufferView<ArrayBuffer>`, not a generic Uint8Array
          // that could sit atop a SharedArrayBufferLike. Copy into a
          // fresh ArrayBuffer-backed view so the overload matches.
          const backing = new ArrayBuffer(msg.byteLength);
          const view = new Uint8Array(backing);
          view.set(msg);
          channel.send(view);
        }
      } catch {
        // channel closed — downstream events will surface it
      }
    };

    channel.onopen = () => {
      console.error('[daemon] ct-control open');
    };

    channel.onclose = () => {
      console.error('[daemon] ct-control closed');
      this.sttSession?.close();
      this.sttSession = null;
    };

    channel.onerror = (ev) => {
      const err = (ev as unknown as { error?: Error }).error;
      console.error('[daemon] ct-control error:', err?.message || ev);
    };

    channel.onmessage = (ev: MessageEvent) => {
      const data = ev.data;

      if (typeof data === 'string') {
        let msg: ControlMessageIn;
        try {
          msg = JSON.parse(data) as ControlMessageIn;
        } catch {
          return;
        }
        if (msg.t === 'stt.start') {
          this.sttSession?.close();
          this.sttSession = this.opts.openSttSession(send);
          return;
        }
        if (msg.t === 'stt.audio.done') {
          this.sttSession?.signalAudioDone();
          return;
        }
        if (msg.t === 'stt.cancel') {
          this.sttSession?.close();
          this.sttSession = null;
          return;
        }
        return;
      }

      // Binary: PCM16 audio from the phone mic. Forward raw.
      if (!this.sttSession) return;
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : null;
      if (bytes) this.sttSession.sendAudio(bytes);
    };
  }
}
