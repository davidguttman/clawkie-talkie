import { describe, expect, it } from 'vitest';
import {
  initialContext,
  reduce,
  type DrivingHydration,
} from '../client/src/voice/drivingReducer';
import { sessionSnapshotReplayPlanFromControlMessage } from '../client/src/voice/drivingLoop';

function snapshotWithPhase(phase: string) {
  return {
    t: 'session.snapshot',
    snapshot: {
      turn: {
        phase,
        transcript: 'partial launch transcript',
      },
    },
    events: [],
  } as const;
}

describe('driving session snapshot hydration', () => {
  it.each(['recording', 'listening', 'stt'])('normalizes a persisted %s snapshot to idle', (phase) => {
    const plan = sessionSnapshotReplayPlanFromControlMessage(snapshotWithPhase(phase));

    expect(plan).not.toBeNull();
    expect(plan?.event.hydration?.context.state).toBe('idle');
    expect(plan?.event.hydration?.context.lastUserText).toBe('');
    expect(plan?.transcript).toEqual({ active: false, sttDone: false, text: '' });
  });

  it('does not replay a launch-time recording snapshot into a stopMic-only stuck thinking path', () => {
    const plan = sessionSnapshotReplayPlanFromControlMessage(snapshotWithPhase('recording'));
    const replayed = reduce(initialContext, plan!.event);

    expect(replayed.next.state).toBe('idle');
    expect(replayed.next.lastUserText).toBe('');
    expect(replayed.side).toEqual([]);

    const afterTap = reduce(replayed.next, { type: 'tap' });
    expect(afterTap.next.state).toBe('recording');
    expect(afterTap.side).toEqual([{ kind: 'startMic' }]);
  });

  it('preserves valid thinking hydration when a final STT replay event exists', () => {
    const plan = sessionSnapshotReplayPlanFromControlMessage({
      t: 'session.snapshot',
      snapshot: { turn: { phase: 'thinking', transcript: 'finished user words' } },
      events: [{ msg: { t: 'stt.done', text: 'finished user words' } }],
    } as const);

    expect(plan?.event.hydration).toEqual<DrivingHydration>({
      context: {
        ...initialContext,
        state: 'thinking',
        lastUserText: 'finished user words',
      },
      armTts: false,
    });
    expect(plan?.transcript).toEqual({ active: true, sttDone: true, text: 'finished user words' });
  });
});
