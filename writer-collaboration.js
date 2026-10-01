'use strict';

// Shared projects use the owner's document. Local drafts stay in the signed-in
// account's cache; a shared screenplay is never copied into another user's library.
let writerProjectSubscription = null;
let writerMemberSubscription = null;
let writerAuthSession = 0;
let writerReady = false;
const writerSaveQueues = new Map();

function writerContent(project) {
  const result = {};
  for (const [key, value] of Object.entries(project)) {
    if (key.startsWith('_') || ['revisions', 'updatedAt', 'revision', 'collaborationEnabled', 'collaborationGeneration'].includes(key)) continue;
    result[key] = value;
  }
  return result;
}

function writerSignature(project) {
  const { updated, ...content } = writerContent(project);
  const stable = value => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
  };
  return JSON.stringify(stable(content));
}

function canEditCurrentProject() {
  const project = getProject();
  return !!project && project._sharedRole !== 'viewer' && !project._accessDenied;
}

function writerProjectRef(project) {
  return _fbDb.collection('users').doc(project._sharedOwner || _currentUser.uid).collection('projects').doc(project.id);
}

function stopWriterSubscriptions() {
  if (writerProjectSubscription) writerProjectSubscription();
  if (writerMemberSubscription) writerMemberSubscription();
  writerProjectSubscription = writerMemberSubscription = null;
}

function storeWriterCache() {
  if (!_currentUser) return;
  const projects = state.projects.filter(project => !project._sharedOwner).map(project => {
    const clean = Object.fromEntries(Object.entries(project).filter(([key]) => !key.startsWith('_') || key === '_dirty'));
    return clean;
  });
  const saved = { ...state, projects, currentOwnerId: null, currentProjectId: !state.currentOwnerId && projects.some(p => p.id === state.currentProjectId) ? state.currentProjectId : null };
  try {
    localStorage.setItem('scriptwriter_v2', JSON.stringify(saved));
  } catch (error) {
    saved.projects.forEach(project => { project.revisions = (project.revisions || []).filter(r => r.label !== 'Auto-save').slice(0, 5); });
    localStorage.setItem('scriptwriter_v2', JSON.stringify(saved));
  }
}

function showCollaborationBanner(message, conflict = false) {
  const banner = document.getElementById('collaboration-banner');
  banner.hidden = false;
  document.getElementById('collaboration-message').textContent = message;
  document.getElementById('collaboration-download').hidden = !conflict;
  document.getElementById('collaboration-reload').hidden = !conflict;
}

function applyWriterAccess() {
  const project = getProject();
  const readonly = !project || project._sharedRole === 'viewer' || project._accessDenied;
  document.body.classList.toggle('shared-readonly', !!project && readonly);
  document.querySelectorAll('#script-page [contenteditable], #script-page[contenteditable]').forEach(el => { el.contentEditable = readonly ? 'false' : 'true'; });
  document.getElementById('script-title').readOnly = readonly;
  document.querySelectorAll('#el-btns button, .note-input-row input, .note-input-row button').forEach(el => { el.disabled = readonly; });
  document.querySelectorAll('[onclick^="openCoverPageDialog"], [onclick^="restoreRevision"], [onclick^="fnrReplace"], [onclick^="deleteNote"]').forEach(el => { el.disabled = readonly; });
  if (project?._conflict) return;
  if (project?._sharedOwner) {
    showCollaborationBanner(project._sharedRole === 'viewer' ? 'Shared screenplay · Read-only access' : 'Shared screenplay · Editor access. Changes sync with the owner.');
  } else if (project) {
    document.getElementById('collaboration-banner').hidden = true;
  }
}

function setWriterConflict(project, message) {
  project._conflict = true;
  clearTimeout(saveTimer);
  if (getProject() === project) {
    showSaveIndicator('error');
    setCloudStatus('error');
    showCollaborationBanner(message || 'A collaborator saved a newer version. Your changes are still here. Download your draft before loading the latest version.', true);
  }
}

