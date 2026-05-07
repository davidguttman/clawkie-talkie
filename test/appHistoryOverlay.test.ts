import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const appSource = readFileSync(resolve(root, 'client/src/app.tsx'), 'utf8');

function requireMatch(source: string, pattern: RegExp, label: string) {
  const match = source.match(pattern);
  expect(match, label).not.toBeNull();
  return match as RegExpMatchArray;
}

function jsxTag(source: string, component: string) {
  const match = source.match(new RegExp(`<${component}\\b[\\s\\S]*?/>`));
  expect(match, `${component} should be rendered from App`).not.toBeNull();
  return match?.[0] ?? '';
}

function appRenderContainer(source: string) {
  const appContent = source.match(/const\s+appContent\s*=\s*\(([\s\S]*?)\);\s*return\s*\(/);
  expect(appContent, 'App should define appContent before returning').not.toBeNull();
  return appContent?.[1] ?? '';
}

function componentSource(source: string, name: string) {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} should be declared`).toBeGreaterThanOrEqual(0);

  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, nextFunction === -1 ? source.length : nextFunction);
}

describe('App History overlay contract', () => {
  it('does not model History as an exclusive ScreenId route', () => {
    const [, screenIdUnion] = requireMatch(
      appSource,
      /type\s+ScreenId\s*=\s*([^;]+);/s,
      'ScreenId union should be declared in App',
    );

    expect(screenIdUnion).not.toMatch(/['"]history['"]/);
  });

  it('does not navigate to History through the base screen router', () => {
    expect(appSource).not.toMatch(/\bgo\s*\(\s*['"]history['"]\s*\)/);
  });

  it('keeps DashboardScreen wired with an onHistory callback backed by overlay state', () => {
    const dashboardScreen = jsxTag(appSource, 'DashboardScreen');
    const drivingScreen = jsxTag(appSource, 'DrivingScreen');

    expect(appSource).toMatch(/\bconst\s+\[historyOpen,\s*setHistoryOpen\]\s*=\s*useState\(false\)/);
    expect(dashboardScreen).toMatch(/\bonHistory=\{openHistory\}/);
    expect(drivingScreen).not.toMatch(/\bonHistory=/);
    expect(appSource).toMatch(/const\s+openHistory\s*=\s*useCallback\(\(\)\s*=>\s*\{\s*setSettingsOpen\(false\);\s*setHistoryOpen\(true\);/s);
  });

  it('renders the base screen content before the History overlay without remount keys', () => {
    const renderContainer = appRenderContainer(appSource);
    const screenContentIndex = renderContainer.indexOf('screenContent');
    const historyOverlayIndex = renderContainer.search(/historyOpen|HistoryOverlay|HistoryScreen/);

    expect(screenContentIndex).toBeGreaterThanOrEqual(0);
    expect(historyOverlayIndex).toBeGreaterThan(screenContentIndex);
    expect(appSource).not.toMatch(/\bkey\s*=\s*\{\s*(screen|historyOpen)\s*\}/);
  });

  it('isolates base content whenever Settings or History is open', () => {
    expect(appSource).toMatch(/const\s+overlayOpen\s*=\s*settingsOpen\s*\|\|\s*historyOpen;/);
    expect(appSource).toMatch(
      /const\s+baseContentIsolationProps:\s*\{\s*['"]aria-hidden['"]\?:\s*true;\s*inert\?:\s*['"]{2}\s*\}\s*=\s*overlayOpen\s*\?\s*\{\s*['"]aria-hidden['"]:\s*true,\s*inert:\s*['"]{2}\s*\}/,
    );
  });

  it('defines a HistoryOverlay shell with dialog accessibility attributes', () => {
    const overlay = componentSource(appSource, 'HistoryOverlay');

    expect(overlay).toMatch(/position:\s*['"]absolute['"]/);
    expect(overlay).toMatch(/inset:\s*0/);
    expect(overlay).toMatch(/<HistoryScreen\b/);
    expect(overlay).toMatch(/role=["']dialog["']/);
    expect(overlay).toMatch(/aria-modal=["']true["']/);
    expect(overlay).toMatch(/aria-label=["']History["']/);
    expect(overlay).toMatch(/tabIndex=\{-1\}/);
    expect(overlay).toMatch(/dialogRef\.current\?\.focus\(\)/);
    expect(overlay).toMatch(/background:\s*HIFI\.bg/);
  });

  it('preserves History back and session selection behavior', () => {
    const historyScreen = jsxTag(appSource, 'HistoryScreen');
    const appContent = appRenderContainer(appSource);

    expect(historyScreen).toMatch(/\bonBack=\{onClose\}/);
    expect(appContent).toMatch(/onClose=\{\(\)\s*=>\s*setHistoryOpen\(false\)\}/);
    expect(appContent).toMatch(/setHistoryOpen\(false\);[\s\S]*setOpenSession\(sessionId\);[\s\S]*go\('transcript'\);/);
  });

  it('captures Escape on History overlay without routing back through Driving', () => {
    const overlay = componentSource(appSource, 'HistoryOverlay');
    const escapeIndex = overlay.indexOf("event.key === 'Escape'");
    const closeIndex = overlay.indexOf('onClose()', escapeIndex);

    expect(escapeIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(escapeIndex);
    expect(overlay).not.toMatch(/\bgo\s*\(\s*['"]driving['"]\s*\)/);
  });
});
