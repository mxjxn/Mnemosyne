"""Opt-in integration test. Point LOGSEQD_TEST_URL at a disposable graph server."""
import importlib.util
import os
from pathlib import Path
import unittest
import uuid
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

spec = importlib.util.spec_from_file_location('notes_integration', Path(__file__).parents[1] / 'dashboard/plugin_api.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


@unittest.skipUnless(os.environ.get('LOGSEQD_TEST_URL'), 'Set LOGSEQD_TEST_URL to a disposable graph server')
class RealLogseqd(unittest.TestCase):
    def test_round_trip_and_stale_write_protection(self):
        app = FastAPI()
        app.include_router(api.router)
        title = 'Desktop integration ' + uuid.uuid4().hex[:8]
        original = 'A quoted "thought" — Ω\\path\nA continuation'
        with patch.dict(os.environ, {'LOGSEQD_URL': os.environ['LOGSEQD_TEST_URL']}), TestClient(app) as client:
            health = client.get('/status')
            self.assertEqual(health.status_code, 200, health.text)
            result = client.post('/append', json={'page': title, 'content': original})
            self.assertEqual(result.status_code, 200, result.text)
            page = result.json()['page']
            self.assertEqual(len(page['blocks']), 1)
            parent = page['blocks'][0]
            self.assertIn('quoted "thought"', parent['block/content'])
            target = {'page': title, 'revision': page['revision'], 'block_path': parent['block/path'],
                      'expected_content': parent['block/content']}
            child = client.post('/blocks/insert', json={**target, 'content': 'A child block', 'sub_block': True})
            self.assertEqual(child.status_code, 200, child.text)
            blocks = child.json()['page']['blocks']
            self.assertEqual(len(blocks), 2)
            self.assertEqual(blocks[1]['block/level'], parent['block/level'] + 1)
            self.assertEqual(blocks[1]['block/parent']['block/id'], blocks[0]['block/id'])
            stale = client.post('/blocks/update', json={**target, 'content': 'Must not overwrite'})
            self.assertEqual(stale.status_code, 409)
            current = child.json()['page']
            parent = current['blocks'][0]
            changed = 'A literal EDN-like string: "} {:content "safe — Ω'
            updated = client.post('/blocks/update', json={'page': title, 'content': changed,
                'revision': current['revision'], 'block_path': parent['block/path'],
                'expected_content': parent['block/content']})
            self.assertEqual(updated.status_code, 200, updated.text)
            self.assertEqual(updated.json()['page']['blocks'][0]['block/content'], changed)
            today = health.json()['today']
            journal = client.post('/append', json={'page': today, 'content': 'Desktop journal integration'})
            self.assertEqual(journal.status_code, 200, journal.text)
            self.assertEqual(journal.json()['page']['title'], today)


if __name__ == '__main__':
    unittest.main(verbosity=2)