function denySharedProject(message) {
  stopWriterSubscriptions();
  clearTimeout(saveTimer);
  const project = getProject();
  if (project) project._accessDenied = true;
  state.projects = state.projects.filter(p => !p._sharedOwner);
  state.currentProjectId = null;
  state.currentOwnerId = null;
  document.querySelectorAll('.script-page, .cover-page').forEach(el => el.remove());
  renderAll();
  showCollaborationBanner(message || 'This shared screenplay is no longer available. Ask its owner for a new invitation.');
  setCloudStatus('error');
}

function applyRemoteWriterProject(project, data) {
  const local = { _sharedOwner: project._sharedOwner, _sharedRole: project._sharedRole, revisions: project.revisions || [] };
  for (const key of Object.keys(project)) delete project[key];
  Object.assign(project, data, local, { _cloudKnown: true, _dirty: false, _conflict: false });
  project._baseline = writerSignature(project);
  if (getProject() === project) renderAll();
  storeWriterCache();
}

function receiveWriterSnapshot(project, snapshot) {
  if (snapshot.metadata?.fromCache) return;
  if (project._saving) { project._pendingSnapshot = snapshot; return; }
  if (!snapshot.exists) {
    if (project._sharedOwner || project._cloudKnown) denySharedProject('This screenplay was deleted or is no longer shared with you.');
    return;
  }
  const remote = { ...snapshot.data(), id: project.id };
  if (project._sharedOwner && remote.collaborationGeneration !== project.collaborationGeneration) {
    denySharedProject();
    return;
  }
  if (writerReady && getProject() === project && canEditCurrentProject()) syncDOMToData();
  const unchanged = writerSignature(remote) === project._baseline;
  if (unchanged) {
    // Keep a conflicted draft's original revision until the user loads the latest.
    // Advancing it here would make a later reload treat stale edits as safe to save.
    if (!project._conflict) project.revision = remote.revision || 0;
    project.collaborationEnabled = remote.collaborationEnabled || false;
    if (remote.collaborationGeneration) project.collaborationGeneration = remote.collaborationGeneration;
    return;
  }
  if (project._conflict || project._dirty || (project._baseline && writerSignature(project) !== project._baseline)) {
    setWriterConflict(project);
    return;
  }
  applyRemoteWriterProject(project, remote);
}

function watchWriterProject(project) {
  stopWriterSubscriptions();
  if (!_fbDb || !_currentUser || !project?._cloudKnown) return;
  const session = writerAuthSession;
  const ref = writerProjectRef(project);
  if (project._sharedOwner) {
    writerMemberSubscription = ref.collection('members').doc(_currentUser.uid).onSnapshot(snapshot => {
      if (session !== writerAuthSession || getProject() !== project) return;
      if (snapshot.metadata?.fromCache) return;
      const member = snapshot.exists ? snapshot.data() : null;
      if (!member || member.generation !== project.collaborationGeneration || member.email !== (_currentUser.email || '').toLowerCase() || !['viewer', 'editor'].includes(member.role)) return denySharedProject();
      if (project._sharedRole !== member.role) {
        if (canEditCurrentProject()) syncDOMToData();
        project._sharedRole = member.role;
        if (project._dirty) setWriterConflict(project, 'Your access changed. Download your unsaved draft before loading the latest version.');
        applyWriterAccess();
      }
    }, () => { if (session === writerAuthSession) denySharedProject(); });
  }
  writerProjectSubscription = ref.onSnapshot(snapshot => {
    if (session === writerAuthSession && getProject() === project) receiveWriterSnapshot(project, snapshot);
  }, error => {
    if (session !== writerAuthSession) return;
    if (project._sharedOwner) denySharedProject();
    else setWriterConflict(project, 'Cloud updates are unavailable. Your local draft is preserved; reconnect before loading the latest version.');
  });
}

