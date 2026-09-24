import contextlib
import http.client
import json
import socket
import threading
import unittest
from mml_audio_worker.http_server import MAX_AUDIO_BYTES, MAX_PROJECT_BYTES, create_server

TOKEN = 'unit-test-token-24-characters'
ORIGIN = 'https://studio.example'
PROJECT = json.dumps({'schema': 'mabinogi-mobile-mml-studio/canonical-project@2', 'id': 'test', 'events': [{'kind': 'note'}]}).encode()
HEADERS = {'Origin': ORIGIN, 'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/octet-stream', 'X-Audio-Format': 'wav'}
# Far larger than loopback socket buffers: an error reply sent without reading
# this upload resets the connection before the client can read the reply.
LARGE_AUDIO = bytes(32 * 1024 * 1024)


@contextlib.contextmanager
def serve(aligner):
    server = create_server(('127.0.0.1', 0), token=TOKEN, allowed_origin=ORIGIN, aligner=aligner)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown(); server.server_close(); thread.join()


def post(server, project, audio, **headers):
    conn = http.client.HTTPConnection(*server.server_address, timeout=30)
    try:
        conn.request('POST', '/align', project + audio, {**HEADERS, 'X-Project-Bytes': str(len(project)), **headers})
        response = conn.getresponse()
        return response.status, json.loads(response.read()), response.getheader('Connection')
    finally:
        conn.close()


def raw_headers_only(server, content_length, authorization):
    """Send only the request head, declaring a body that is never sent."""
    with socket.create_connection(server.server_address, timeout=10) as sock:
        sock.sendall((
            f'POST /align HTTP/1.1\r\nHost: worker\r\nOrigin: {ORIGIN}\r\nAuthorization: {authorization}\r\n'
            f'Content-Type: application/octet-stream\r\nX-Audio-Format: wav\r\nX-Project-Bytes: {len(PROJECT)}\r\n'
            f'Content-Length: {content_length}\r\n\r\n'
        ).encode())
        received = b''
        while chunk := sock.recv(65536):  # raises socket.timeout if the server keeps waiting for the body
            received += chunk
        return received


class HttpWorkerTest(unittest.TestCase):
    def test_explicit_authenticated_boundary_and_temp_cleanup(self):
        seen = []
        def aligner(path, project):
            seen.append((path, path.read_bytes(), project))
            return {'symbolic': {'project_id': project['id']}, 'evidence_policy': {'changes_symbolic_truth': False}}
        token = 'unit-test-token-24-characters'
        origin = 'https://studio.example'
        server = create_server(('127.0.0.1', 0), token=token, allowed_origin=origin, aligner=aligner)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request(headers, body):
            conn = http.client.HTTPConnection(*server.server_address, timeout=5)
            conn.request('POST', '/align', body, headers)
            response = conn.getresponse()
            status = response.status
            data = json.loads(response.read())
            conn.close()
            return status, data
        try:
            project = json.dumps({'schema': 'mabinogi-mobile-mml-studio/canonical-project@2', 'id': 'test', 'events': [{'kind': 'note'}]}).encode()
            headers = {'Origin': origin, 'Authorization': f'Bearer {token}', 'Content-Type': 'application/octet-stream', 'X-Project-Bytes': str(len(project)), 'X-Audio-Format': 'wav'}
            self.assertEqual(request({**headers, 'Authorization': ''}, b'')[0], 403)
            self.assertEqual(request({**headers, 'Origin': 'https://untrusted.example'}, b'')[0], 403)
            self.assertEqual(request({**headers, 'X-Audio-Format': 'exe'}, project + b'audio')[0], 400)
            status, report = request(headers, project + b'audio')
            self.assertEqual(status, 200)
            self.assertFalse(report['evidence_policy']['changes_symbolic_truth'])
            self.assertEqual(len(seen), 1)
            self.assertEqual(seen[0][1], b'audio')
            self.assertFalse(seen[0][0].exists())
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_busy_reply_is_readable_after_a_large_upload(self):
        entered, release, calls = threading.Event(), threading.Event(), []
        def aligner(path, project):
            calls.append(path.read_bytes())
            entered.set()
            release.wait(30)
            return {'symbolic': {}}
        with serve(aligner) as server:
            first = []
            worker = threading.Thread(target=lambda: first.append(post(server, PROJECT, b'audio')))
            worker.start()
            try:
                self.assertTrue(entered.wait(10))
                status, payload, _ = post(server, PROJECT, LARGE_AUDIO)
            finally:
                release.set(); worker.join()
            self.assertEqual((status, payload), (503, {'error': 'worker busy'}))
            self.assertEqual(first[0][0], 200)
            self.assertEqual(calls, [b'audio'])

    def test_invalid_request_and_project_replies_are_readable_after_a_large_upload(self):
        calls = []
        def aligner(path, project):
            calls.append(path.read_bytes())
            return {'symbolic': {}}
        failure = (422, {'error': 'alignment failed; symbolic truth unchanged'})
        with serve(aligner) as server:
            self.assertEqual(post(server, PROJECT, LARGE_AUDIO, **{'X-Audio-Format': 'exe'})[:2], (400, {'error': 'invalid request'}))
            self.assertEqual(post(server, b'{not json', LARGE_AUDIO)[:2], failure)
            wrong_schema = json.dumps({'schema': 'other', 'id': 'test', 'events': [{}]}).encode()
            self.assertEqual(post(server, wrong_schema, LARGE_AUDIO)[:2], failure)
            # The job slot was released and a valid upload still aligns.
            self.assertEqual(post(server, PROJECT, b'audio')[0], 200)
            self.assertEqual(calls, [b'audio'])

    def test_unauthenticated_and_oversized_uploads_are_not_read(self):
        def aligner(path, project):
            raise AssertionError('must not align')
        with serve(aligner) as server:
            # Small unauthenticated bodies are drained so the 403 stays readable.
            self.assertEqual(post(server, PROJECT, b'a' * 1024, Authorization='Bearer wrong'),
                             (403, {'error': 'forbidden'}, 'close'))
            # A large declared body is never awaited: reply and close promptly.
            forbidden = raw_headers_only(server, 16 * 1024 * 1024, 'Bearer wrong')
            self.assertTrue(forbidden.startswith(b'HTTP/1.0 403 '), forbidden[:40])
            self.assertIn(b'\r\nConnection: close\r\n', forbidden)
            too_large = raw_headers_only(server, MAX_PROJECT_BYTES + MAX_AUDIO_BYTES + 1, f'Bearer {TOKEN}')
            self.assertTrue(too_large.startswith(b'HTTP/1.0 413 '), too_large[:40])
            self.assertIn(b'\r\nConnection: close\r\n', too_large)
            self.assertTrue(too_large.endswith(b'{"error": "payload limit"}'))

    def test_configuration_fails_closed(self):
        with self.assertRaises(ValueError):
            create_server(('127.0.0.1', 0), token='', allowed_origin='https://studio.example')
        with self.assertRaises(ValueError):
            create_server(('127.0.0.1', 0), token='x' * 24, allowed_origin='*')
