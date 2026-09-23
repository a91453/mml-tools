"""Render the Railway function with an out-of-band pinned release lock and trust ZIP."""
import base64
import hashlib
import json
import pathlib
import sys

here = pathlib.Path(__file__).resolve().parent
assets, output = map(pathlib.Path, sys.argv[1:])
lock = json.loads((here / 'release-lock.json').read_text())
trust = (assets / lock['trust']['filename']).read_bytes()
assert hashlib.sha256(trust).hexdigest() == lock['trust']['sha256']
source = (here / 'bootstrap.mjs').read_text()
source += '\nconst LOCK = ' + json.dumps(lock, separators=(',', ':')) + ';\n'
source += 'const TRUST_ZIP = Buffer.from(' + json.dumps(base64.b64encode(trust).decode()) + ', "base64");\n'
# The rendered source is carried into Railway by hand (a Function's code is a
# string, not a file upload), so it proves its own integrity before anything
# else runs: it hashes the file it was started from, with its own digest
# blanked, and exits fail-closed on any difference. A copy error can then only
# keep the previous deployment serving; it can never start altered code.
PLACEHOLDER = "__RENDERED_SOURCE_SHA256__"
source += '''
const RENDERED_SOURCE_SHA256 = '__RENDERED_SOURCE_SHA256__';
{
  const own = await Bun.file(Bun.main).text();
  const unsigned = own.replace(`= '${RENDERED_SOURCE_SHA256}';`, "= '" + "__RENDERED_SOURCE_" + "SHA256__';");
  if (createHash('sha256').update(unsigned).digest('hex') !== RENDERED_SOURCE_SHA256) {
    console.error(JSON.stringify({ event: 'RENDERED_SOURCE_MISMATCH', time: new Date().toISOString() }));
    process.exit(1);
  }
  console.log(JSON.stringify({ event: 'RENDERED_SOURCE_VERIFIED', sha256: RENDERED_SOURCE_SHA256, time: new Date().toISOString() }));
}
try {
  await bootstrapStudio({
    lock: LOCK, trustZip: TRUST_ZIP,
    cacheRoot: process.env.CACHE_DIR || '/studio-cache',
    port: Number(process.env.PORT || 8080),
    recoverCorrupt: process.env.RELEASE_RECOVER_CORRUPT === '1',
    fetchArchive: async pin => {
      if (process.env.RELEASE_OFFLINE_ONLY === '1') throw Error('Refetch disabled for cached-start proof');
      const names = ['RELEASE_S3_ENDPOINT', 'RELEASE_S3_BUCKET', 'RELEASE_S3_REGION', 'RELEASE_S3_ACCESS_KEY_ID', 'RELEASE_S3_SECRET_ACCESS_KEY'];
      if (names.some(name => !process.env[name])) throw Error('Durable bucket configuration incomplete');
      const client = new Bun.S3Client({
        endpoint: process.env.RELEASE_S3_ENDPOINT, bucket: process.env.RELEASE_S3_BUCKET,
        region: process.env.RELEASE_S3_REGION, accessKeyId: process.env.RELEASE_S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.RELEASE_S3_SECRET_ACCESS_KEY,
      });
      const bytes = await client.file(pin.objectKey).arrayBuffer();
      return Buffer.from(bytes);
    },
  });
} catch { process.exitCode = 1; }
'''
assert 'PREVIEW_URL' not in source and 'fixedsha-production' not in source
assert source.count(f"= '{PLACEHOLDER}';") == 1
source = source.replace(f"= '{PLACEHOLDER}';", f"= '{hashlib.sha256(source.encode()).hexdigest()}';", 1)
output.write_text(source)
print(json.dumps({'output': str(output), 'bytes': len(source.encode()), 'sha256': hashlib.sha256(source.encode()).hexdigest(), 'trustSourceSha': lock['trust']['sourceSha']}))
