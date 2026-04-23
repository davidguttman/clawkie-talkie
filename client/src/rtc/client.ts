// Browser WebRTC client: phone is the initiator — creates the offer and
// opens the `ct-control` DataChannel the daemon receives. One ordered
// reliable channel carries both JSON control frames and binary PCM16
// audio for STT streaming.

import { RendezvousClient } from './signaling';

export type RtcStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed';

export interface ControlMessage {
  t: string;
  [key: string]: unknown;
}

export interface RtcClientOptions {
  rendezvousUrl: string;
  token: string;
  iceServers?: RTCIceServer[];
  onStatusChange?: (status: RtcStatus, detail?: string) => void;
  onControlMessage?: (msg: ControlMessage) => void;
}

interface Signal {
  type: 'offer' | 'answer' | 'candidate';
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

export class RtcClient {
  private readonly pc: RTCPeerConnection;
  private readonly channel: RTCDataChannel;
  private readonly signaler: RendezvousClient;
  private readonly selfId = crypto.randomUUID();
  private status: RtcStatus = 'idle';
  private startedOffer = false;
  private closed = false;

  constructor(private readonly opts: RtcClientOptions) {
    this.pc = new RTCPeerConnection({
      iceServers: opts.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    this.channel = this.pc.createDataChannel('ct-control', { ordered: true });
    this.channel.binaryType = 'arraybuffer';
    this.bindChannel();

    this.pc.onicecandidate = async (event) => {
      if (event.candidate) {
        try {
          await this.signaler.sendSignal({
            type: 'candidate',
            candidate: event.candidate.toJSON(),
          } satisfies Signal);
        } catch (err) {
          console.error('[rtc] signal candidate failed', err);
        }
      }
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'connected') {
        // DataChannel open state is the real signal — wait for that.
      } else if (s === 'failed') {
        this.setStatus('error', 'ice_failed');
      } else if (s === 'closed') {
        this.setStatus('closed');
      }
    };

    this.signaler = new RendezvousClient(opts.rendezvousUrl, opts.token, this.selfId);
  }

  connect(): void {
    if (this.closed) return;
    this.setStatus('connecting');
    this.signaler.subscribe(
      (msg) => this.onSse(msg),
      (err) => this.setStatus('error', `signaling:${err.message}`),
    );
  }

  sendControl(msg: ControlMessage): void {
    if (this.channel.readyState !== 'open') return;
    try {
      this.channel.send(JSON.stringify(msg));
    } catch {
      // channel may have just closed — onclose will fire
    }
  }

  sendBinary(bytes: ArrayBuffer | Uint8Array): void {
    if (this.channel.readyState !== 'open') return;
    try {
      if (bytes instanceof ArrayBuffer) this.channel.send(bytes);
      else this.channel.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    } catch {
      // ignore
    }
  }

  get currentStatus(): RtcStatus {
    return this.status;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.channel.close();
    } catch {
      // ignore
    }
    try {
      this.pc.close();
    } catch {
      // ignore
    }
    this.signaler.close();
    this.setStatus('closed');
  }

  private bindChannel(): void {
    this.channel.onopen = () => this.setStatus('open');
    this.channel.onclose = () => {
      if (!this.closed) this.setStatus('closed');
    };
    this.channel.onerror = () => this.setStatus('error', 'datachannel_error');
    this.channel.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let msg: ControlMessage;
      try {
        msg = JSON.parse(ev.data) as ControlMessage;
      } catch {
        return;
      }
      this.opts.onControlMessage?.(msg);
    };
  }

  private onSse(msg: { event: string; data: { id?: string; from?: string; data?: unknown } }): void {
    const { event, data } = msg;
    if (event === 'peer-present' || event === 'peer-joined') {
      void this.startOffer();
      return;
    }
    if (event === 'signal') {
      const sig = data.data as Signal | undefined;
      if (!sig) return;
      if (sig.type === 'answer' && sig.sdp) {
        void this.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp }).catch((err) => {
          console.error('[rtc] setRemoteDescription failed', err);
        });
      } else if (sig.type === 'candidate' && sig.candidate) {
        void this.pc.addIceCandidate(sig.candidate).catch(() => {
          // non-fatal: some candidates arrive after the peer is closed
        });
      }
    }
  }

  private async startOffer(): Promise<void> {
    if (this.startedOffer || this.closed) return;
    this.startedOffer = true;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await this.signaler.sendSignal({ type: 'offer', sdp: offer.sdp } satisfies Signal);
    } catch (err) {
      this.setStatus('error', err instanceof Error ? `offer:${err.message}` : 'offer_failed');
    }
  }

  private setStatus(status: RtcStatus, detail?: string): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatusChange?.(status, detail);
  }
}
