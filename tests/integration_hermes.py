"""Run inside Hermes's Python runtime against a disposable logseqd graph.

LOGSEQD_TEST_URL=http://127.0.0.1:18471 hermes --run-module unittest discover -s /absolute/path/to/tests -p integration_hermes.py -v
No installed plugins, profile settings, agent sessions, or real notes are used.
"""
import asyncio
import importlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch


@unittest.skipUnless(os.environ.get('LOGSEQD_TEST_URL'), 'Requires a disposable logseqd graph')
class HermesRuntime(unittest.TestCase):
    def test_native_expansion_and_proposal_tool(self):
        from agent import context_references as references
        root = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location('mnemosyne_runtime_check', root / '__init__.py', submodule_search_locations=[str(root)])
        plugin = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = plugin
        spec.loader.exec_module(plugin)

        class Context:
            def register_context_reference(self, provider):
                self.provider = provider
                references.register_context_reference_provider(provider)

            def register_tool(self, **definition):
                self.tool = definition

        ctx = Context()
        providers = references._context_reference_providers
        with patch.dict(providers, clear=True):
            plugin.register(ctx)
            self.assertIsInstance(ctx.provider, references.ContextReferenceProvider)
            api = importlib.import_module(spec.name + '.dashboard.plugin_api')
            with tempfile.TemporaryDirectory() as directory, patch.object(api, '_data_dir', return_value=Path(directory)), patch.dict(os.environ, {'LOGSEQD_URL': os.environ['LOGSEQD_TEST_URL']}):
                async def run():
                    title = 'Hermes native reference ' + uuid.uuid4().hex[:8]
                    await api.append(api.Entry(page=title, content='A native reference Ω'))
                    page = await api._page(title)
                    block = page['blocks'][0]
                    ref = await api.create_reference(api.ReferenceRequest(page=title, revision=page['revision'], block_path=block['block/path'], expected_content=block['block/content']))
                    prompt = 'Discuss this note. @mnemosyne:' + ref['id']
                    result = await references.preprocess_context_references_async(prompt, cwd=directory, context_length=32768)
                    self.assertEqual(result.original_message, prompt)
                    self.assertTrue(result.expanded)
                    self.assertFalse(result.blocked)
                    self.assertIn('A native reference Ω', result.message)
                    self.assertNotIn('A native reference Ω', result.original_message)
                    self.assertIn('mnemosyne_propose_edit', result.message)
                    self.assertEqual(result.warnings, [])
                    completions = await ctx.provider.autocomplete('native reference', limit=1)
                    self.assertEqual(completions[0].text, ref['id'])
                    self.assertIn(title, completions[0].display)
                    suggestion = json.loads(await ctx.tool['handler']({'reference': ref['id'], 'content': 'Suggested native edit'}))
                    self.assertNotIn('error', suggestion)
                    self.assertEqual(suggestion['review'], '::mnemosyne-edit{id="' + suggestion['proposal_id'] + '"}')
                    self.assertEqual((await api._page(title))['blocks'][0]['block/content'], 'A native reference Ω')
                    invalid = json.loads(await ctx.tool['handler']({'reference': 'invalid', 'content': 'No change'}))
                    self.assertIn('error', invalid)
                asyncio.run(run())


if __name__ == '__main__':
    unittest.main(verbosity=2)
