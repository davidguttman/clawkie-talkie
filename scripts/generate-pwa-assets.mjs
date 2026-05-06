#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appleTouchIconSizes, iconSizes, maskableIconSizes, splashSizes } from './pwa-assets-meta.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const publicDir = resolve(root, 'client/public');
const iconsDir = resolve(publicDir, 'icons');
const splashDir = resolve(publicDir, 'splash');
const splashSourcePath = resolve(root, 'scripts/pwa-source/clawkie-splash-source.png');

function lobsterGlyph({ x, y, size, showWaves = true, compact = false }) {
  const scale = size / 512;
  const px = (n) => (x + n * scale).toFixed(3);
  const py = (n) => (y + n * scale).toFixed(3);
  const v = (n) => (n * scale).toFixed(3);

  const waves = showWaves
    ? `
      <g fill="none" stroke="#ff2a22" stroke-linecap="round" opacity="0.86">
        <path d="M ${px(126)} ${py(295)} C ${px(94)} ${py(267)}, ${px(94)} ${py(224)}, ${px(126)} ${py(196)}" stroke-width="${v(5)}"/>
        <path d="M ${px(96)} ${py(316)} C ${px(52)} ${py(277)}, ${px(52)} ${py(214)}, ${px(96)} ${py(175)}" stroke-width="${v(4)}" opacity="0.75"/>
        <path d="M ${px(68)} ${py(338)} C ${px(12)} ${py(286)}, ${px(12)} ${py(205)}, ${px(68)} ${py(153)}" stroke-width="${v(3)}" opacity="0.58"/>
        <path d="M ${px(386)} ${py(295)} C ${px(418)} ${py(267)}, ${px(418)} ${py(224)}, ${px(386)} ${py(196)}" stroke-width="${v(5)}"/>
        <path d="M ${px(416)} ${py(316)} C ${px(460)} ${py(277)}, ${px(460)} ${py(214)}, ${px(416)} ${py(175)}" stroke-width="${v(4)}" opacity="0.75"/>
        <path d="M ${px(444)} ${py(338)} C ${px(500)} ${py(286)}, ${px(500)} ${py(205)}, ${px(444)} ${py(153)}" stroke-width="${v(3)}" opacity="0.58"/>
      </g>
      <g fill="#ff3b30" opacity="0.72">
        ${[58, 82, 110, 402, 430, 456].map((cx, i) => `<circle cx="${px(cx)}" cy="${py(238 + (i % 3) * 34)}" r="${v(i % 2 ? 2.4 : 3.4)}"/>`).join('')}
        ${[98, 144, 368, 414].map((cx, i) => `<circle cx="${px(cx)}" cy="${py(350 + (i % 2) * 18)}" r="${v(2.2)}"/>`).join('')}
      </g>`
    : '';

  const sideLegs = compact
    ? ''
    : `
      <g fill="none" stroke="#cf150f" stroke-width="${v(12)}" stroke-linecap="round" stroke-linejoin="round">
        <path d="M ${px(202)} ${py(278)} L ${px(142)} ${py(300)} L ${px(124)} ${py(290)}"/>
        <path d="M ${px(198)} ${py(316)} L ${px(132)} ${py(346)} L ${px(112)} ${py(334)}"/>
        <path d="M ${px(202)} ${py(354)} L ${px(146)} ${py(396)} L ${px(126)} ${py(388)}"/>
        <path d="M ${px(310)} ${py(278)} L ${px(370)} ${py(300)} L ${px(388)} ${py(290)}"/>
        <path d="M ${px(314)} ${py(316)} L ${px(380)} ${py(346)} L ${px(400)} ${py(334)}"/>
        <path d="M ${px(310)} ${py(354)} L ${px(366)} ${py(396)} L ${px(386)} ${py(388)}"/>
      </g>
      <g fill="none" stroke="#ff4a3f" stroke-width="${v(5)}" stroke-linecap="round" opacity="0.65">
        <path d="M ${px(148)} ${py(298)} L ${px(126)} ${py(290)}"/>
        <path d="M ${px(364)} ${py(298)} L ${px(386)} ${py(290)}"/>
      </g>`;

  return `
    <g filter="url(#softShadow)">
      <ellipse cx="${px(256)}" cy="${py(460)}" rx="${v(120)}" ry="${v(24)}" fill="#000000" opacity="0.55"/>
    </g>
    ${waves}
    <g>
      <line x1="${px(256)}" y1="${py(150)}" x2="${px(256)}" y2="${py(54)}" stroke="#050507" stroke-width="${v(20)}" stroke-linecap="round"/>
      <line x1="${px(266)}" y1="${py(145)}" x2="${px(266)}" y2="${py(60)}" stroke="#3c414b" stroke-width="${v(5)}" stroke-linecap="round" opacity="0.7"/>
      <path d="M ${px(238)} ${py(151)} C ${px(214)} ${py(96)}, ${px(182)} ${py(94)}, ${px(170)} ${py(132)}" fill="none" stroke="#f22a20" stroke-width="${v(9)}" stroke-linecap="round"/>
      <path d="M ${px(274)} ${py(151)} C ${px(298)} ${py(96)}, ${px(330)} ${py(94)}, ${px(342)} ${py(132)}" fill="none" stroke="#f22a20" stroke-width="${v(9)}" stroke-linecap="round"/>
      <circle cx="${px(170)}" cy="${py(132)}" r="${v(7)}" fill="#ff4a3f"/>
      <circle cx="${px(342)}" cy="${py(132)}" r="${v(7)}" fill="#ff4a3f"/>

      <g transform="rotate(-23 ${px(170)} ${py(154)})">
        <path d="M ${px(220)} ${py(194)} C ${px(188)} ${py(168)}, ${px(167)} ${py(143)}, ${px(146)} ${py(110)}" fill="none" stroke="#df170f" stroke-width="${v(28)}" stroke-linecap="round"/>
        <path d="M ${px(136)} ${py(64)} C ${px(72)} ${py(86)}, ${px(64)} ${py(174)}, ${px(125)} ${py(199)} C ${px(158)} ${py(213)}, ${px(190)} ${py(193)}, ${px(194)} ${py(154)} C ${px(162)} ${py(168)}, ${px(135)} ${py(150)}, ${px(136)} ${py(64)} Z" fill="url(#clawRed)" stroke="#ff6b5d" stroke-width="${v(6)}"/>
        <path d="M ${px(149)} ${py(82)} C ${px(118)} ${py(116)}, ${px(116)} ${py(158)}, ${px(139)} ${py(174)}" fill="none" stroke="#ffb2aa" stroke-width="${v(5)}" opacity="0.72"/>
        <path d="M ${px(169)} ${py(113)} C ${px(152)} ${py(139)}, ${px(158)} ${py(164)}, ${px(190)} ${py(154)}" fill="none" stroke="#6f0503" stroke-width="${v(7)}" opacity="0.55"/>
      </g>
      <g transform="rotate(23 ${px(342)} ${py(154)}) scale(-1 1) translate(${-2 * (x + 256 * scale)} 0)">
        <path d="M ${px(220)} ${py(194)} C ${px(188)} ${py(168)}, ${px(167)} ${py(143)}, ${px(146)} ${py(110)}" fill="none" stroke="#df170f" stroke-width="${v(28)}" stroke-linecap="round"/>
        <path d="M ${px(136)} ${py(64)} C ${px(72)} ${py(86)}, ${px(64)} ${py(174)}, ${px(125)} ${py(199)} C ${px(158)} ${py(213)}, ${px(190)} ${py(193)}, ${px(194)} ${py(154)} C ${px(162)} ${py(168)}, ${px(135)} ${py(150)}, ${px(136)} ${py(64)} Z" fill="url(#clawRed)" stroke="#ff6b5d" stroke-width="${v(6)}"/>
        <path d="M ${px(149)} ${py(82)} C ${px(118)} ${py(116)}, ${px(116)} ${py(158)}, ${px(139)} ${py(174)}" fill="none" stroke="#ffb2aa" stroke-width="${v(5)}" opacity="0.72"/>
        <path d="M ${px(169)} ${py(113)} C ${px(152)} ${py(139)}, ${px(158)} ${py(164)}, ${px(190)} ${py(154)}" fill="none" stroke="#6f0503" stroke-width="${v(7)}" opacity="0.55"/>
      </g>

      ${sideLegs}

      <path d="M ${px(256)} ${py(140)} C ${px(314)} ${py(140)}, ${px(350)} ${py(198)}, ${px(336)} ${py(296)} C ${px(328)} ${py(358)}, ${px(300)} ${py(412)}, ${px(256)} ${py(432)} C ${px(212)} ${py(412)}, ${px(184)} ${py(358)}, ${px(176)} ${py(296)} C ${px(162)} ${py(198)}, ${px(198)} ${py(140)}, ${px(256)} ${py(140)} Z" fill="url(#shellRed)" stroke="#ff6a60" stroke-width="${v(6)}"/>
      <path d="M ${px(256)} ${py(153)} C ${px(293)} ${py(156)}, ${px(318)} ${py(198)}, ${px(311)} ${py(276)}" fill="none" stroke="#ffbbb5" stroke-width="${v(7)}" opacity="0.45"/>
      <path d="M ${px(196)} ${py(286)} C ${px(225)} ${py(306)}, ${px(287)} ${py(306)}, ${px(316)} ${py(286)}" fill="none" stroke="#8d0804" stroke-width="${v(4)}" opacity="0.55"/>
      <path d="M ${px(204)} ${py(342)} C ${px(232)} ${py(360)}, ${px(280)} ${py(360)}, ${px(308)} ${py(342)}" fill="none" stroke="#8d0804" stroke-width="${v(5)}" opacity="0.6"/>
      <path d="M ${px(214)} ${py(389)} C ${px(238)} ${py(402)}, ${px(274)} ${py(402)}, ${px(298)} ${py(389)}" fill="none" stroke="#8d0804" stroke-width="${v(5)}" opacity="0.55"/>
      <path d="M ${px(214)} ${py(432)} C ${px(224)} ${py(456)}, ${px(288)} ${py(456)}, ${px(298)} ${py(432)}" fill="url(#shellRed)" stroke="#c7110b" stroke-width="${v(5)}"/>

      <circle cx="${px(224)}" cy="${py(154)}" r="${v(22)}" fill="#f8fbff" stroke="#780602" stroke-width="${v(4)}"/>
      <circle cx="${px(288)}" cy="${py(154)}" r="${v(22)}" fill="#f8fbff" stroke="#780602" stroke-width="${v(4)}"/>
      <circle cx="${px(231)}" cy="${py(150)}" r="${v(8)}" fill="#07080b"/>
      <circle cx="${px(295)}" cy="${py(150)}" r="${v(8)}" fill="#07080b"/>
      <circle cx="${px(219)}" cy="${py(145)}" r="${v(4)}" fill="#ffffff"/>
      <circle cx="${px(283)}" cy="${py(145)}" r="${v(4)}" fill="#ffffff"/>

      <circle cx="${px(256)}" cy="${py(252)}" r="${v(40)}" fill="#060609" stroke="#ff6b5d" stroke-width="${v(5)}"/>
      <circle cx="${px(256)}" cy="${py(252)}" r="${v(31)}" fill="url(#pttButton)"/>
      <text x="${px(256)}" y="${py(241)}" fill="#ffffff" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${v(17)}" font-weight="700" text-anchor="middle">PUSH</text>
      <text x="${px(256)}" y="${py(259)}" fill="#ffffff" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${v(15)}" font-weight="700" text-anchor="middle">TO</text>
      <text x="${px(256)}" y="${py(277)}" fill="#ffffff" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${v(17)}" font-weight="700" text-anchor="middle">TALK</text>
    </g>`;
}

