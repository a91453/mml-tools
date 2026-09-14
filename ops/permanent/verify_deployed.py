"""Verify every HTTP runtime byte against the authorised durable release."""
import concurrent.futures
import hashlib
import json
import pathlib
import sys
import urllib.request

base, output = sys.argv[1:]
lock = json.loads(pathlib.Path(__file__).with_name('release-lock.json').read_text())
def get(path):
    with urllib.request.urlopen(base + path, timeout=30) as response:
        return response.status, response.read(), response.headers.get('Content-Type')

status, raw, _ = get('/health')
health = json.loads(raw)
assert status == 200 and health['buildId'] == lock['buildId'] and health['cacheId'] == lock['cacheId']
assert health['sourceSha'] == lock['sourceSha'] and health['canonical'] == lock['canonical']
status, raw, _ = get('/build.json')
assert status == 200 and hashlib.sha256(raw).hexdigest() == lock['buildJsonSha256']
build = json.loads(raw)
def check(item):
    name, sha = item
    status, raw, mime = get('/' + name)
    assert status == 200 and hashlib.sha256(raw).hexdigest() == sha, name
    return {'path': name, 'status': status, 'sha256': sha, 'bytes': len(raw), 'contentType': mime}

with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    assets = list(pool.map(check, build['files']))
status, index, _ = get('/')
assert status == 200 and hashlib.sha256(index).hexdigest() == dict(build['files'])['index.html']
report = {'base': base, 'health': health, 'root': status, 'buildJson': 200,
          'assetCount': len(assets), 'assets': assets, 'buildJsonSha256': lock['buildJsonSha256']}
pathlib.Path(output).write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'health': health, 'root': status, 'buildJson': 200, 'verifiedAssets': len(assets)}))
