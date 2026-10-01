const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const ownerId = 'owner-user';
const userId = 'collaborator-user';
const projectId = 'shared-script';
const projectPath = `users/${ownerId}/projects/${projectId}`;
const memberPath = `${projectPath}/members/${userId}`;
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

function script(overrides = {}) {
  return {
    id: projectId,
    title: 'Shared screenplay',
    format: 'screenplay',
    created: 1,
    updated: 1,
    revision: 4,
    collaborationEnabled: true,
    collaborationGeneration: 'generation-1',
    blocks: [
      { id: 'scene-one', type: 'scene-heading', text: 'INT. WRITERS ROOM - DAY' },
      { id: 'action-one', type: 'action', text: 'The original shared scene.' },
    ],
    notes: [],
    revisions: [],
    cover: { show: false, author: '', contact: '', phone: '', email: '', wga: '', copyright: '2026', draftDate: '', logline: '' },
    ...overrides,
  };
}

async function openWriter(t, { role = 'editor', member = true, verified = true, cache = null, extraDocuments = {}, collectionFromCache = false, query = `project=${projectId}&owner=${ownerId}` } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  t.after(() => context.close());
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  const documents = { [projectPath]: script(), ...extraDocuments };
  if (member) documents[memberPath] = { uid: userId, email: 'collaborator@example.invalid', role, generation: 'generation-1' };
  await context.addInitScript(({ documents, userId, verified, cache, collectionFromCache }) => {
    const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const records = new Map(Object.entries(documents));
    const listeners = new Map();
    const writes = [];
    const snapshot = ref => ({ id: ref.id, ref, exists: records.has(ref.path), data: () => clone(records.get(ref.path)), metadata: { fromCache: false } });
    const emit = (path, override) => {
      const callbacks = [...(listeners.get(path) || [])];
      for (const callback of callbacks) callback(override || snapshot(new Reference(path)));
    };
    class Reference {
      constructor(path = '') { this.path = path; this.id = path.split('/').at(-1); }
      collection(name) { return new Collection(`${this.path}/${name}`.replace(/^\//, '')); }
      doc(name) { return new Reference(`${this.path}/${name}`.replace(/^\//, '')); }
      async get() { return snapshot(this); }
      async set(value, options) {
        const data = options?.merge ? { ...records.get(this.path), ...clone(value) } : clone(value);
        records.set(this.path, data);
        writes.push({ path: this.path, data });
        emit(this.path);
      }
      async update(value) { return this.set(value, { merge: true }); }
      async delete() { records.delete(this.path); writes.push({ path: this.path, deleted: true }); emit(this.path); }
      onSnapshot(next) {
        const callback = typeof next === 'function' ? next : next.next;
        if (!listeners.has(this.path)) listeners.set(this.path, new Set());
        listeners.get(this.path).add(callback);
        queueMicrotask(() => { if (listeners.get(this.path)?.has(callback)) callback(snapshot(this)); });
        return () => listeners.get(this.path)?.delete(callback);
      }
    }
    class Collection extends Reference {
      async get() {
        const docs = [...records.keys()].filter(key => key.startsWith(this.path + '/') && key.split('/').length === this.path.split('/').length + 1).map(key => snapshot(new Reference(key)));
        return { empty: docs.length === 0, docs, size: docs.length, forEach: callback => docs.forEach(callback), metadata: { fromCache: collectionFromCache } };
      }
      where() { return this; }
      orderBy() { return this; }
      limit() { return this; }
    }
    const db = {
      collection(name) { return new Collection(name); },
      doc(name) { return new Reference(name); },
      async runTransaction(callback) {
        const pending = [];
        const transaction = {
          get: async ref => snapshot(ref),
          set(ref, data, options) { pending.push({ ref, data: clone(data), options }); return this; },
          update(ref, data) { pending.push({ ref, data: clone(data), options: { merge: true } }); return this; },
        };
        const result = await callback(transaction);
        if (window.__collabMock.failWrites) throw Object.assign(new Error('The test connection is offline.'), { code: 'unavailable' });
        for (const { ref, data, options } of pending) {
          const value = options?.merge ? { ...records.get(ref.path), ...data } : data;
          records.set(ref.path, value);
          writes.push({ path: ref.path, data: clone(value), transaction: true });
        }
        // Firestore listeners observe committed data after the write promise settles.
        setTimeout(() => pending.forEach(({ ref }) => emit(ref.path)), 0);
        return result;
      },
    };
    const user = { uid: userId, displayName: 'Collaborator', email: 'collaborator@example.invalid', emailVerified: verified, getIdToken: async () => 'mock-token', reload: async () => {} };
    const auth = {
      currentUser: user,
      onAuthStateChanged(callback) { setTimeout(() => callback(user), 0); return () => {}; },
      async signOut() {
        const calls = Number(sessionStorage.getItem('collaboration-test-signouts') || 0);
        sessionStorage.setItem('collaboration-test-signouts', String(calls + 1));
        this.currentUser = null;
      },
    };
    const firestore = () => db;
    firestore.FieldValue = { serverTimestamp: () => ({ seconds: 100, nanoseconds: 0 }) };
    window.firebase = { apps: [], initializeApp() { this.apps.push({}); }, auth: () => auth, firestore };
    window.__collabMock = {
      writes,
      failWrites: false,
      get: path => clone(records.get(path)),
      replace(path, data, notify = true) { records.set(path, clone(data)); if (notify) emit(path); },
      remove(path) { records.delete(path); emit(path); },
      emitCached(path, data) {
        emit(path, { id: path.split('/').at(-1), ref: new Reference(path), exists: data !== undefined, data: () => clone(data), metadata: { fromCache: true } });
      },
      listening: path => (listeners.get(path)?.size || 0) > 0,
    };
    if (!localStorage.getItem('collaboration-test-initialized')) {
      if (cache) {
        localStorage.setItem('tslwrite_cache_uid', cache.uid);
        localStorage.setItem('scriptwriter_v2', JSON.stringify(cache.data));
      } else {
        localStorage.setItem('tslwrite_cache_uid', userId);
      }
      localStorage.setItem('collaboration-test-initialized', 'true');
    }
  }, { documents, userId, verified, cache, collectionFromCache });
  const page = await context.newPage();
  page.on('pageerror', error => t.diagnostic(error.stack));
  page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') t.diagnostic(message.text()); });
  await page.goto(`${origin}/scriptwriter.html?${query}`);
  await page.waitForFunction(() => typeof _currentUser !== 'undefined' && _currentUser !== null);
  return page;
}

async function waitForShared(page) {
  await page.locator('#script-page .action').waitFor();
  assert.equal(await page.locator('#script-page .action').innerText(), 'The original shared scene.');
}

async function saveNow(page) {
  await page.evaluate(async () => {
    clearTimeout(saveTimer);
    syncDOMToData();
    await saveProjectToFirestore(getProject());
  });
}

async function importSbx(page, name, text) {
  await page.locator('#btn-file-menu').click();
  await page.getByRole('menuitem', { name: /Import script/i }).click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#modal-body').getByRole('button', { name: /StudioBinder/i }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(text) });
  await page.locator('#import-overlay').waitFor({ state: 'hidden' });
}

test('shared editor saves transactionally to the owner and never caches shared content as a private script', async t => {
  const page = await openWriter(t);
  await waitForShared(page);
  assert.equal(await page.locator('#script-page .action').getAttribute('contenteditable'), 'true');
  await page.locator('#script-page .action').fill('The collaborator adds a scene.');
  await saveNow(page);
  const result = await page.evaluate(({ projectPath, projectId, userId }) => ({
    remote: __collabMock.get(projectPath),
    writes: __collabMock.writes,
    privateProjects: state.projects.filter(project => !project._sharedOwner),
    cache: JSON.parse(localStorage.getItem('scriptwriter_v2') || '{"projects":[]}'),
    accidentalCopy: __collabMock.get(`users/${userId}/projects/${projectId}`),
  }), { projectPath, projectId, userId });
  assert.equal(result.remote.blocks[1].text, 'The collaborator adds a scene.');
  assert.equal(result.remote.revision, 5);
  assert.equal(result.writes.filter(write => write.path === projectPath).length, 1);
  assert.equal(result.writes.find(write => write.path === projectPath).transaction, true);
  assert.equal(result.accidentalCopy, undefined);
  assert.equal(result.privateProjects.some(project => project.id === projectId), false);
  assert.equal(result.cache.projects.some(project => project.id === projectId), false);
  assert.equal(Object.keys(result.remote).some(key => key.startsWith('_shared')), false);
});

test('shared viewer cannot type, rename, or persist edits', async t => {
  const page = await openWriter(t, { role: 'viewer' });
  await waitForShared(page);
  assert.equal(await page.locator('#script-page .action').getAttribute('contenteditable'), 'false');
  assert.equal(await page.locator('#script-title').evaluate(element => element.disabled || element.readOnly), true);
  await page.locator('#script-page .action').click();
  await page.keyboard.type('This should not appear.');
  await page.keyboard.press('Control+s');
  await page.evaluate(async () => {
    updateTitle('Attempted viewer rename');
    await saveProjectToFirestore(getProject());
  });
  const result = await page.evaluate(projectPath => ({ remote: __collabMock.get(projectPath), writes: __collabMock.writes, title: getProject().title }), projectPath);
  assert.equal(await page.locator('#script-page .action').innerText(), 'The original shared scene.');
  assert.equal(result.title, 'Shared screenplay');
  assert.equal(result.remote.title, 'Shared screenplay');
  assert.equal(result.remote.revision, 4);
  assert.deepEqual(result.writes, []);
});

test('a stale editor save preserves the newer cloud revision and exposes conflict recovery', async t => {
  const page = await openWriter(t);
  await waitForShared(page);
  await page.locator('#script-page .action').fill('My unsaved local draft.');
  await page.evaluate(projectPath => {
    clearTimeout(saveTimer);
    const remote = __collabMock.get(projectPath);
    remote.revision = 5;
    remote.blocks[1].text = 'The other collaborator saved first.';
    __collabMock.replace(projectPath, remote, false);
  }, projectPath);
  await saveNow(page);
  assert.equal(await page.evaluate(projectPath => __collabMock.get(projectPath).blocks[1].text, projectPath), 'The other collaborator saved first.');
  assert.equal(await page.locator('#script-page .action').innerText(), 'My unsaved local draft.');
  assert.deepEqual(await page.evaluate(() => __collabMock.writes), []);
  await page.getByRole('button', { name: /Download local draft/i }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download local draft/i }).click();
  const draft = await downloadPromise;
  assert.match(await fs.readFile(await draft.path(), 'utf8'), /My unsaved local draft\./);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /Load latest/i }).click();
  await page.waitForFunction(() => document.querySelector('#script-page .action')?.innerText === 'The other collaborator saved first.');
});

test('live cloud updates refresh clean shared views without producing writes', async t => {
  const page = await openWriter(t);
  await waitForShared(page);
  await page.waitForFunction(projectPath => __collabMock.listening(projectPath), projectPath);
  await page.evaluate(projectPath => {
    const remote = __collabMock.get(projectPath);
    remote.revision = 5;
    remote.blocks[1].text = 'A fresh change from another collaborator.';
    __collabMock.replace(projectPath, remote);
  }, projectPath);
  await page.waitForFunction(() => document.querySelector('#script-page .action')?.innerText === 'A fresh change from another collaborator.');
  assert.deepEqual(await page.evaluate(() => __collabMock.writes), []);
});

test('revoked access clears the open script and blocks future writes', async t => {
  const page = await openWriter(t);
  await waitForShared(page);
  await page.waitForFunction(memberPath => __collabMock.listening(memberPath), memberPath);
  await page.evaluate(memberPath => __collabMock.remove(memberPath), memberPath);
  await page.waitForFunction(() => document.querySelectorAll('#script-page .script-block').length === 0);
  assert.equal(await page.locator('#script-title').inputValue(), '');
  await page.evaluate(() => saveState());
  assert.deepEqual(await page.evaluate(() => __collabMock.writes), []);
  assert.equal(await page.evaluate(projectPath => __collabMock.get(projectPath).revision, projectPath), 4);
});

test('missing membership and an unverified email cannot open a shared screenplay', async t => {
  for (const options of [{ member: false }, { verified: false }]) {
    const page = await openWriter(t, options);
    await page.waitForFunction(() => !document.documentElement.classList.contains('auth-pending'));
    assert.equal(await page.locator('#script-page .script-block').count(), 0);
    assert.equal(await page.locator('#script-title').inputValue(), '');
    assert.match(await page.locator('#collaboration-banner').innerText(), /verified invited email|no longer shared|not shared/i);
    assert.deepEqual(await page.evaluate(() => __collabMock.writes), []);
  }
});

test('an old membership generation loses access when the owner resets collaboration', async t => {
  const page = await openWriter(t);
  await waitForShared(page);
  await page.evaluate(projectPath => {
    const remote = __collabMock.get(projectPath);
    remote.collaborationGeneration = 'generation-2';
    __collabMock.replace(projectPath, remote);
  }, projectPath);
  await page.waitForFunction(() => document.querySelectorAll('#script-page .script-block').length === 0);
  assert.deepEqual(await page.evaluate(() => __collabMock.writes), []);
});

test('shared import becomes a private owned script without copying or changing the shared source', async t => {
  const page = await openWriter(t, { role: 'viewer' });
  await waitForShared(page);
  await importSbx(page, 'My own script.sbx', '<div class="divtype2">A newly imported private script.</div>');
  await page.waitForFunction(() => getProject()?.title === 'My own script');
  await page.locator('#import-overlay').waitFor({ state: 'hidden' });
  await page.waitForFunction(userId => __collabMock.get(`users/${userId}/projects/${getProject().id}`), userId);
  const result = await page.evaluate(({ projectPath, projectId, userId }) => ({
    original: __collabMock.get(projectPath),
    imported: getProject(),
    owned: __collabMock.get(`users/${userId}/projects/${getProject().id}`),
    writes: __collabMock.writes,
    cache: JSON.parse(localStorage.getItem('scriptwriter_v2')),
  }), { projectPath, projectId, userId });
  assert.equal(result.original.blocks[1].text, 'The original shared scene.');
  assert.equal(result.original.revision, 4);
  assert.equal(result.writes.some(write => write.path === projectPath), false);
  assert.notEqual(result.imported.id, projectId);
  assert.equal(result.imported._sharedOwner, undefined);
  assert.equal(result.owned.blocks[0].text, 'A newly imported private script.');
  assert.equal(await page.locator('#script-page .action').getAttribute('contenteditable'), 'true');
  assert.equal(result.cache.projects.some(project => project.id === projectId), false);
  assert.equal(result.cache.projects.some(project => project.id === result.imported.id), true);
});

test('importing immediately after a shared edit saves the owner draft before opening the new private script', async t => {
  const page = await openWriter(t);
  await waitForShared(page);
  await page.locator('#script-page .action').fill('Keep this shared edit when I import another screenplay.');
  await page.evaluate(() => clearTimeout(saveTimer));
  assert.deepEqual(await page.evaluate(() => __collabMock.writes), []);
  await importSbx(page, 'Next screenplay.sbx', '<div class="divtype2">A different private screenplay.</div>');
  await page.waitForFunction(() => getProject()?.title === 'Next screenplay' && writerSaveQueues.size === 0);
  const result = await page.evaluate(({ projectPath, userId }) => ({
    shared: __collabMock.get(projectPath),
    current: getProject(),
    owned: __collabMock.get(`users/${userId}/projects/${getProject().id}`),
    writes: __collabMock.writes,
    cache: JSON.parse(localStorage.getItem('scriptwriter_v2')),
  }), { projectPath, userId });
  assert.equal(result.shared.blocks[1].text, 'Keep this shared edit when I import another screenplay.');
  assert.equal(result.shared.revision, 5);
  assert.equal(result.owned.blocks[0].text, 'A different private screenplay.');
  assert.equal(result.current._sharedOwner, undefined);
  assert.equal(result.writes[0].path, projectPath);
  assert.equal(result.writes[1].path, `users/${userId}/projects/${result.current.id}`);
  assert.equal(result.cache.projects.some(project => project.id === projectId), false);
});

for (const failure of ['conflict', 'offline']) {
  test(`${failure === 'offline' ? 'an offline failure' : 'a conflict'} during import keeps the unsaved shared draft open and preserves the imported private script`, async t => {
    const page = await openWriter(t);
    await waitForShared(page);
    await page.locator('#script-page .action').fill('This pending shared draft must remain recoverable.');
    await page.evaluate(({ projectPath, failure }) => {
      clearTimeout(saveTimer);
      if (failure === 'conflict') {
        const remote = __collabMock.get(projectPath);
        remote.revision = 5;
        remote.blocks[1].text = 'A collaborator saved a newer scene.';
        __collabMock.replace(projectPath, remote, false);
      } else {
        __collabMock.failWrites = true;
      }
    }, { projectPath, failure });
    await importSbx(page, 'Waiting screenplay.sbx', '<div class="divtype2">The imported script should also be preserved.</div>');
    await page.waitForFunction(() => writerSaveQueues.size === 0 && state.projects.some(project => project.title === 'Waiting screenplay'));
    const result = await page.evaluate(projectPath => {
      const leave = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(leave);
      return {
        current: getProject(),
        shared: __collabMock.get(projectPath),
        writes: __collabMock.writes,
        cache: JSON.parse(localStorage.getItem('scriptwriter_v2')),
        promptsBeforeLeaving: leave.defaultPrevented,
      };
    }, projectPath);
    assert.equal(result.current.id, projectId);
    assert.equal(result.current._sharedOwner, ownerId);
    assert.equal(result.current._dirty, true);
    if (failure === 'conflict') assert.equal(result.current._conflict, true);
    assert.equal(await page.locator('#script-page .action').innerText(), 'This pending shared draft must remain recoverable.');
    assert.equal(result.shared.blocks[1].text, failure === 'conflict' ? 'A collaborator saved a newer scene.' : 'The original shared scene.');
    assert.deepEqual(result.writes, []);
    assert.equal(result.cache.projects.find(project => project.title === 'Waiting screenplay').blocks[0].text, 'The imported script should also be preserved.');
    assert.equal(result.cache.projects.some(project => project.id === projectId), false);
    assert.equal(result.promptsBeforeLeaving, true);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download local draft/i }).click();
    const draft = await downloadPromise;
    assert.match(await fs.readFile(await draft.path(), 'utf8'), /This pending shared draft must remain recoverable\./);
  });
}

test('a different account never loads or uploads the previous account private cache', async t => {
  const previousProject = script({ id: 'private-secret', title: 'Previous account private script' });
  const page = await openWriter(t, {
    query: 'new=1',
    cache: { uid: 'previous-user', data: { projects: [previousProject], currentProjectId: previousProject.id, currentView: 'editor', theme: 'dark' } },
  });
  await page.locator('#script-page .script-block').first().waitFor();
  const result = await page.evaluate(() => ({
    projects: state.projects,
    writes: __collabMock.writes,
    uid: localStorage.getItem('tslwrite_cache_uid'),
    preserved: JSON.parse(localStorage.getItem('scriptwriter_v2_account_previous-user') || 'null'),
  }));
  assert.equal(result.uid, userId);
  assert.equal(result.projects.some(project => project.id === 'private-secret'), false);
  assert.equal(result.writes.some(write => write.path.endsWith('/private-secret')), false);
  assert.equal(result.preserved.projects[0].title, 'Previous account private script');
});

test('a private draft whose cloud save failed survives reload and resyncs without losing text', async t => {
  const privateId = 'owned-script';
  const privatePath = `users/${userId}/projects/${privateId}`;
  const cloudProject = script({ id: privateId, title: 'Private draft', collaborationEnabled: false });
  const page = await openWriter(t, {
    query: `project=${privateId}`,
    extraDocuments: { [privatePath]: cloudProject },
  });
  await page.locator('#script-page .action').waitFor();
  await page.locator('#script-page .action').fill('This local draft has not reached the cloud.');
  await page.evaluate(() => {
    clearTimeout(saveTimer);
    __collabMock.failWrites = true;
    saveState();
  });
  await page.waitForFunction(() => writerSaveQueues.size === 0);
  assert.equal(await page.evaluate(privatePath => __collabMock.get(privatePath).blocks[1].text, privatePath), 'The original shared scene.');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('scriptwriter_v2')).projects.find(p => p.id === 'owned-script').blocks[1].text), 'This local draft has not reached the cloud.');

  await page.goto(`${origin}/scriptwriter.html?project=${privateId}`);
  await page.waitForFunction(() => !document.documentElement.classList.contains('auth-pending'));
  await page.locator('#script-page .action').waitFor();
  assert.equal(await page.locator('#script-page .action').innerText(), 'This local draft has not reached the cloud.');
  await page.waitForFunction(privatePath => __collabMock.get(privatePath).blocks[1].text === 'This local draft has not reached the cloud.', privatePath);
  assert.equal(await page.evaluate(privatePath => __collabMock.get(privatePath).revision, privatePath), 5);
});

