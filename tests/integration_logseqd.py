"""Opt-in integration test. Point LOGSEQD_TEST_URL at a disposable graph server."""
import importlib.util
import os
from pathlib import Path
import unittest
import uuid
import tempfile
import asyncio
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

    def test_reference_proposal_review_round_trip(self):
        app = FastAPI()
        app.include_router(api.router)
        title = 'Proposal integration ' + uuid.uuid4().hex[:8]
        with tempfile.TemporaryDirectory() as directory, patch.object(api, '_data_dir', return_value=Path(directory)), patch.dict(os.environ, {'LOGSEQD_URL': os.environ['LOGSEQD_TEST_URL']}), TestClient(app) as client:
            page = client.post('/append', json={'page': title, 'content': 'Original thought'}).json()['page']
            block = page['blocks'][0]
            reference = client.post('/references', json={'page': title, 'revision': page['revision'], 'block_path': block['block/path'], 'expected_content': block['block/content']})
            self.assertEqual(reference.status_code, 200, reference.text)
            request = api.ProposalRequest(reference=reference.json()['id'], content='Reviewed "thought" — Ω\\path', reason='Integration check')
            suggestion = asyncio.run(api.propose(request))
            self.assertEqual(client.get('/page', params={'title': title}).json()['blocks'][0]['block/content'], 'Original thought')
            endpoint = '/proposals/' + suggestion['id']
            applied = client.post(endpoint + '/apply')
            self.assertEqual(applied.status_code, 200, applied.text)
            self.assertEqual(applied.json()['page']['blocks'][0]['block/content'], request.content)
            self.assertEqual(client.post(endpoint + '/apply').status_code, 200)
            self.assertEqual(client.get(endpoint).json()['state'], 'applied')
            # Stored context continues to describe what was discussed, even
            # after the note itself has been changed by an accepted suggestion.
            self.assertEqual(client.get('/references/' + reference.json()['id']).json()['expected_content'], 'Original thought')


if __name__ == '__main__':
    unittest.main(verbosity=2)
