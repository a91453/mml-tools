// Assemble the single self-contained player page served as the `ui://`
// resource. Everything is inlined -- styles, the MML listening parser, the SF2
// reader, the Studio Web listen-link contract, the player -- so the page makes
// no request of its own. The only possible exception is an operator-configured
// sample library, and then only its one https origin, which the resource
// declares in its CSP metadata.
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

// The one implementation of `mml-studio/listen-link@1`, which the Studio Web
// decodes with; the player encodes its "open here" links through it too.
const LISTEN_LINK_CONTRACT = '../../studio/web/listen-link.mjs';

// The shared modules are ES modules for Node tests. In the page they are
// plain declarations in one module script, so only line-leading `export`
// keywords are removed; anything else module-shaped is refused, not guessed.
function inlineModule(name) {
  const source = read(name);
  if (/^\s*import\s/m.test(source) || /\bimport\s*\(/.test(source)) throw Error(`${name} must not import anything`);
  const stripped = source.replace(/^export\s+(?=(?:async\s+)?(?:const|let|class|function)\b)/gm, '');
  if (/^\s*export\s/m.test(stripped)) throw Error(`${name} uses an export form the widget cannot inline`);
  return stripped;
}

// A module whose private helper names would collide with the player's is
// inlined in its own scope and reached through one frozen namespace.
function inlineScoped(name, namespace, exports) {
  const original = read(name);
  for (const exported of exports) {
    if (!new RegExp(`^export\\s+(?:async\\s+)?(?:const|let|class|function)\\s+${exported}\\b`, 'm').test(original)) throw Error(`${name} no longer exports ${exported}`);
  }
  return `const ${namespace} = (() => {\n${inlineModule(name)}\nreturn Object.freeze({ ${exports.join(', ')} });\n})();\n`;
}

const scriptSafe = text => {
  if (/<\/script/i.test(text) || /<!--/.test(text)) throw Error('inlined script must not contain </script or <!--');
  return text;
};

/**
 * An optional sample library: an https URL prefix ending in `/` under which
 * `<instrument>-mp3.js` files in the widely used MIDI.js soundfont layout
 * live. Unset or invalid means none; nothing in the repository names one.
 */
export function parseSampleLibrary(url, credit = null) {
  if (url === undefined || url === null || String(url).trim() === '') return null;
  let parsed;
  try { parsed = new URL(String(url).trim()); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.endsWith('/')) return null;
  const text = typeof credit === 'string' ? credit.replace(/[\u0000-\u001f\u007f<>]+/g, ' ').trim().slice(0, 200) : '';
  return Object.freeze({ url: parsed.href, origin: parsed.origin, credit: text || parsed.host });
}

export function buildListenWidgetHtml({ samples = null } = {}) {
  const config = JSON.stringify({ version: 1, samples: samples ? { url: samples.url, credit: samples.credit } : null })
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const script = scriptSafe([
    inlineModule('mml-events.mjs'),
    inlineModule('sf2.mjs'),
    inlineScoped(LISTEN_LINK_CONTRACT, 'ListenLink', ['LISTEN_LINK_SCHEMA', 'encodeListenLink', 'listenUrl']),
    read('player-app.js'),
  ].join('\n'));
  const style = read('player.css');
  if (/<\/style/i.test(style)) throw Error('inlined style must not contain </style');
  return read('player.html')
    .replace('/*@STYLE@*/', () => style)
    .replace('/*@CONFIG@*/', () => config)
    .replace('/*@SCRIPT@*/', () => script);
}
