"""Optional authenticated HTTP adapter; does not change any production route.

POST /align body = UTF-8 derived project JSON followed by original audio bytes.
X-Project-Bytes gives the JSON boundary; X-Audio-Format is m4a/flac/wav.
The existing alignment function remains the only audio implementation.
"""
from __future__ import annotations

import hmac
import hashlib
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

MAX_PROJECT_BYTES = 4 * 1024 * 1024
MAX_AUDIO_BYTES = 64 * 1024 * 1024


def create_server(address, *, token, allowed_origin, aligner=None):
    origin = urlparse(allowed_origin)
    if not token or len(token) < 24:
        raise ValueError('Audio Worker requires a token of at least 24 characters')
    if origin.scheme != 'https' or not origin.netloc or origin.path or origin.query or origin.fragment or origin.username:
        raise ValueError('Audio Worker requires an exact HTTPS allowed origin')
    if aligner is None:
        from .alignment import align_audio_to_project
        aligner = align_audio_to_project
    job_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Do not log filenames, payloads, authorization or user data.

        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def respond(self, code, payload=None):
            body = json.dumps(payload or {}).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            if self.headers.get('Origin') == allowed_origin:
                self.send_header('Access-Control-Allow-Origin', allowed_origin)
                self.send_header('Vary', 'Origin')
                self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Project-Bytes, X-Audio-Format')
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.respond(200 if self.path == '/align' and self.headers.get('Origin') == allowed_origin else 403)

        def do_POST(self):
            if self.path != '/align':
                self.respond(404); return
            if self.headers.get('Origin') != allowed_origin or not hmac.compare_digest(self.headers.get('Authorization', ''), f'Bearer {token}'):
                self.respond(403, {'error': 'forbidden'}); return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                project_bytes = int(self.headers.get('X-Project-Bytes', '0'))
                audio_format = self.headers.get('X-Audio-Format')
                if self.headers.get('Transfer-Encoding') or self.headers.get('Content-Type') != 'application/octet-stream':
                    raise ValueError('Unsupported content framing')
                if not (0 < project_bytes <= MAX_PROJECT_BYTES and 0 < length - project_bytes <= MAX_AUDIO_BYTES):
                    self.respond(413, {'error': 'payload limit'}); return
                if audio_format not in {'m4a', 'flac', 'wav'}:
                    raise ValueError('Unsupported audio format')
            except (ValueError, TypeError):
                self.respond(400, {'error': 'invalid request'}); return
            if not job_lock.acquire(blocking=False):
                self.respond(503, {'error': 'worker busy'}); return
            try:
                raw = self.rfile.read(project_bytes)
                project = json.loads(raw)
                if project.get('schema') != 'mabinogi-mobile-mml-studio/canonical-project@2' or not project.get('id') or not isinstance(project.get('events'), list) or not (0 < len(project['events']) <= 30000):
                    raise ValueError('Invalid project')
                with tempfile.TemporaryDirectory(prefix='mml-audio-') as folder:
                    path = Path(folder) / f'input.{audio_format}'
                    remaining = length - project_bytes
                    with path.open('wb') as output:
                        while remaining:
                            chunk = self.rfile.read(min(1024 * 1024, remaining))
                            if not chunk:
                                raise ValueError('Truncated audio')
                            output.write(chunk)
                            remaining -= len(chunk)
                    report = aligner(path, project)
                    report['symbolic']['web_project_sha256'] = hashlib.sha256(raw).hexdigest()
                self.respond(200, report)
            except Exception:
                self.respond(422, {'error': 'alignment failed; symbolic truth unchanged'})
            finally:
                job_lock.release()

    return ThreadingHTTPServer(address, Handler)


if __name__ == '__main__':
    server = create_server(('0.0.0.0', int(os.environ.get('AUDIO_WORKER_PORT', '8789'))), token=os.environ.get('AUDIO_WORKER_TOKEN'), allowed_origin=os.environ.get('AUDIO_WORKER_ORIGIN', ''))
    server.serve_forever()
