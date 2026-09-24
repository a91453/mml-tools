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
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

MAX_PROJECT_BYTES = 4 * 1024 * 1024
MAX_AUDIO_BYTES = 64 * 1024 * 1024
MAX_BODY_BYTES = MAX_PROJECT_BYTES + MAX_AUDIO_BYTES
READ_CHUNK_BYTES = 1024 * 1024
# The server speaks HTTP/1.0 and closes after each reply. Closing with unread
# upload bytes resets the connection, so the client never sees an early error
# reply. Rejected authenticated uploads within MAX_BODY_BYTES are drained first;
# unauthenticated ones get at most this small, time-bounded read; oversized or
# unframed bodies are never read and the reply says Connection: close.
UNAUTHENTICATED_DRAIN_BYTES = 64 * 1024
UNAUTHENTICATED_DRAIN_SECONDS = 2.0


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

        def respond(self, code, payload=None, *, close=False):
            body = json.dumps(payload or {}).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            if close:
                self.send_header('Connection', 'close')
            if self.headers.get('Origin') == allowed_origin:
                self.send_header('Access-Control-Allow-Origin', allowed_origin)
                self.send_header('Vary', 'Origin')
                self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Project-Bytes, X-Audio-Format')
            self.end_headers()
            self.wfile.write(body)

        def content_length(self):
            """Declared body size when the body is plainly length-delimited, else None."""
            if self.headers.get('Transfer-Encoding'):
                return None
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                return None
            return length if length >= 0 else None

        def drain(self, count, *, seconds=None):
            """Read and discard up to count body bytes in bounded chunks."""
            deadline = None if seconds is None else time.monotonic() + seconds
            try:
                while count > 0:
                    if deadline is not None:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            return
                        self.connection.settimeout(remaining)
                    chunk = self.rfile.read1(min(READ_CHUNK_BYTES, count))
                    if not chunk:
                        return
                    count -= len(chunk)
            except OSError:
                pass  # Stalled or reset client: nothing more to read before closing.

        def reject(self, code, payload, unread):
            """Reply after consuming the rest of an in-limit upload, else close unread."""
            if unread is None or unread > MAX_BODY_BYTES:
                self.respond(code, payload, close=True); return
            self.drain(unread)
            self.respond(code, payload)

        def reject_unauthenticated(self, code, payload):
            self.respond(code, payload, close=True)
            declared = self.content_length()
            if declared:
                self.drain(min(declared, UNAUTHENTICATED_DRAIN_BYTES), seconds=UNAUTHENTICATED_DRAIN_SECONDS)

        def do_OPTIONS(self):
            self.respond(200 if self.path == '/align' and self.headers.get('Origin') == allowed_origin else 403)

        def do_POST(self):
            if self.path != '/align':
                self.reject_unauthenticated(404, None); return
            if self.headers.get('Origin') != allowed_origin or not hmac.compare_digest(self.headers.get('Authorization', ''), f'Bearer {token}'):
                self.reject_unauthenticated(403, {'error': 'forbidden'}); return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                project_bytes = int(self.headers.get('X-Project-Bytes', '0'))
                audio_format = self.headers.get('X-Audio-Format')
                if self.headers.get('Transfer-Encoding') or self.headers.get('Content-Type') != 'application/octet-stream':
                    raise ValueError('Unsupported content framing')
                if not (0 < project_bytes <= MAX_PROJECT_BYTES and 0 < length - project_bytes <= MAX_AUDIO_BYTES):
                    self.reject(413, {'error': 'payload limit'}, None); return
                if audio_format not in {'m4a', 'flac', 'wav'}:
                    raise ValueError('Unsupported audio format')
            except (ValueError, TypeError):
                self.reject(400, {'error': 'invalid request'}, self.content_length()); return
            # From here the framing is valid and length <= MAX_BODY_BYTES.
            if not job_lock.acquire(blocking=False):
                self.reject(503, {'error': 'worker busy'}, length); return
            consumed = 0
            try:
                raw = self.rfile.read(project_bytes)
                consumed = len(raw)
                project = json.loads(raw)
                if project.get('schema') != 'mabinogi-mobile-mml-studio/canonical-project@2' or not project.get('id') or not isinstance(project.get('events'), list) or not (0 < len(project['events']) <= 30000):
                    raise ValueError('Invalid project')
                with tempfile.TemporaryDirectory(prefix='mml-audio-') as folder:
                    path = Path(folder) / f'input.{audio_format}'
                    with path.open('wb') as output:
                        while consumed < length:
                            chunk = self.rfile.read(min(READ_CHUNK_BYTES, length - consumed))
                            if not chunk:
                                raise ValueError('Truncated audio')
                            output.write(chunk)
                            consumed += len(chunk)
                    report = aligner(path, project)
                    report['symbolic']['web_project_sha256'] = hashlib.sha256(raw).hexdigest()
                self.respond(200, report)
            except Exception:
                self.reject(422, {'error': 'alignment failed; symbolic truth unchanged'}, length - consumed)
            finally:
                job_lock.release()

    return ThreadingHTTPServer(address, Handler)


if __name__ == '__main__':
    server = create_server(('0.0.0.0', int(os.environ.get('AUDIO_WORKER_PORT', '8789'))), token=os.environ.get('AUDIO_WORKER_TOKEN'), allowed_origin=os.environ.get('AUDIO_WORKER_ORIGIN', ''))
    server.serve_forever()