test('an empty cache-only cloud query preserves the previously saved private screenplay', async t => {
  const privateId = 'offline-private-script';
  const cachedProject = script({ id: privateId, title: 'Previously saved private script', collaborationEnabled: false });
  const page = await openWriter(t, {
    query: `project=${privateId}`,
    collectionFromCache: true,
    cache: { uid: userId, data: { projects: [cachedProject], currentProjectId: privateId, currentView: 'editor', theme: 'dark' } },
  });
  await page.waitForFunction(() => !document.documentElement.classList.contains('auth-pending'));
  await page.locator('#script-page .action').waitFor();
  const result = await page.evaluate(() => ({
    current: getProject(),
    cache: JSON.parse(localStorage.getItem('scriptwriter_v2')),
    writes: __collabMock.writes,
  }));
  assert.equal(result.current.id, privateId);
  assert.equal(result.current.revision, 4);
  assert.equal(await page.locator('#script-page .action').innerText(), 'The original shared scene.');
  assert.equal(result.cache.projects.find(project => project.id === privateId).blocks[1].text, 'The original shared scene.');
  assert.deepEqual(result.writes, []);
});

test('cache-only missing or stale shared snapshots preserve the script until a server deletion is received', async t => {
  const page = await openWriter(t);
  await waitForShared(page);
  await page.waitForFunction(projectPath => __collabMock.listening(projectPath), projectPath);
  await page.evaluate(memberPath => __collabMock.emitCached(memberPath), memberPath);
  assert.equal(await page.locator('#script-page .action').innerText(), 'The original shared scene.');
  assert.equal(await page.evaluate(() => getProject()._sharedRole), 'editor');
  await page.evaluate(memberPath => __collabMock.emitCached(memberPath, { ...__collabMock.get(memberPath), role: 'viewer' }), memberPath);
  assert.equal(await page.locator('#script-page .action').getAttribute('contenteditable'), 'true');
  assert.equal(await page.evaluate(() => getProject()._sharedRole), 'editor');
  await page.evaluate(projectPath => __collabMock.emitCached(projectPath), projectPath);
  assert.equal(await page.locator('#script-page .action').innerText(), 'The original shared scene.');
  assert.equal(await page.evaluate(() => getProject().revision), 4);
  await page.evaluate(projectPath => {
    const stale = __collabMock.get(projectPath);
    stale.revision = 1;
    stale.blocks[1].text = 'An outdated cached scene.';
    __collabMock.emitCached(projectPath, stale);
  }, projectPath);
  assert.equal(await page.locator('#script-page .action').innerText(), 'The original shared scene.');
  assert.equal(await page.evaluate(() => getProject().revision), 4);
  assert.deepEqual(await page.evaluate(() => __collabMock.writes), []);

  await page.evaluate(projectPath => __collabMock.remove(projectPath), projectPath);
  await page.waitForFunction(() => document.querySelectorAll('#script-page .script-block').length === 0);
  assert.equal(await page.locator('#script-title').inputValue(), '');
});