async function reloadSharedProject() {
  const project = getProject();
  if (!project || !_currentUser) return;
  if (project._conflict && !confirm('Load the latest saved screenplay? Download your local draft first if you want to keep your unsaved changes.')) return;
  try {
    const snapshot = await writerProjectRef(project).get({ source: 'server' });
    if (!snapshot.exists) return denySharedProject();
    clearTimeout(saveTimer);
    applyRemoteWriterProject(project, { ...snapshot.data(), id: project.id });
    setCloudStatus('synced');
    showSaveIndicator('saved');
  } catch (error) {
    showCollaborationBanner('Could not load the latest screenplay. Check your connection and try again.', true);
  }
}

async function saveCollaborativeProject(project) {
  if (!_fbDb || !_currentUser || !project || project._sharedRole === 'viewer' || project._accessDenied || project._conflict) return;
  const session = writerAuthSession;
  const ref = writerProjectRef(project);
  const key = `${project._sharedOwner || _currentUser.uid}/${project.id}`;
  const previous = writerSaveQueues.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    if (session !== writerAuthSession || project._conflict || project._accessDenied || project._sharedRole === 'viewer') return;
    const content = JSON.parse(JSON.stringify(writerContent(project)));
    const signature = writerSignature(project);
    project._saving = true;
    setCloudStatus('syncing');
    try {
      const saved = await _fbDb.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        const remote = snapshot.exists ? snapshot.data() : null;
        if (!remote && (project._sharedOwner || project._cloudKnown)) throw Object.assign(new Error('Project is no longer available.'), { code: 'permission-denied' });
        if (remote && (remote.revision || 0) !== (project.revision || 0)) throw Object.assign(new Error('A newer version exists.'), { code: 'collaboration/conflict' });
        const revision = remote ? (remote.revision || 0) + 1 : 0;
        transaction.set(ref, { ...content, revision, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return { revision, collaborationEnabled: remote?.collaborationEnabled || false, collaborationGeneration: remote?.collaborationGeneration };
      });
      if (session !== writerAuthSession) return;
      project.revision = saved.revision;
      project.collaborationEnabled = saved.collaborationEnabled;
      if (saved.collaborationGeneration) project.collaborationGeneration = saved.collaborationGeneration;
      project._cloudKnown = true;
      project._baseline = signature;
      project._dirty = writerSignature(project) !== signature;
      storeWriterCache();
      setCloudStatus('synced');
      showSaveIndicator(project._dirty ? 'saving' : 'saved');
      if (getProject() === project && !writerProjectSubscription) watchWriterProject(project);
    } catch (error) {
      if (session !== writerAuthSession) return;
      if (error.code === 'permission-denied' && project._sharedOwner) denySharedProject();
      else if (error.code === 'collaboration/conflict') setWriterConflict(project);
      else {
        project._dirty = true;
        setCloudStatus('error');
        showSaveIndicator('error');
        showCollaborationBanner(project._sharedOwner ? 'Your changes have not reached the owner. Keep this tab open or download your draft, then try saving again.' : 'Saved on this device. Cloud sync failed; try saving again when connected.', true);
      }
    } finally {
      project._saving = false;
      const pending = project._pendingSnapshot;
      delete project._pendingSnapshot;
      if (pending && session === writerAuthSession && !project._accessDenied) receiveWriterSnapshot(project, pending);
    }
  });
  writerSaveQueues.set(key, task);
  await task;
  if (writerSaveQueues.get(key) === task) writerSaveQueues.delete(key);
}