function defs() {
  return `
    <defs>
      <radialGradient id="bgGlow" cx="50%" cy="36%" r="72%">
        <stop offset="0" stop-color="#242632"/>
        <stop offset="0.34" stop-color="#090a10"/>
        <stop offset="1" stop-color="#000000"/>
      </radialGradient>
      <radialGradient id="spotlight" cx="50%" cy="0%" r="72%">
        <stop offset="0" stop-color="#dfe5ff" stop-opacity="0.32"/>
        <stop offset="0.28" stop-color="#596070" stop-opacity="0.18"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="shellRed" cx="38%" cy="18%" r="78%">
        <stop offset="0" stop-color="#ff8f83"/>
        <stop offset="0.18" stop-color="#ff2f24"/>
        <stop offset="0.62" stop-color="#d9140d"/>
        <stop offset="1" stop-color="#7b0502"/>
      </radialGradient>
      <radialGradient id="clawRed" cx="35%" cy="20%" r="82%">
        <stop offset="0" stop-color="#ffb3aa"/>
        <stop offset="0.18" stop-color="#ff342a"/>
        <stop offset="0.72" stop-color="#c30d08"/>
        <stop offset="1" stop-color="#650200"/>
      </radialGradient>
      <radialGradient id="pttButton" cx="35%" cy="24%" r="74%">
        <stop offset="0" stop-color="#3b3f46"/>
        <stop offset="0.46" stop-color="#101217"/>
        <stop offset="1" stop-color="#000000"/>
      </radialGradient>
      <filter id="softShadow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="10"/>
      </filter>
      <filter id="redGlow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="3" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>`;
}