test('signing out immediately after a private edit preserves its text and pending-save flag in the account cache', async t => {
  const privateId = 'signout-private-script';
  const privatePath = `users/${userId}/projects/${privateId}`;
  const page = await openWriter(t, {
    query: `project=${privateId}`,
    extraDocuments: { [privatePath]: script({ id: privateId, title: 'Private script before sign-out', collaborationEnabled: false }) },
  });
  // The test stops at the sign-in destination; it does not exercise a new auth session.
  await page.route('**/index.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Signed out</title>' }));
  await page.locator('#script-page .action').waitFor();
  await page.locator('#script-page .action').fill('Preserve the last words typed before signing out.');
  await page.evaluate(() => { clearTimeout(saveTimer); __collabMock.failWrites = true; });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#btn-signout').click();
  await page.waitForURL(`${origin}/index.html`);
  const result = await page.evaluate(privateId => ({
    draft: JSON.parse(localStorage.getItem('scriptwriter_v2')).projects.find(project => project.id === privateId),
    uid: localStorage.getItem('tslwrite_cache_uid'),
    signOutCalls: Number(sessionStorage.getItem('collaboration-test-signouts') || 0),
  }), privateId);
  assert.equal(result.signOutCalls, 1);
  assert.equal(result.uid, userId);
  assert.equal(result.draft.blocks[1].text, 'Preserve the last words typed before signing out.');
  assert.equal(result.draft._dirty, true);
  assert.equal(result.draft.revision, 4);
});