async function initializeWriterForUser(user) {
  const session = ++writerAuthSession;
  writerReady = false;
  stopWriterSubscriptions();
  clearTimeout(saveTimer);
  state = { projects: [], currentProjectId: null, currentOwnerId: null, currentView: 'editor', theme: 'dark' };
  try {
    TSLInvite.prepareAccountCache(user.uid);
  } catch (error) {
    document.documentElement.classList.remove('auth-pending');
    renderAll();
    showCollaborationBanner(error.message || 'This account’s local drafts could not be loaded. Keep this tab open and try again after freeing browser storage.');
    setCloudStatus('error');
    return;
  }
  loadState();
  state.projects = state.projects.filter(project => !project._sharedOwner);
  state.currentOwnerId = null;
  state.projects.forEach(project => {
    project.notes ||= [];
    project.revisions ||= [];
    project.cover ||= { show: false, author: '', contact: '', phone: '', email: '', wga: '', copyright: new Date().getFullYear().toString(), draftDate: '', logline: '' };
  });
  const params = new URLSearchParams(location.search);
  const owner = params.get('owner');
  const projectId = params.get('project');
  try {
    if (owner && owner !== user.uid) {
      state.currentProjectId = null;
      if (!user.emailVerified || !projectId || owner.includes('/') || projectId.includes('/')) throw new Error('Sign in with your verified invited email to open this screenplay.');
      const ref = _fbDb.collection('users').doc(owner).collection('projects').doc(projectId);
      const [projectSnapshot, memberSnapshot] = await Promise.all([ref.get({ source: 'server' }), ref.collection('members').doc(user.uid).get({ source: 'server' })]);
      if (session !== writerAuthSession) return;
      const data = projectSnapshot.exists ? projectSnapshot.data() : null;
      const member = memberSnapshot.exists ? memberSnapshot.data() : null;
      if (!data || !member || member.generation !== data.collaborationGeneration || member.email !== (user.email || '').toLowerCase() || !['editor', 'viewer'].includes(member.role)) throw new Error('This screenplay is no longer shared with your account.');
      const project = { ...data, id: projectId, revisions: [], _sharedOwner: owner, _sharedRole: member.role, _cloudKnown: true, _dirty: false };
      project._baseline = writerSignature(project);
      state.projects.push(project);
      state.currentProjectId = project.id;
      state.currentOwnerId = owner;
      renderAll();
      setView('editor');
      watchWriterProject(project);
    } else {
      if (params.get('new') === '1') state.currentProjectId = createProject('Untitled Script', 'screenplay').id;
      applyDashboardLaunchRequest();
      renderAll();
      setView(state.currentView || 'editor');
      await loadProjectsFromFirestore();
      if (session !== writerAuthSession) return;
      watchWriterProject(getProject());
    }
    document.documentElement.dataset.theme = state.theme;
    applyWriterAccess();
  } catch (error) {
    if (session !== writerAuthSession) return;
    denySharedProject(error.code === 'permission-denied' ? 'This screenplay is not shared with your account.' : error.message);
  } finally {
    if (session === writerAuthSession) {
      document.documentElement.classList.remove('auth-pending');
      writerReady = true;
      renderAll();
      if (getProject()?._conflict) setWriterConflict(getProject());
    }
  }
}

window.addEventListener('beforeunload', event => {
  if (typeof getProject !== 'function') return;
  if (writerReady && _currentUser && canEditCurrentProject()) {
    syncDOMToData();
    const current = getProject();
    if (!current._baseline || writerSignature(current) !== current._baseline) current._dirty = true;
    try { storeWriterCache(); } catch {
      event.preventDefault();
      event.returnValue = '';
    }
  }
  const hasUnsavedSharedDraft = state.projects.some(project => project._sharedOwner && (project._dirty || project._saving || project._conflict));
  if (hasUnsavedSharedDraft) {
    event.preventDefault();
    event.returnValue = '';
  }
});

function guardSharedWriterActions() {
  for (const name of ['updateTitle', 'insertBlockAfter', 'setBlockType', 'addNote', 'deleteNote', 'restoreRevision', 'openCoverPageDialog', 'fnrReplaceOne', 'fnrReplaceAll', 'setSceneColor', 'insertDualDialogue', 'applyAutocomplete', 'deleteProject']) {
    const original = window[name];
    window[name] = function(...args) {
      if (!canEditCurrentProject()) { showFlash('This screenplay is read-only.'); return; }
      return original.apply(this, args);
    };
  }
}
