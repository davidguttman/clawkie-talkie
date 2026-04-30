import { describe, expect, it } from 'vitest';
import {
  computeIsNarrow,
  NARROW_WIDTH_PX,
  type ResponsiveWindow,
} from '../client/src/responsive';

function mockWindow(opts: {
  innerWidth: number;
  coarsePointer?: boolean;
  hasMatchMedia?: boolean;
}): ResponsiveWindow {
  const { innerWidth, coarsePointer = false, hasMatchMedia = true } = opts;
  if (!hasMatchMedia) {
    return { innerWidth } as ResponsiveWindow;
  }
  return {
    innerWidth,
    matchMedia: ((query: string) => ({
      matches: query.includes('pointer: coarse') ? coarsePointer : false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as Window['matchMedia'],
  };
}

describe('computeIsNarrow', () => {
  it('uses the width breakpoint on desktop (no coarse pointer)', () => {
    expect(computeIsNarrow(mockWindow({ innerWidth: NARROW_WIDTH_PX - 1 }))).toBe(true);
    expect(computeIsNarrow(mockWindow({ innerWidth: NARROW_WIDTH_PX }))).toBe(false);
    expect(computeIsNarrow(mockWindow({ innerWidth: 1440 }))).toBe(false);
  });

  it('classifies coarse-pointer devices as narrow regardless of width', () => {
    // iPhone Pro Max landscape ~932 CSS px exceeds the 900 breakpoint, but
    // we must not flip layouts on rotation: that remounts DrivingScreen and
    // kills the in-flight recording/STT session.
    expect(
      computeIsNarrow(mockWindow({ innerWidth: 932, coarsePointer: true })),
    ).toBe(true);
    expect(
      computeIsNarrow(mockWindow({ innerWidth: 430, coarsePointer: true })),
    ).toBe(true);
    expect(
      computeIsNarrow(mockWindow({ innerWidth: 1200, coarsePointer: true })),
    ).toBe(true);
  });

  it('does not flip when a coarse-pointer device rotates across the breakpoint', () => {
    const portrait = mockWindow({ innerWidth: 430, coarsePointer: true });
    const landscape = mockWindow({ innerWidth: 932, coarsePointer: true });
    expect(computeIsNarrow(portrait)).toBe(computeIsNarrow(landscape));
  });

  it('falls back to width when matchMedia is unavailable', () => {
    expect(
      computeIsNarrow(mockWindow({ innerWidth: 500, hasMatchMedia: false })),
    ).toBe(true);
    expect(
      computeIsNarrow(mockWindow({ innerWidth: 1200, hasMatchMedia: false })),
    ).toBe(false);
  });
});
