import type { Plugin } from 'vite';
import { appleSplashScreens, appleTouchIconSizes } from '../../scripts/pwa-assets-meta.mjs';

const PWA_HEAD_MARKER = '<!-- clawkie-pwa-head -->';
const PWA_SW_MARKER = '<!-- clawkie-pwa-sw -->';

export const serviceWorkerRegistrationScript = `(function () {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker
      .register('/sw.js')
      .catch(function (err) {
        console.warn('[SW] Registration failed:', err);
      });
  });
})();`;

function renderTag(tag: string, attrs: Record<string, string>): string {
  const renderedAttrs = Object.entries(attrs)
    .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
    .join(' ');
  return `<${tag} ${renderedAttrs} />`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

export function renderPwaHeadHtml(): string {
  const tags = [
    PWA_HEAD_MARKER,
    renderTag('meta', { name: 'theme-color', content: '#0a0a0b' }),
    renderTag('meta', { name: 'color-scheme', content: 'dark' }),
    renderTag('meta', { name: 'mobile-web-app-capable', content: 'yes' }),
    renderTag('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }),
    renderTag('meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' }),
    renderTag('meta', { name: 'apple-mobile-web-app-title', content: 'Clawkie' }),
    renderTag('meta', { name: 'application-name', content: 'Clawkie-Talkie' }),
    renderTag('meta', { name: 'format-detection', content: 'telephone=no' }),
    renderTag('link', { rel: 'manifest', href: '/manifest.json' }),
    renderTag('link', { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/icons/icon-16x16.png' }),
    renderTag('link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/icons/icon-32x32.png' }),
    renderTag('link', { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/icons/icon-192x192.png' }),
    renderTag('link', { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' }),
    ...appleTouchIconSizes.map((size) => renderTag('link', {
      rel: 'apple-touch-icon',
      sizes: `${size}x${size}`,
      href: `/icons/apple-touch-icon-${size}x${size}.png`,
    })),
    '<!-- Apple Splash Screens -->',
    ...appleSplashScreens.flatMap((screen, index) => [
      index % 2 === 0 ? `<!-- ${screen.label} (${screen.width}x${screen.height}) -->` : '',
      renderTag('link', {
        rel: 'apple-touch-startup-image',
        href: `/splash/apple-splash-${screen.width}-${screen.height}.png`,
        media: screen.media,
      }),
    ]).filter(Boolean),
  ];

  return tags.join('\n    ');
}

export function renderPwaServiceWorkerHtml(): string {
  return `${PWA_SW_MARKER}\n    <script>\n      ${serviceWorkerRegistrationScript.replaceAll('\n', '\n      ')}\n    </script>`;
}

export function injectPwaHtml(html: string): string {
  let output = html;

  if (!output.includes(PWA_HEAD_MARKER)) {
    output = output.replace(/<\/head>/i, `    ${renderPwaHeadHtml()}\n  </head>`);
  }

  if (!output.includes(PWA_SW_MARKER)) {
    output = output.replace(/<\/body>/i, `    ${renderPwaServiceWorkerHtml()}\n  </body>`);
  }

  return output;
}

export function pwaHtmlPlugin(): Plugin {
  return {
    name: 'clawkie-pwa-html',
    enforce: 'post',
    transformIndexHtml(html) {
      return injectPwaHtml(html);
    },
  };
}
