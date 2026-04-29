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
  if (appContent) return appContent[1];

  return requireMatch(
    source,
    /<ResponsiveRuntime\b[^>]*>([\s\S]*?)<\/ResponsiveRuntime>/,
    'App should render content inside ResponsiveRuntime',
  )[1];
}

function componentSource(source: string, name: string) {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} should be declared`).toBeGreaterThanOrEqual(0);

  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, nextFunction === -1 ? source.length : nextFunction);
}

describe('App Settings overlay contract', () => {
  it('does not model Settings as an exclusive ScreenId route', () => {
    const [, screenIdUnion] = requireMatch(
      appSource,
      /type\s+ScreenId\s*=\s*([^;]+);/s,
      'ScreenId union should be declared in App',
    );

    expect(screenIdUnion).not.toMatch(/['"]settings['"]/);
  });

  it('does not navigate to Settings through the base screen router', () => {
    expect(appSource).not.toMatch(/\bgo\s*\(\s*['"]settings['"]\s*\)/);
  });

  it('keeps DrivingScreen wired with an onSettings callback', () => {
    const drivingScreen = jsxTag(appSource, 'DrivingScreen');

    expect(drivingScreen).toMatch(/\bonSettings\s*=\s*\{/);
  });

  it('renders Settings from overlay state instead of a screen branch', () => {
    expect(appSource).not.toMatch(/\bscreen\s*={2,3}\s*['"]settings['"]/);
    expect(appSource).toMatch(/\bsettingsOpen\b/);
    expect(appSource).toMatch(/\bsetSettingsOpen\b/);

    const settingsScreen = jsxTag(appSource, 'SettingsScreen');
    expect(settingsScreen).toMatch(/\bonBack\s*=\s*\{[^}]*setSettingsOpen\s*\(\s*false\s*\)/s);
  });

  it('renders the base screen content before the Settings overlay without remount keys', () => {
    const renderContainer = appRenderContainer(appSource);
    const screenContentIndex = renderContainer.indexOf('screenContent');
    const settingsOverlayIndex = renderContainer.search(
      /settingsOpen|SettingsOverlay|SettingsScreen/,
    );

    expect(screenContentIndex).toBeGreaterThanOrEqual(0);
    expect(settingsOverlayIndex).toBeGreaterThan(screenContentIndex);
    expect(appSource).not.toMatch(/\bkey\s*=\s*\{\s*(screen|settingsOpen)\s*\}/);
    expect(appSource).not.toMatch(
      /settingsOpen[\s\S]{0,240}\?\s*<DrivingScreen\b|<DrivingScreen\b[\s\S]{0,240}:\s*null[\s\S]{0,240}settingsOpen/,
    );
  });

  it('contains the overlay inside a positioned full-height App content stack', () => {
    const renderContainer = appRenderContainer(appSource);

    expect(renderContainer).toMatch(/position:\s*['"]relative['"]/);
    expect(renderContainer).toMatch(/height:\s*['"]100%['"]/);
    expect(renderContainer).toMatch(/minHeight:\s*0/);
    expect(renderContainer).toMatch(/overflow:\s*['"]hidden['"]/);
    expect(renderContainer).toMatch(/\{\.\.\.baseContentIsolationProps\}/);
    expect(appSource).toMatch(
      /const\s+baseContentIsolationProps:\s*\{\s*['"]aria-hidden['"]\?:\s*true;\s*inert\?:\s*['"]{2}\s*\}\s*=\s*settingsOpen\s*\?\s*\{\s*['"]aria-hidden['"]:\s*true,\s*inert:\s*['"]{2}\s*\}/,
    );
  });

  it('defines a SettingsOverlay shell with dialog accessibility attributes', () => {
    const overlay = componentSource(appSource, 'SettingsOverlay');

    expect(overlay).toMatch(/position:\s*['"]absolute['"]/);
    expect(overlay).toMatch(/inset:\s*0/);
    expect(overlay).toMatch(/<SettingsScreen\b/);
    expect(overlay).toMatch(/role=["']dialog["']/);
    expect(overlay).toMatch(/aria-modal=["']true["']/);
    expect(overlay).toMatch(/aria-label=["']Settings["']/);
    expect(overlay).toMatch(/tabIndex=\{-1\}/);
    expect(overlay).toMatch(/dialogRef\.current\?\.focus\(\)/);
  });

  it('captures scrim input without closing or forwarding through to the base screen', () => {
    const overlay = componentSource(appSource, 'SettingsOverlay');
    const [, scrim] = requireMatch(
      overlay,
      /(<div\b[\s\S]*?aria-hidden=["']true["'][\s\S]*?\/>)/,
      'SettingsOverlay should include an inert scrim/backdrop',
    );

    expect(scrim).toMatch(/\bonClick=\{\(\)\s*=>\s*undefined\}/);
    expect(scrim).toMatch(/\bonPointerDown=\{\(\)\s*=>\s*undefined\}/);
    expect(scrim).toMatch(/\bonTouchStart=\{\(\)\s*=>\s*undefined\}/);
    expect(scrim).toMatch(/pointerEvents:\s*['"]auto['"]/);
    expect(scrim).toMatch(/touchAction:\s*['"]none['"]/);
    expect(scrim).not.toMatch(/setSettingsOpen\s*\(\s*false\s*\)/);
    expect(scrim).not.toMatch(/\bgo\s*\(/);
  });

  it('keeps Escape close local to Settings overlay state', () => {
    const overlay = componentSource(appSource, 'SettingsOverlay');
    const escapeIndex = overlay.indexOf("event.key === 'Escape'");
    const closeIndex = overlay.indexOf('setSettingsOpen(false)', escapeIndex);

    expect(escapeIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(escapeIndex);
    expect(overlay).not.toMatch(/\bgo\s*\(\s*['"]driving['"]\s*\)/);
  });

  it('does not put voice or media teardown calls on the App-level Settings path', () => {
    expect(appSource).not.toMatch(/\bstopMediaSessionKeeper\b/);
    expect(appSource).not.toMatch(/\bstopHoldMusic\b/);
    expect(appSource).not.toMatch(/\bstt\s*\.\s*cancel\b/);
    expect(appSource).not.toMatch(/\breply\s*\.\s*cancel\b/);
    expect(appSource).not.toMatch(/\bcancel(Stt|STT|Reply|Tts|TTS)\b/);
    expect(appSource).not.toMatch(/\bstop(Tts|TTS|HoldMusic|MediaSession)\b/);
  });
});
