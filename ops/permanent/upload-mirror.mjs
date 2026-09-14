// One-time transfer helper. Run only in the isolated service, then replace it
// with the durable bootstrap. It never writes the service volume or serves code.
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(value).digest('hex');
const tokenHash = process.env.RELEASE_UPLOAD_TOKEN_HASH;
if (!/^[a-f0-9]{64}$/.test(tokenHash ?? '')) throw Error('Upload authentication missing');
const client = new Bun.S3Client({ endpoint: process.env.RELEASE_S3_ENDPOINT,
  bucket: process.env.RELEASE_S3_BUCKET, region: process.env.RELEASE_S3_REGION,
  accessKeyId: process.env.RELEASE_S3_ACCESS_KEY_ID, secretAccessKey: process.env.RELEASE_S3_SECRET_ACCESS_KEY });
// RELEASE_LOCK is appended by the deployment renderer from release-lock.json.
const pins = new Map([RELEASE_LOCK.artifact, RELEASE_LOCK.trust].map(pin => [pin.filename, pin]));
Bun.serve({ port: Number(process.env.PORT || 8080), maxRequestBodySize: 1024 * 1024,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/health') return Response.json({ status: 'upload-helper-ready' });
    if (req.method !== 'POST' || digest((req.headers.get('authorization') || '').replace(/^Bearer /, '')) !== tokenHash) return new Response('Unauthorized', { status: 401 });
    const pin = pins.get(path.slice('/assets/'.length));
    if (!path.startsWith('/assets/') || !pin) return new Response('Unknown asset', { status: 404 });
    try {
      const bytes = Buffer.from(await req.arrayBuffer());
      if (bytes.length !== pin.bytes || digest(bytes) !== pin.sha256) return new Response('Digest rejected', { status: 422 });
      const object = client.file(pin.objectKey);
      let uploaded = false;
      if (await object.exists()) {
        if (digest(Buffer.from(await object.arrayBuffer())) !== pin.sha256) return new Response('Refusing to overwrite existing object', { status: 409 });
      } else { await object.write(bytes, { type: 'application/zip' }); uploaded = true; }
      const received = Buffer.from(await object.arrayBuffer());
      if (received.length !== pin.bytes || digest(received) !== pin.sha256) throw Error('Durable readback digest failed');
      console.log(JSON.stringify({ event: 'DURABLE_MIRROR_VERIFIED', objectKey: pin.objectKey, sha256: pin.sha256, bytes: received.length, uploaded }));
      return Response.json({ status: 'DURABLE_MIRROR_VERIFIED', objectKey: pin.objectKey, sha256: pin.sha256, bytes: received.length, uploaded });
    } catch (error) { console.error('Mirror transfer failed', error.name); return new Response('Mirror transfer failed', { status: 500 }); }
  }
});
