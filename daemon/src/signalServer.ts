// The hosted rambly-style signaling broker the daemon talks to. Not user
// configurable — runtime always uses this default. Internal callers may
// still pass a different value when wiring tests/internal harnesses.
export const DEFAULT_SIGNAL_SERVER = 'https://api.rambly.app';
