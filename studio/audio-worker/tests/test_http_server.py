import http.client
import json
import threading
import unittest
from mml_audio_worker.http_server import create_server


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

    def test_configuration_fails_closed(self):
        with self.assertRaises(ValueError):
            create_server(('127.0.0.1', 0), token='', allowed_origin='https://studio.example')
        with self.assertRaises(ValueError):
            create_server(('127.0.0.1', 0), token='x' * 24, allowed_origin='*')
