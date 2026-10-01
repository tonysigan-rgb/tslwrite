const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
let server;
let browser;
let origin;

before(async () => {
  server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!['/scriptwriter.html', '/index.html', '/dashboard.html', '/collaboration.js', '/writer-collaboration.js'].includes(pathname)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': pathname.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8' });
    response.end(await fs.readFile(path.join(root, pathname)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function openEditor(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  await context.addInitScript(() => {
    const user = { uid: 'test-only-user', displayName: 'Import Test', email: 'test@example.invalid', emailVerified: true, getIdToken: async () => 'test-token' };
    const records = new Map(Object.entries(JSON.parse(sessionStorage.getItem('import-test-cloud') || '{}')));
    const persist = () => sessionStorage.setItem('import-test-cloud', JSON.stringify(Object.fromEntries(records)));
    const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const snapshot = ref => ({ exists: records.has(ref.path), id: ref.id, ref, data: () => clone(records.get(ref.path)) });
    class Reference {
      constructor(path) { this.path = path; this.id = path.split('/').at(-1); }
      collection(name) { return new Collection(`${this.path}/${name}`); }
      doc(name) { return new Reference(`${this.path}/${name}`); }
      async get() { return snapshot(this); }
      async set(data, options) { records.set(this.path, options?.merge ? { ...records.get(this.path), ...clone(data) } : clone(data)); persist(); }
      async delete() { records.delete(this.path); persist(); }
      onSnapshot() { return () => {}; }
    }
    class Collection extends Reference {
      async get() {
        const docs = [...records.keys()].filter(key => key.startsWith(this.path + '/') && key.split('/').length === this.path.split('/').length + 1).map(key => snapshot(new Reference(key)));
        return { empty: docs.length === 0, docs };
      }
    }
    const db = {
      collection(name) { return new Collection(name); },
      async runTransaction(callback) {
        const pending = [];
        const result = await callback({
          get: async ref => snapshot(ref),
          set(ref, data, options) { pending.push({ ref, data, options }); },
          update(ref, data) { pending.push({ ref, data, options: { merge: true } }); },
        });
        for (const { ref, data, options } of pending) await ref.set(data, options);
        return result;
      },
    };
    const firestore = () => db;
    firestore.FieldValue = { serverTimestamp: () => 0 };
    window.firebase = {
      apps: [],
      initializeApp() { this.apps.push({}); },
      auth: () => ({ currentUser: user, onAuthStateChanged(callback) { setTimeout(() => callback(user), 0); } }),
      firestore,
    };
    localStorage.setItem('tslwrite_cache_uid', user.uid);
  });
  const page = await context.newPage();
  await page.goto(`${origin}/scriptwriter.html?new=1`);
  await page.waitForFunction(() => typeof _currentUser !== 'undefined' && _currentUser !== null);
  await page.locator('#script-page .script-block').first().waitFor();
  return page;
}

async function importFromDialog(page, name, contents, option = /StudioBinder/i) {
  await page.locator('#btn-file-menu').click();
  await page.getByRole('menuitem', { name: /Import script/i }).click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#modal-body').getByRole('button', { name: option }).click();
  const chooser = await chooserPromise;
  if (/\.sbx$/i.test(name)) assert.match(await page.locator('#file-input').getAttribute('accept'), /\.sbx/i);
  await chooser.setFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(contents) });
}

async function renderedBlocks(page) {
  return page.locator('#script-page .script-block').evaluateAll(elements =>
    elements.map(element => ({ type: element.dataset.type, text: element.innerText })));
}

async function waitForImport(page, count) {
  await page.waitForFunction(expected => state.projects.length === expected, count);
  await page.locator('#import-overlay').waitFor({ state: 'hidden' });
}

test('StudioBinder import preserves typed structure, Unicode, line breaks, existing edits and reload', async t => {
  const page = await openEditor(t);
  const originalId = await page.evaluate(() => state.currentProjectId);
  await page.locator('#script-page .action').fill('An unsaved original action.');
  assert.equal(await page.evaluate(() => getProject().blocks[1].text), '');

  const fixture = await fs.readFile(path.join(__dirname, 'fixtures', 'screenplay.sbx'), 'utf8');
  await importFromDialog(page, 'Café & Rain.SBX', fixture);
  await waitForImport(page, 2);

  const expected = [
    { type: 'scene-heading', text: 'INT. CAFÉ - NIGHT' },
    { type: 'general', text: 'A short preface.' },
    { type: 'action', text: '雨 & café <quiet>\nA second line.' },
    { type: 'character', text: 'MAYA' },
    { type: 'parenthetical', text: '(softly)' },
    { type: 'dialogue', text: '“Hello,” she says.\n你好。' },
    { type: 'transition', text: 'CUT TO:' },
    { type: 'shot', text: 'CLOSE ON: THE CUP' },
    { type: 'general', text: 'MAYA, LEO' },
    { type: 'act-marker', text: 'ACT TWO' },
  ];
  assert.deepEqual(await renderedBlocks(page), expected);
  assert.equal(await page.locator('#script-title').inputValue(), 'Café & Rain');
  const importedId = await page.evaluate(() => state.currentProjectId);
  assert.notEqual(importedId, originalId);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('scriptwriter_v2')));
  assert.equal(stored.projects.find(project => project.id === originalId).blocks[1].text, 'An unsaved original action.');
  assert.deepEqual(stored.projects.find(project => project.id === importedId).blocks.map(({ type, text }) => ({ type, text })), expected);
  await page.waitForFunction(() => writerSaveQueues.size === 0);
  await page.goto(`${origin}/scriptwriter.html?project=${encodeURIComponent(importedId)}`);
  await page.locator('#script-page .script-block').first().waitFor();
  assert.deepEqual(await renderedBlocks(page), expected);
  assert.equal(await page.evaluate(() => state.projects.length), 2);
});

