/**
 * wrtc-patch.ts — node-datachannel polyfill with simple-peer compatibility
 *
 * node-datachannel is a Node.js binding for libdatachannel, the same C++ library
 * that the ESP32's esp_peer uses. This gives us native SCTP data channel interop.
 *
 * Problem: simple-peer mutates .sdp on RTCSessionDescription objects returned
 * by createOffer()/createAnswer(). The node-datachannel polyfill stores _sdp
 * in a private WeakMap with getter-only access, so mutation throws.
 *
 * Fix: Override sdp on the prototype with a setter that creates an instance-level
 * property override. The getter still reads from the WeakMap for the initial value;
 * after a set, the instance getter returns the override.
 *
 * @roamhq/wrtc-specific features that are NOT available:
 * - nonstandard.RTCAudioSource (for outbound WebRTC audio tracks)
 * - MediaStream
 *
 * These are already disabled in the daemon (TTS audio goes via data channel,
 * not RTP tracks), so the swap is safe.
 */

import { default as ndcPolyfill } from 'node-datachannel/polyfill';

// --- Patch RTCSessionDescription.sdp to be writable ---

const SDP_PROTO = ndcPolyfill.RTCSessionDescription.prototype;
const sdpDescriptor = Object.getOwnPropertyDescriptor(SDP_PROTO, 'sdp');

if (sdpDescriptor && sdpDescriptor.get && !sdpDescriptor.set) {
  const origGetter = sdpDescriptor.get;

  Object.defineProperty(SDP_PROTO, 'sdp', {
    get() {
      return origGetter.call(this);
    },
    set(val: string) {
      // Override sdp on this specific instance
      Object.defineProperty(this, 'sdp', {
        get() { return val; },
        configurable: true,
        enumerable: true,
      });
    },
    configurable: true,
    enumerable: true,
  });
}

// --- Export the patched polyfill as a wrtc replacement ---

/**
 * Drop-in replacement for `@roamhq/wrtc`.
 *
 * Usage:
 *   import { wrtc } from './wrtc-patch.js';
 *   new SimplePeer({ wrtc, ... })
 *
 * What works:
 * - RTCPeerConnection (ICE, DTLS, SCTP data channels)
 * - RTCSessionDescription (with writable sdp for simple-peer)
 * - RTCIceCandidate
 * - RTCDataChannel + events (onmessage, onopen, onclose, onerror)
 * - Binary data via data channel (sendMessageBinary / peer.send(Uint8Array))
 *
 * What doesn't work (not needed by daemon):
 * - nonstandard.RTCAudioSource (wrtc-specific, not in spec)
 * - MediaStream (wrtc-specific extension)
 * - addTrack / addTransceiver (throws "Not implemented")
 */
export const wrtc = ndcPolyfill as unknown as import('simple-peer').Options['wrtc'];

export default wrtc;