function iconSvg(size, { maskable = false } = {}) {
  const safeInset = maskable ? size * 0.16 : size * 0.04;
  const glyphSize = size - safeInset * 2;
  return `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${defs()}
    <rect width="${size}" height="${size}" rx="${maskable ? 0 : Math.round(size * 0.22)}" fill="url(#bgGlow)"/>
    <rect width="${size}" height="${size}" fill="url(#spotlight)"/>
    <circle cx="${size * 0.5}" cy="${size * 0.5}" r="${size * 0.42}" fill="#ff2a22" opacity="0.12"/>
    <g filter="url(#redGlow)">
      ${lobsterGlyph({ x: safeInset, y: safeInset * 0.8, size: glyphSize, showWaves: size >= 96, compact: size < 96 })}
    </g>
  </svg>`;
}


function assertSplashSourceAvailable() {
  if (existsSync(splashSourcePath)) {
    return;
  }

  console.error(
    `Canonical splash source image is missing at ${splashSourcePath}. Restore scripts/pwa-source/clawkie-splash-source.png, then run npm run pwa:assets again.`,
  );
  process.exit(1);
}

function writeSplashPngFromSource(width, height, outputPath) {
  execFileSync(
    'magick',
    [
      splashSourcePath,
      '-auto-orient',
      '-resize',
      `${width}x${height}`,
      '-background',
      '#000000',
      '-gravity',
      'center',
      '-extent',
      `${width}x${height}`,
      '-alpha',
      'remove',
      '-alpha',
      'off',
      outputPath,
    ],
    { stdio: 'inherit' },
  );
}

