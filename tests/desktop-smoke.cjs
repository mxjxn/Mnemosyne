/* Run with: node tests/desktop-smoke.cjs (see tests/README.md). */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const esbuild = require('esbuild');
const { chromium } = require('playwright');

async function main() {
  const bundle = await esbuild.build({
    stdin: {
      contents: `import plugin from '../desktop/plugin.js';
        import { mountHarness } from './desktop-host.js';
        import { createRoot } from 'react-dom/client'; mountHarness(plugin, createRoot);`,
      resolveDir: __dirname,
    },
    bundle: true, write: false, format: 'esm',
    alias: { '@hermes/plugin-sdk': path.join(__dirname, 'desktop-host.js') },
    nodePaths: [path.join(__dirname, 'node_modules'), ...(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)],
  });
  const graphs = {
    'vps-a': [{ 'block/id': 'a-1', 'block/content': 'A thought from the VPS', 'block/order': 0, 'block/level': 0 }],
    'vps-b': [{ 'block/id': 'b-1', 'block/content': 'A different private graph', 'block/order': 0, 'block/level': 0 }],
  };
  const writes = [];
  let failWrite = false;
  let delayWrite = false;
  const proposals = new Map();
  let revision = 1;
  const today = '2026_10_27';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/bundle.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle.outputFiles[0].text); return;
    }
    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="margin:0"><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>'); return;
    }
    const [, , connection, ...segments] = url.pathname.split('/');
    const route = '/' + segments.join('/');
    let data = {};
    let status = 200;
    const makePage = () => ({ title: today, blocks: graphs[connection].map((block, i) => ({ ...block, 'block/path': String(i) })), revision: String(revision).padStart(64, '0') });
    if (req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      writes.push({ connection, route, body });
      if (delayWrite) await new Promise(resolve => setTimeout(resolve, 600));
      if (route === '/references') { data = { id: 'a'.repeat(32), expected_content: body.expected_content }; writes.pop(); }
      else if (route.startsWith('/proposals/')) {
        const item = proposals.get(segments[1]);
        item.state = segments[2] === 'apply' ? 'applied' : 'rejected';
        if (item.state === 'applied') graphs[connection][0]['block/content'] = item.content;
        data = segments[2] === 'apply' ? { saved: true, page: makePage() } : item;
      }
      else if (failWrite) { status = 409; data = { detail: 'The note changed elsewhere. Your draft is safe.' }; }
      else {
        if (route === '/blocks/insert') graphs[connection].push({
          'block/id': connection + '-insert-' + writes.length, 'block/content': body.content,
          'block/level': body.sub_block ? 1 : 0, 'block/order': graphs[connection].length,
          ...(body.sub_block ? { 'block/parent': { 'block/id': graphs[connection][0]['block/id'] } } : {}),
        });
        else graphs[connection].push({ 'block/id': connection + '-new-' + writes.length,
          'block/content': body.content, 'block/order': graphs[connection].length, 'block/level': 0 });
        revision++;
        data = { saved: true, page: makePage(), refresh_required: false };
      }
    } else if (route === '/status') data = { connected: true, today, graph_id: connection };
    else if (route === '/proposals') data = { proposals: [...proposals.values()] };
    else if (route.startsWith('/proposals/')) data = proposals.get(segments[1]) || {};
    else if (route === '/pages') data = { pages: [
      { 'page/title': today, 'page/file': '/g/journals/' + today + '.md', 'page/mtime': Date.now() },
      { 'page/title': 'Projects', 'page/file': '/g/pages/Projects.md', 'page/mtime': Date.now() - 3600e3 },
      { 'page/title': 'Zebra Ideas', 'page/file': '/g/pages/Zebra Ideas.md', 'page/mtime': Date.now() - 7200e3 },
      { 'page/title': 'Aardvark Notes', 'page/file': '/g/pages/Aardvark Notes.md', 'page/mtime': Date.now() - 3 * 86400e3 },
      { 'page/title': 'ghostref' },
    ] };
    else if (route === '/page') data = makePage();
    else if (route === '/search') data = (url.searchParams.get('q') || '').toLowerCase().includes('ghost') ? { results: [{ page: 'ghostref', snippet: 'a matching block' }] } : { results: [] };
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    const workspace = page.getByTestId('workspace');
    const pane = page.getByTestId('pane');
    await workspace.getByText('A thought from the VPS', { exact: true }).waitFor();
    await pane.getByText('A thought from the VPS', { exact: true }).waitFor();

    await workspace.getByLabel('Journal entry').fill('A draft shared between views');
    assert.equal(await pane.getByLabel('Journal entry').inputValue(), 'A draft shared between views');
    await workspace.getByLabel('Expand writing area').click();
    assert.equal(await workspace.getByLabel('Journal entry').inputValue(), 'A draft shared between views');
    await workspace.getByLabel('Reduce writing area').click();

    // The workspace browser is open by default: Recent by mtime on top, then
    // All pages A→Z. Ghost [[references]] stay out even when search matches.
    const browserNav = workspace.getByLabel('Notes pages');
    await browserNav.getByText('ghostref', { exact: true }).waitFor({ state: 'detached' });
    assert.deepEqual(await browserNav.locator('.ln-group-label').allTextContents(), ['Recent', 'All pages']);
    assert.deepEqual(await browserNav.locator('.ln-group:has(.ln-group-label:text-is("Recent")) button').allTextContents(),
      ['Projects', 'Zebra Ideas', 'Aardvark Notes']);
    assert.deepEqual(await browserNav.locator('.ln-group:has(.ln-group-label:text-is("All pages")) button').allTextContents(),
      ['Aardvark Notes', 'Projects', 'Zebra Ideas']);
    await browserNav.getByLabel('Find a page').fill('ghostref');
    await browserNav.getByText('ghostref', { exact: true }).waitFor({ state: 'detached' }); // even a content-match ghost stays hidden
    await browserNav.getByLabel('Find a page').fill('');

    // The compact pane starts with the browser closed; Pages toggles it.
    const paneNav = pane.getByLabel('Notes pages');
    assert.equal(await paneNav.locator('.ln-group-label').count(), 0);
    await pane.getByRole('button', { name: 'Pages', exact: true }).click();
    await paneNav.locator('.ln-group-label').first().waitFor();
    await pane.getByRole('button', { name: 'Pages', exact: true }).click();
    await paneNav.waitFor({ state: 'detached' });

    await page.evaluate(() => window.harness.switchGateway());
    await workspace.getByText('A different private graph', { exact: true }).waitFor();
    assert.equal(await workspace.getByLabel('Journal entry').inputValue(), '');
    await page.evaluate(() => window.harness.switchGateway());
    await workspace.getByText('A thought from the VPS', { exact: true }).waitFor();
    assert.equal(await workspace.getByLabel('Journal entry').inputValue(), 'A draft shared between views');

    // A shared busy flag prevents a second pane from submitting the same draft.
    delayWrite = true;
    await workspace.getByRole('button', { name: 'Save block', exact: true }).click();
    assert(await pane.getByRole('button', { name: 'Saving…', exact: true }).isDisabled());
    await page.waitForFunction(() => !document.querySelector('[data-testid="workspace"] textarea').disabled);
    assert.equal(writes.length, 1);
    delayWrite = false;

    await workspace.locator('.ln-block').first().hover();
    await workspace.getByRole('button', { name: 'New sub-block', exact: false }).first().click();
    await workspace.getByLabel('Block text').fill('A nested thought');
    failWrite = true;
    revision++; // Another graph writer changed the note while this editor was open.
    await workspace.locator('.ln-inline').getByRole('button', { name: 'Save block', exact: true }).click();
    await workspace.getByRole('alert').getByText('The note changed elsewhere.', { exact: false }).waitFor();
    assert.equal(await workspace.getByLabel('Block text').inputValue(), 'A nested thought');
    failWrite = false;
    await workspace.getByRole('button', { name: 'Refresh notes', exact: true }).click();
    await workspace.getByRole('button', { name: 'Use matching block in refreshed note', exact: true }).click();
    assert.equal(await workspace.getByLabel('Block text').inputValue(), 'A nested thought');
    await workspace.locator('.ln-inline').getByRole('button', { name: 'Save block', exact: true }).click();
    await workspace.locator('.ln-children').getByText('A nested thought', { exact: true }).waitFor();
    assert(writes.at(-1).body.sub_block);

    await page.mouse.move(1400, 900);
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(200);
    const firstBlock = workspace.locator('.ln-block').first();
    const actionRow = firstBlock.locator(':scope > .ln-block-actions');
    assert.equal(await actionRow.evaluate(el => getComputedStyle(el).opacity), '0');
    assert(parseFloat(await actionRow.evaluate(el => getComputedStyle(el).maxHeight)) < 1);
    await firstBlock.locator(':scope > .ln-block-text').hover();
    await page.waitForTimeout(200);
    assert.equal(await actionRow.evaluate(el => getComputedStyle(el).opacity), '1');
    const childBlock = firstBlock.locator(':scope > .ln-children > .ln-block').first();
    const childActions = childBlock.locator(':scope > .ln-block-actions');
    await childBlock.locator(':scope > .ln-block-text').hover();
    await page.waitForTimeout(200);
    assert.equal(await actionRow.evaluate(el => getComputedStyle(el).opacity), '0');
    assert.equal(await childActions.evaluate(el => getComputedStyle(el).opacity), '1');

    // Discuss always starts a clean new chat, adds only the saved block chip,
    // and leaves the composer ready for the user rather than sending a prompt.
    await page.evaluate(() => window.harness.setChat('An existing chat draft that must not be reused'));
    await firstBlock.locator(':scope > .ln-block-text').hover();
    await page.waitForTimeout(200);
    await workspace.getByRole('button', { name: 'Discuss with Hermes', exact: true }).first().click();
    const chatDraft = page.getByLabel('Hermes chat draft');
    await chatDraft.waitFor();
    const prompt = await chatDraft.inputValue();
    assert.equal(prompt, '@mnemosyne:' + 'a'.repeat(32));
    assert(!prompt.includes('An existing chat draft'));
    assert(!prompt.includes('A thought from the VPS'));
    assert.equal(await page.locator('.ln-discussion').count(), 0);
    assert.equal(await page.evaluate(() => window.harness.newChats.length), 1);
    assert.deepEqual(await page.evaluate(() => window.harness.insertions), [
      { session: 'new', text: '@mnemosyne:' + 'a'.repeat(32), mode: 'block' },
    ]);
    await chatDraft.fill(prompt + '\\n\\nCan we discuss this?');
    assert.equal(await chatDraft.inputValue(), prompt + '\\n\\nCan we discuss this?');

    // The same server-stored proposal renders in chat and in Notes. Applying
    // the transcript card refreshes Notes without inserting assistant prose.
    const proposalId = 'b'.repeat(32);
    proposals.set(proposalId, { id: proposalId, state: 'pending', page: today, expected_content: 'A thought from the VPS', content: 'An improved thought', reason: 'Clarify the idea' });
    await page.evaluate(id => window.harness.showDirective(id), proposalId);
    await workspace.getByRole('button', { name: 'Apply edit' }).waitFor();
    await page.evaluate(() => window.harness.showDirective('invalid'));
    await workspace.locator('.ln-proposal').waitFor({ state: 'detached' });
    await page.evaluate(id => window.harness.showDirective(id), proposalId);
    await workspace.getByRole('button', { name: 'Apply edit' }).waitFor();
    await workspace.getByText('A thought from the VPS', { exact: true }).waitFor();
    if (process.env.REVIEW_SCREENSHOT_PATH) await page.screenshot({ path: process.env.REVIEW_SCREENSHOT_PATH });
    await workspace.getByRole('button', { name: 'Apply edit' }).click();
    await workspace.getByText('Applied to your note', { exact: true }).waitFor();
    await pane.locator('.ln-block-text').getByText('An improved thought', { exact: true }).waitFor();
    assert.equal(writes.filter(write => write.route === '/proposals/' + proposalId + '/apply').length, 1);

    // An accepted write stays with its original gateway after a same-profile swap.
    delayWrite = true;
    await pane.getByLabel('Journal entry').fill('Save only to gateway A');
    await pane.getByRole('button', { name: 'Save block', exact: true }).click();
    await page.evaluate(() => window.harness.switchGateway());
    await pane.getByText('A different private graph', { exact: true }).waitFor();
    await page.waitForTimeout(650);
    assert.equal(writes.at(-1).connection, 'vps-a');
    assert(!(await pane.innerText()).includes('Save only to gateway A'));
    assert.equal(await pane.getByLabel('Journal entry').inputValue(), '');
    assert.deepEqual(errors, []);
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    console.log('Desktop UI: shared drafts, resize, gateway isolation, save locking, nested blocks, hover-only actions, direct new-chat note chips, no auto-send, and inline edit review passed.');
  } finally { if (browser) await browser.close(); server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
