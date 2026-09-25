import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// `root` serves another copy of a build (a check that publishes a second
// release edits its own copy, never studio/web-build).
export function serveStudio({ port = 4173, host = '127.0.0.1', root = fileURLToPath(new URL('../studio/web-build/', import.meta.url)) } = {}) {
  if (!root.endsWith('/')) root += '/';
  const types = { '.html':'text/html; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.png':'image/png' };
  const server = createServer(async (req,res) => {
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    try {
      let name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(name==='/')name='/index.html';
      const path=resolve(root,`.${name}`);
      if(!path.startsWith(root)||!types[extname(path)])throw Error('not found');
      const data=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);
    } catch { res.writeHead(404);res.end('Not found'); }
  });
  return new Promise(resolve=>server.listen(port,host,()=>resolve(server)));
}
if(process.argv[1]===fileURLToPath(import.meta.url)) { const server=await serveStudio({port:Number(process.env.STUDIO_WEB_PORT??4173)});console.log(`Studio preview: http://127.0.0.1:${server.address().port}`); }