test('invalid SBX leaves the current project intact and permits selecting the same file again', async t => {
  const page = await openEditor(t);
  const initial = await page.evaluate(() => ({ id: state.currentProjectId, ids: state.projects.map(project => project.id), blocks: getProject().blocks }));
  for (const contents of [
    '<!doctype html><html><body><p>Unrelated HTML</p></body></html>',
    '\u0000\u0001not an SBX script',
    '<div class="divtype11"></div>',
    '<div class="divtype2">Valid first paragraph.</div><div class="divtype99">Unknown content.</div>',
  ]) {
    const dialogPromise = page.waitForEvent('dialog');
    await importFromDialog(page, 'retry.sbx', contents);
    const dialog = await dialogPromise;
    assert.match(dialog.message(), /Import failed:/);
    await dialog.accept();
    await page.locator('#import-overlay').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#file-input').inputValue(), '');
    assert.deepEqual(await page.evaluate(() => ({ id: state.currentProjectId, ids: state.projects.map(project => project.id), blocks: getProject().blocks })), initial);
  }

  await importFromDialog(page, 'retry.sbx', '<div class="divtype2">A valid retry.</div>');
  await waitForImport(page, 2);
  assert.deepEqual(await renderedBlocks(page), [{ type: 'action', text: 'A valid retry.' }]);
});

test('SBX source markup is inert and unsafe elements do not become screenplay text', async t => {
  const page = await openEditor(t);
  const sourceRequests = [];
  page.on('request', request => { if (request.url().includes('sbx-import.invalid')) sourceRequests.push(request.url()); });
  await importFromDialog(page, 'unsafe.sbx', `<!doctype html><html><body>
    <script>window.__sbxExecuted = true;</script>
    <div class="divtype2" onclick="window.__sbxExecuted=true">Safe &lt;script&gt; text.
      <img src="https://sbx-import.invalid/pixel" onerror="window.__sbxExecuted=true">
      <script>window.__sbxExecuted = true;</script>
      <style>body{display:none}</style>
    </div>
  </body></html>`);
  await waitForImport(page, 2);
  assert.equal(await page.evaluate(() => window.__sbxExecuted), undefined);
  assert.deepEqual(await renderedBlocks(page), [{ type: 'action', text: 'Safe <script> text.' }]);
  assert.equal(await page.locator('#script-page script, #script-page img, #script-page style').count(), 0);
  assert.deepEqual(sourceRequests, []);
});

test('legacy and current dual dialogue retain file order and omitted scenes stay labelled', async t => {
  const page = await openEditor(t);
  await importFromDialog(page, 'dual.sbx', `
    <div class="divtype0" data-omitted="true">INT. ROOM - DAY<span class="omitted">OMITTED</span></div>
    <div class="dual">
      <div class="left"><div class="divtype3">MAYA</div><div class="divtype5">First voice.</div></div>
      <div class="right"><div class="divtype3">LEO</div><div class="divtype5">Second voice.</div></div>
    </div>
    <div class="divtype3 dual-left">MAYA</div><div class="divtype5 dual-left">Third voice.</div>
    <div class="divtype3 dual-right">LEO</div><div class="divtype5 dual-right">Fourth voice.</div>
    <div class="divtype10"><div class="divtype3">MAYA</div><div class="divtype5">Nested voice.</div></div>
    <div class="divtype10">Standalone dual paragraph.</div>
  `);
  await waitForImport(page, 2);
  assert.deepEqual(await renderedBlocks(page), [
    { type: 'scene-heading', text: 'INT. ROOM - DAY (OMITTED)' },
    { type: 'character', text: 'MAYA' },
    { type: 'dialogue', text: 'First voice.' },
    { type: 'character', text: 'LEO' },
    { type: 'dialogue', text: 'Second voice.' },
    { type: 'character', text: 'MAYA' },
    { type: 'dialogue', text: 'Third voice.' },
    { type: 'character', text: 'LEO' },
    { type: 'dialogue', text: 'Fourth voice.' },
    { type: 'character', text: 'MAYA' },
    { type: 'dialogue', text: 'Nested voice.' },
    { type: 'general', text: 'Standalone dual paragraph.' },
  ]);
});

test('Fountain import remains available and produces editable screenplay blocks', async t => {
  const page = await openEditor(t);
  await importFromDialog(page, 'legacy.fountain', 'INT. OFFICE - DAY\n\nA phone rings.\n\nMAYA\nHello.\n', /Fountain \/ TXT/i);
  await waitForImport(page, 2);
  assert.deepEqual(await renderedBlocks(page), [
    { type: 'scene-heading', text: 'INT. OFFICE - DAY' },
    { type: 'action', text: 'A phone rings.' },
    { type: 'character', text: 'MAYA' },
    { type: 'dialogue', text: 'Hello.' },
  ]);
  assert.equal(await page.locator('#script-page .dialogue').getAttribute('contenteditable'), 'true');
});
