"""Run with: python -m unittest discover -s tests -p 'test_*.py' -v."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

spec = importlib.util.spec_from_file_location('notes_api', Path(__file__).parents[1] / 'dashboard/plugin_api.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class DesktopAPI(unittest.TestCase):
    def setUp(self):
        self.blocks = [{'block/id': 'fresh-99', 'block/content': 'Original note',
                        'block/order': 0, 'block/level': 0, 'block/line': 3}]
        self.writes = []
        self.fail_read_after_write = False
        async def upstream(method, path, values=None):
            if method == 'POST':
                self.writes.append((path, values))
                return {'status': 'ok'}
            if path == '/health':
                return {'status': 'ok'}
            if self.fail_read_after_write and self.writes:
                raise api.HTTPException(503, 'unreachable')
            return {'title': 'A page', 'blocks': copy.deepcopy(self.blocks)}
        self.upstream = patch.object(api, '_upstream', AsyncMock(side_effect=upstream))
        self.upstream.start()
        app = FastAPI()
        app.include_router(api.router)
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.upstream.stop()

    def edit(self, **updates):
        body = {'page': 'A page', 'content': 'New text', 'revision': api._revision(self.blocks),
                'block_path': '0', 'expected_content': 'Original note'}
        body.update(updates)
        return body

    def test_stale_note_never_writes(self):
        stale = self.edit()
        self.blocks.append({'block/id': 'other', 'block/content': 'An agent wrote this', 'block/order': 1})
        response = self.client.post('/blocks/update', json=stale)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.writes, [])

    def test_reindex_only_resolves_the_current_block_id(self):
        edit = self.edit()
        self.blocks[0]['block/id'] = 'reindexed-100'
        response = self.client.post('/blocks/update', json=edit)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.writes[0][1]['id'], 'reindexed-100')

    def test_sub_block_uses_current_parent_depth(self):
        self.blocks[0]['block/level'] = 2
        response = self.client.post('/blocks/insert', json=self.edit(sub_block=True))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.writes[0][1]['level'], 3)
        self.assertEqual(self.writes[0][1]['after-block-id'], 'fresh-99')

    def test_changed_original_block_never_writes(self):
        response = self.client.post('/blocks/update', json=self.edit(expected_content='Something else'))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.writes, [])

    def test_successful_write_is_not_reported_as_failure_when_refresh_fails(self):
        self.fail_read_after_write = True
        response = self.client.post('/append', json={'page': 'A page', 'content': 'Save once'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'saved': True, 'page': None, 'refresh_required': True})
        self.assertEqual(len(self.writes), 1)

    def test_older_journal_append_cannot_create_a_shadow_page(self):
        response = self.client.post('/append', json={'page': '2000_01_01', 'content': 'Past entry'})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.writes, [])

    def test_blank_content_and_control_character_titles_rejected(self):
        for body in [{'page': 'A page', 'content': '   '}, {'page': 'Bad\nTitle', 'content': 'Text'}]:
            self.assertEqual(self.client.post('/append', json=body).status_code, 422)
        self.assertEqual(self.writes, [])

    def test_deepest_block_cannot_have_another_sub_block(self):
        self.blocks[0]['block/level'] = 5
        response = self.client.post('/blocks/insert', json=self.edit(sub_block=True))
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.writes, [])

    def test_status_does_not_expose_server_paths_or_credentials(self):
        data = self.client.get('/status').json()
        self.assertEqual(set(data), {'connected', 'today', 'name', 'graph_id'})
        self.assertEqual(len(data['graph_id']), 20)

    def test_sibling_local_orders_produce_distinct_paths(self):
        self.blocks = [
            {'block/id': 'a', 'block/content': 'Parent A', 'block/order': 0, 'block/line': 1},
            {'block/id': 'b', 'block/content': 'Parent B', 'block/order': 1, 'block/line': 3},
            {'block/id': 'cb', 'block/content': 'Repeated', 'block/order': 0, 'block/level': 1,
             'block/parent': {'block/id': 'b'}, 'block/line': 4},
            {'block/id': 'ca', 'block/content': 'Repeated', 'block/order': 0, 'block/level': 1,
             'block/parent': {'block/id': 'a'}, 'block/line': 2},
        ]
        page = self.client.get('/page?title=A%20page').json()
        self.assertEqual([block['block/path'] for block in page['blocks']], ['0', '0/0', '1', '1/0'])
        response = self.client.post('/blocks/update', json={
            'page': 'A page', 'content': 'Only the second repeated block', 'revision': page['revision'],
            'block_path': '1/0', 'expected_content': 'Repeated'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.writes[0][1]['id'], 'cb')
        self.assertEqual(api._revision(self.blocks), api._revision(list(reversed(self.blocks))))

    def test_older_backend_cannot_perform_unsafe_block_edits(self):
        del self.blocks[0]['block/line']
        response = self.client.post('/blocks/update', json=self.edit())
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.writes, [])


if __name__ == '__main__':
    unittest.main()