function assertMagickAvailable() {
  try {
    execFileSync('magick', ['-version'], { stdio: 'ignore' });
  } catch {
    console.error(
      'ImageMagick `magick` is required to generate PWA PNG assets. Install ImageMagick and ensure `magick` is on PATH, then run `npm run pwa:assets` again.',
    );
    process.exit(1);
  }
}

function writePngFromSvg(svg, outputPath) {
  const tempDir = resolve(tmpdir(), `clawkie-pwa-assets-${process.pid}`);
  mkdirSync(tempDir, { recursive: true });
  const svgPath = join(tempDir, `${outputPath.split('/').pop()}.svg`);
  writeFileSync(svgPath, svg);
  try {
    execFileSync('magick', ['-background', 'none', svgPath, outputPath], { stdio: 'inherit' });
  } finally {
    rmSync(svgPath, { force: true });
  }
}

export function generateAssets() {
  // PNG rendering shells out to ImageMagick because Node does not ship an SVG rasterizer.
  assertMagickAvailable();
  assertSplashSourceAvailable();

  mkdirSync(iconsDir, { recursive: true });
  mkdirSync(splashDir, { recursive: true });

  for (const size of iconSizes) {
    writePngFromSvg(iconSvg(size), resolve(iconsDir, `icon-${size}x${size}.png`));
  }

  for (const size of maskableIconSizes) {
    writePngFromSvg(iconSvg(size, { maskable: true }), resolve(iconsDir, `icon-maskable-${size}x${size}.png`));
  }

  copyFileSync(resolve(iconsDir, 'icon-180x180.png'), resolve(iconsDir, 'apple-touch-icon.png'));
  for (const size of appleTouchIconSizes) {
    copyFileSync(resolve(iconsDir, `icon-${size}x${size}.png`), resolve(iconsDir, `apple-touch-icon-${size}x${size}.png`));
  }

  for (const [width, height] of splashSizes) {
    writeSplashPngFromSource(width, height, resolve(splashDir, `apple-splash-${width}-${height}.png`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateAssets();
}