test('sign-out retains an unsaved shared draft after either a cloud failure or a concurrent-save conflict', async t => {
  for (const failure of ['offline', 'conflict']) {
    const page = await openWriter(t);
    await waitForShared(page);
    await page.locator('#script-page .action').fill('Keep the unsaved shared draft here until it is recovered.');
    await page.evaluate(({ projectPath, failure }) => {
      clearTimeout(saveTimer);
      if (failure === 'offline') {
        __collabMock.failWrites = true;
      } else {
        const remote = __collabMock.get(projectPath);
        remote.revision = 5;
        remote.blocks[1].text = 'The other collaborator saved first.';
        __collabMock.replace(projectPath, remote, false);
      }
    }, { projectPath, failure });
    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(() => signOutUser());
    const result = await page.evaluate(() => ({
      project: getProject(),
      signOutCalls: Number(sessionStorage.getItem('collaboration-test-signouts') || 0),
    }));
    assert.equal(result.signOutCalls, 0);
    assert.equal(result.project.id, projectId);
    assert.equal(result.project._dirty, true);
    if (failure === 'conflict') assert.equal(result.project._conflict, true);
    assert.equal(await page.locator('#script-page .action').innerText(), 'Keep the unsaved shared draft here until it is recovered.');
    assert.match(await page.locator('#collaboration-message').innerText(), /shared draft is still unsaved/i);
    assert.equal(await page.getByRole('button', { name: /Download local draft/i }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: /Load latest/i }).isVisible(), true);
    assert.equal(new URL(page.url()).pathname, '/scriptwriter.html');
  }
});

