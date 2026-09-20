// Public, fixed same-origin service workspace assets. No filesystem path from
// a request is resolved; all song/API content remains behind OAuth.
import { readFile } from 'node:fs/promises';

const assets = new Map([
  ['/studio/', ['index.html', 'text/html; charset=utf-8']],
  ['/studio/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/studio/client.mjs', ['client.mjs', 'text/javascript; charset=utf-8']],
  ['/studio/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
export async function studioWebResponse(request) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/studio')) return null;
  if (path === '/studio' || path === '/studio/index.html') return new Response(null, { status: 302, headers: { location: '/studio/', 'cache-control': 'no-store' } });
  const asset = assets.get(path);
  if (!asset) return new Response('Not found', { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  const data = await readFile(new URL(`../studio/web/service/${asset[0]}`, import.meta.url));
  return new Response(request.method === 'HEAD' ? null : data, { headers: {
    'content-type': asset[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  } });
}
