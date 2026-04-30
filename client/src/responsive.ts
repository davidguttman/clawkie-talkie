// Layout classification used to choose between the narrow (mobile/runtime)
// shell and the desktop phone-frame shell. Must be stable across orientation
// changes on mobile devices — otherwise rotating the phone remounts the
// active screen and tears down the in-flight recording / RTC session.

export type ResponsiveWindow = Pick<Window, 'innerWidth'> & {
  matchMedia?: Window['matchMedia'];
};

export const NARROW_WIDTH_PX = 900;

export function computeIsNarrow(win?: ResponsiveWindow): boolean {
  const w = win ?? (typeof window !== 'undefined' ? window : undefined);
  if (!w) return false;
  if (typeof w.matchMedia === 'function') {
    // Touch devices always get the narrow runtime shell, regardless of
    // orientation. A phone in landscape can exceed the width breakpoint
    // (e.g. iPhone Pro Max ~932 CSS px), and crossing the breakpoint would
    // otherwise swap the runtime wrapper and remount DrivingScreen, which
    // cancels the active STT/recording.
    if (w.matchMedia('(pointer: coarse)').matches) return true;
  }
  return w.innerWidth < NARROW_WIDTH_PX;
}