test('a conflicted private draft retains its original revision through duplicate snapshots, caching, and reload', async t => {
  const privateId = 'conflicted-private-script';
  const privatePath = `users/${userId}/projects/${privateId}`;
  const cloudProject = script({ id: privateId, title: 'Concurrent private draft', collaborationEnabled: false });
  const localDraft = {
    ...cloudProject,
    revision: 3,
    _dirty: true,
    blocks: cloudProject.blocks.map(block => ({ ...block, ...(block.type === 'action' ? { text: 'My unsynced revision-three changes.' } : {}) })),
  };
  const page = await openWriter(t, {
    query: `project=${privateId}`,
    extraDocuments: { [privatePath]: cloudProject },
    cache: { uid: userId, data: { projects: [localDraft], currentProjectId: privateId, currentView: 'editor', theme: 'dark' } },
  });
  await page.waitForFunction(() => writerReady && getProject()?._conflict === true);
  await page.waitForFunction(privatePath => __collabMock.listening(privatePath), privatePath);
  await page.evaluate(privatePath => {
    __collabMock.replace(privatePath, __collabMock.get(privatePath));
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
  }, privatePath);
  const beforeReload = await page.evaluate(() => ({
    current: getProject(),
    cached: JSON.parse(localStorage.getItem('scriptwriter_v2')).projects[0],
    writes: __collabMock.writes,
  }));
  assert.equal(beforeReload.current.revision, 3);
  assert.equal(beforeReload.current._conflict, true);
  assert.equal(beforeReload.cached.revision, 3);
  assert.equal(beforeReload.cached._dirty, true);
  assert.equal(beforeReload.cached._conflict, undefined);
  assert.deepEqual(beforeReload.writes, []);

  await page.goto(`${origin}/scriptwriter.html?project=${privateId}`);
  await page.waitForFunction(() => writerReady && getProject()?._conflict === true);
  assert.equal(await page.locator('#script-page .action').innerText(), 'My unsynced revision-three changes.');
  assert.equal(await page.evaluate(() => getProject().revision), 3);
  assert.equal(await page.getByRole('button', { name: /Download local draft/i }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: /Load latest/i }).isVisible(), true);
  assert.equal(await page.evaluate(privatePath => __collabMock.get(privatePath).blocks[1].text, privatePath), 'The original shared scene.');
  assert.equal(await page.evaluate(privatePath => __collabMock.get(privatePath).revision, privatePath), 4);
  assert.deepEqual(await page.evaluate(() => __collabMock.writes), []);
});
