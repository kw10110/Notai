/* ============ State ============ */
const state = {
  vaultPath: null,
  notes: [],
  databases: [],
  currentRel: null,
  saveTimer: null,
  dbView: 'table',
  dbShown: 100,
  currentDb: null
};

// Persisted custom order for sidebar items (folder names and db names)
const sidebarOrder = {
  folders:   JSON.parse(localStorage.getItem('notai-folder-order')  || '[]'),
  databases: JSON.parse(localStorage.getItem('notai-db-order')      || '[]'),
};
function saveSidebarOrder() {
  localStorage.setItem('notai-folder-order',  JSON.stringify(sidebarOrder.folders));
  localStorage.setItem('notai-db-order',      JSON.stringify(sidebarOrder.databases));
}
function applySidebarOrder(items, key, getName) {
  const order  = sidebarOrder[key];
  const sorted = [...items].sort((a, b) => {
    const ai = order.indexOf(getName(a));
    const bi = order.indexOf(getName(b));
    if (ai === -1 && bi === -1) return getName(a).localeCompare(getName(b));
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return sorted;
}

const $ = (s) => document.querySelector(s);
const editor    = $('#editor');
const docTitle  = $('#docTitle');
const noteList  = $('#noteList');
const dbList    = $('#dbList');
const slashMenu = $('#slashMenu');
const importOverlay = $('#importOverlay');
const importMsg     = $('#importMsg');
const modal         = $('#modal');
const modalBox      = $('#modalBox');
const ctxMenu       = $('#ctxMenu');

/* ============ Modal ============ */
function showModal(html) {
  modalBox.innerHTML = html;
  modal.classList.remove('hidden');
  const first = modalBox.querySelector('input,select,textarea');
  if (first) { first.focus(); if (first.select) first.select(); }
}
function hideModal() { modal.classList.add('hidden'); modalBox.innerHTML = ''; }
modal.addEventListener('click', e => { if (e.target === modal) hideModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    // Don't steal Escape from cell-input (it handles its own Escape to cancel edit)
    if (document.activeElement?.classList.contains('cell-input')) return;
    hideModal(); hideCtx(); hideSlash();
  }
});

/* ============ Context menu ============ */
function showCtx(x, y, items) {
  ctxMenu.innerHTML = items.map(item =>
    item === '---'
      ? '<div class="ctx-sep"></div>'
      : `<div class="ctx-item" data-action="${item.action}">${item.icon ? item.icon + ' ' : ''}${item.label}</div>`
  ).join('');
  ctxMenu.style.left = Math.min(x, window.innerWidth  - 180) + 'px';
  ctxMenu.style.top  = Math.min(y, window.innerHeight - 200) + 'px';
  ctxMenu.classList.remove('hidden');
  ctxMenu.querySelectorAll('.ctx-item').forEach((el, i) => {
    const item = items.filter(x => x !== '---')[i];
    if (item) el.onclick = () => { hideCtx(); item.fn(); };
  });
}
function hideCtx() { ctxMenu.classList.add('hidden'); }
document.addEventListener('click', () => hideCtx());

/* ============ Progress overlay ============ */
function showImportProgress(msg) { importMsg.textContent = msg; importOverlay.classList.remove('hidden'); }
function hideImportProgress()    { importOverlay.classList.add('hidden'); }
window.api.onProgress(msg => { importMsg.textContent = msg; });

/* ============ View switching ============ */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(id).classList.add('active');
}

/* ============ Init ============ */
async function init() {
  const s = await window.api.getSettings();
  state.vaultPath = s.vaultPath;
  if (!state.vaultPath) { showView('#empty'); return; }
  $('#vaultName').textContent = state.vaultPath.split(/[\\/]/).pop();
  await refreshVault();
  showView('#empty');
}

async function refreshVault() {
  state.notes     = await window.api.listVault();
  state.notes.sort((a, b) => b.mtime - a.mtime);
  state.databases = await window.api.listDatabases();
  renderNoteList();
  renderDbList();
}

/* ============ Sidebar — notes ============ */
function getFolders() {
  const folders = new Set();
  state.notes.forEach(n => {
    const parts = n.rel.split('/');
    if (parts.length > 1) folders.add(parts[0]);
  });
  return [...folders].sort();
}

function renderNoteList(filter) {
  noteList.innerHTML = '';
  let notes = state.notes;

  if (filter) {
    const f = filter.toLowerCase();
    notes = notes.filter(n => n.name.toLowerCase().includes(f) || n.rel.toLowerCase().includes(f));
    // Search: flat list, capped at 200 results
    notes.slice(0, 200).forEach(n => noteList.appendChild(makeNoteLi(n)));
    return;
  }

  // Group ALL notes by their top-level folder (no cap — sidebar scrolls)
  const byFolder = {};
  const root     = [];
  notes.forEach(n => {
    const parts = n.rel.split('/');
    if (parts.length > 1) {
      (byFolder[parts[0]] = byFolder[parts[0]] || []).push(n);
    } else {
      root.push(n);
    }
  });

  // Render folder groups in custom order — draggable to reorder
  const folders = applySidebarOrder(Object.keys(byFolder), 'folders', f => f);
  folders.forEach(folder => {
    const folderNotes = byFolder[folder];
    const folderLi    = document.createElement('li');
    folderLi.className  = 'sb-folder';
    folderLi.draggable  = true;
    folderLi.dataset.name = folder;
    folderLi.innerHTML =
      `<span class="drag-grip sb-grip">⠿</span>` +
      `<span class="ico folder-ico">📁</span>` +
      `<span class="folder-name">${folder}</span>` +
      `<span class="folder-count">${folderNotes.length}</span>`;

    folderLi.onclick = (e) => {
      e.stopPropagation();
      folderLi.classList.toggle('open');
      subList.classList.toggle('hidden');
    };
    folderLi.oncontextmenu = (e) => {
      e.preventDefault();
      showCtx(e.clientX, e.clientY, [
        { label: 'New note in folder', icon: '📄', action: 'new',    fn: () => newNoteInFolder(folder) },
        '---',
        { label: 'Rename folder',      icon: '✏️', action: 'rename', fn: () => renameFolder(folder) },
        { label: 'Delete folder',      icon: '🗑',  action: 'delete', fn: () => deleteFolder(folder) },
      ]);
    };
    noteList.appendChild(folderLi);

    const subList = document.createElement('ul');
    subList.className = 'sb-sublist hidden';
    // Sort folder contents by mtime desc
    folderNotes.forEach(n => subList.appendChild(makeNoteLi(n)));
    noteList.appendChild(subList);
  });

  // Root-level notes (no folder)
  root.forEach(n => noteList.appendChild(makeNoteLi(n)));
  // Attach drag-to-reorder on folder items
  attachListDrag(noteList, 'folders', el => el.dataset.name, () => renderNoteList());
}

function makeNoteLi(n) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="ico">📄</span><span>${n.name}</span>`;
  li.className = n.rel === state.currentRel ? 'active' : '';
  li.onclick = () => openNote(n.rel);
  li.oncontextmenu = (e) => { e.preventDefault(); showCtx(e.clientX, e.clientY, [
    { label: 'Rename', icon: '✏️', action: 'rename', fn: () => promptRenameNote(n) },
    { label: 'Delete', icon: '🗑',  action: 'delete', fn: () => promptDeleteNote(n) },
  ]); };
  return li;
}

/* ============ Sidebar — databases ============ */
function renderDbList() {
  dbList.innerHTML = '';
  const ordered = applySidebarOrder(state.databases.filter(d => !d.embedded), 'databases', d => d.name);
  for (const db of ordered) {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.name = db.name;
    li.innerHTML = `<span class="ico drag-grip sb-grip">⠿</span><span class="ico">🗄</span><span>${db.name}</span>`;
    li.className = state.currentDb && state.currentDb.name === db.name ? 'active' : '';
    li.onclick = () => openDatabase(db);
    li.oncontextmenu = (e) => { e.preventDefault(); showCtx(e.clientX, e.clientY, [
      { label: 'Add row',    icon: '＋', action: 'addrow',    fn: () => promptAddRow(db) },
      { label: 'Add column', icon: '＋', action: 'addcol',    fn: () => promptAddColumn(db) },
      '---',
      { label: 'Rename database', icon: '✏️', action: 'rename', fn: () => promptRenameDb(db) },
      { label: 'Delete database', icon: '🗑',  action: 'delete', fn: () => promptDeleteDb(db) },
    ]); };
    dbList.appendChild(li);
  }
  attachListDrag(dbList, 'databases', d => d.dataset.name, () => renderDbList());
}

// Generic drag-to-reorder for sidebar lists (folders or databases)
function attachListDrag(list, orderKey, getName, onReorder) {
  const items = [...list.querySelectorAll('[draggable="true"][data-name]')];
  if (items.length < 2) return;
  let src = null;

  items.forEach(el => {
    el.addEventListener('dragstart', e => {
      src = el;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => el.classList.add('sb-dragging'), 0);
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('sb-dragging');
      list.querySelectorAll('.sb-drag-over').forEach(e => e.classList.remove('sb-drag-over'));
    });
    el.addEventListener('dragover', e => {
      e.preventDefault();
      if (src && src !== el) {
        list.querySelectorAll('.sb-drag-over').forEach(x => x.classList.remove('sb-drag-over'));
        el.classList.add('sb-drag-over');
      }
    });
    el.addEventListener('dragleave', () => el.classList.remove('sb-drag-over'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('sb-drag-over');
      if (!src || src === el) return;

      const allNames = [...list.querySelectorAll('[draggable="true"][data-name]')]
        .map(x => getName(x));
      const fromIdx = allNames.indexOf(getName(src));
      const toIdx   = allNames.indexOf(getName(el));
      if (fromIdx < 0 || toIdx < 0) return;

      allNames.splice(fromIdx, 1);
      allNames.splice(toIdx, 0, getName(src));
      sidebarOrder[orderKey] = allNames;
      saveSidebarOrder();
      onReorder();
    });
  });
}

/* ============ Back / forward navigation ============ */
// Browser-style history across notes and databases, so after opening a row page of a
// nested database you can step back to where you were.
const navHist = [];
let navIdx = -1;
let navBusy = false;

function navPush(type, key) {
  if (navBusy || !key) return;
  const cur = navHist[navIdx];
  if (cur && cur.type === type && cur.key === key) return;
  navHist.length = navIdx + 1;          // opening something new drops the forward history
  navHist.push({ type, key });
  if (navHist.length > 200) navHist.shift();
  navIdx = navHist.length - 1;
  navUpdate();
}

function navUpdate() {
  const b = document.getElementById('navBack'), f = document.getElementById('navFwd');
  if (b) b.disabled = navIdx <= 0;
  if (f) f.disabled = navIdx >= navHist.length - 1;
}

// A note was renamed/moved: keep history entries pointing at it.
function navRename(oldRel, newRel) {
  navHist.forEach(e => { if (e.type === 'note' && e.key === oldRel) e.key = newRel; });
}

async function navGo(delta) {
  const i = navIdx + delta;
  if (i < 0 || i >= navHist.length) return false;
  const e = navHist[i];
  const target = e.type === 'note'
    ? state.notes.find(n => n.rel === e.key)
    : state.databases.find(d => d.name === e.key);
  if (!target) {                          // deleted or renamed since: skip over it
    navHist.splice(i, 1);
    if (delta < 0) navIdx -= 1;
    navUpdate();
    return navGo(delta);
  }
  navIdx = i;
  navBusy = true;
  try {
    if (e.type === 'note') await openNote(e.key);
    else { await saveNote(); openDatabase(target); }
  } finally { navBusy = false; navUpdate(); }
  return true;
}

// Used by the Android hardware back button: true if it navigated.
window._navBackIfPossible = () => { if (navIdx > 0) { navGo(-1); return true; } return false; };

document.getElementById('navBack')?.addEventListener('click', () => navGo(-1));
document.getElementById('navFwd')?.addEventListener('click', () => navGo(1));
document.addEventListener('keydown', e => {
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault(); navGo(e.key === 'ArrowLeft' ? -1 : 1);
  }
});
document.addEventListener('mouseup', e => {   // mouse "back" / "forward" side buttons
  if (e.button === 3) { e.preventDefault(); navGo(-1); }
  else if (e.button === 4) { e.preventDefault(); navGo(1); }
});
navUpdate();

/* ============ Note CRUD ============ */
async function openNote(rel) {
  await saveNote(); // save current before switching
  state.currentRel = rel;
  navPush('note', rel);
  const md = await window.api.readNote(rel);
  const lines = md.split('\n');
  let title = state.notes.find(n => n.rel === rel)?.name || 'Untitled';
  let body  = md;
  if (/^#\s+/.test(lines[0])) { title = lines[0].replace(/^#\s+/, ''); body = lines.slice(1).join('\n').replace(/^\n+/, ''); }
  docTitle.value = title;
  editor.innerHTML = window.MD.mdToHtml(body);
  editor.setAttribute('contenteditable', 'true');
  showView('#editorWrap');
  renderNoteList($('#search').value);
  window.MD.loadVaultImages(editor);
  hydrateEmbeds(editor);
  window._rebuildToc?.();
  editor.focus();
}

function scheduleSave() { clearTimeout(state.saveTimer); state.saveTimer = setTimeout(saveNote, 600); }

async function saveNote() {
  if (!state.currentRel) return;
  const title = (docTitle.value || '').trim() || 'Untitled';
  const body  = window.MD.htmlToMd(editor);
  await window.api.writeNote(state.currentRel, `# ${title}\n\n${body}`);
  const note = state.notes.find(n => n.rel === state.currentRel);
  if (note && note.name !== title) {
    const oldRel = state.currentRel;
    const newRel = await window.api.renameNote(state.currentRel, title);
    state.currentRel = newRel;
    navRename(oldRel, newRel);
    await refreshVault();
  }
}

editor.addEventListener('input', () => { handleSlashTyping(); scheduleSave(); });
docTitle.addEventListener('input', scheduleSave);
docTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); editor.focus(); } });

async function newNote(folder) {
  if (!state.vaultPath) return chooseVault();
  const rel = await window.api.createNote('Untitled', folder);
  await refreshVault();
  await openNote(rel);
  docTitle.focus(); docTitle.select();
}

async function newNoteInFolder(folder) { await newNote(folder); }

function promptRenameNote(n) {
  showModal(`
    <h3>Rename note</h3>
    <input id="mi0" value="${n.name.replace(/"/g,'&quot;')}" />
    <div class="modal-btns">
      <button id="mCancel" class="modal-btn ghost">Cancel</button>
      <button id="mOk" class="modal-btn primary">Rename</button>
    </div>`);
  $('#mOk').onclick = async () => {
    const v = $('#mi0').value.trim();
    if (!v) return;
    const newRel = await window.api.renameNote(n.rel, v);
    if (state.currentRel === n.rel) state.currentRel = newRel;
    hideModal(); await refreshVault();
  };
  $('#mi0').onkeydown = e => { if (e.key === 'Enter') $('#mOk').click(); };
  $('#mCancel').onclick = hideModal;
}

function promptDeleteNote(n) {
  showModal(`
    <h3>Delete note?</h3>
    <p>This will permanently delete <strong>${n.name}</strong>.</p>
    <div class="modal-btns">
      <button id="mCancel" class="modal-btn ghost">Cancel</button>
      <button id="mOk" class="modal-btn danger">Delete</button>
    </div>`);
  $('#mOk').onclick = async () => {
    await window.api.deleteNote(n.rel);
    if (state.currentRel === n.rel) { state.currentRel = null; showView('#empty'); }
    hideModal(); await refreshVault();
  };
  $('#mCancel').onclick = hideModal;
}

/* ============ Folder operations ============ */
async function promptNewFolder() {
  showModal(`
    <h3>New folder</h3>
    <input id="mi0" placeholder="Folder name" />
    <div class="modal-btns">
      <button id="mCancel" class="modal-btn ghost">Cancel</button>
      <button id="mOk" class="modal-btn primary">Create</button>
    </div>`);
  $('#mOk').onclick = async () => {
    const v = $('#mi0').value.trim();
    if (!v) return;
    hideModal();
    await newNoteInFolder(v);
  };
  $('#mi0').onkeydown = e => { if (e.key === 'Enter') $('#mOk').click(); };
  $('#mCancel').onclick = hideModal;
}

async function renameFolder(folder) {
  showModal(`
    <h3>Rename folder</h3>
    <input id="mi0" value="${folder.replace(/"/g,'&quot;')}" />
    <div class="modal-btns">
      <button id="mCancel" class="modal-btn ghost">Cancel</button>
      <button id="mOk" class="modal-btn primary">Rename</button>
    </div>`);
  $('#mOk').onclick = async () => {
    const newName = $('#mi0').value.trim();
    if (!newName || newName === folder) { hideModal(); return; }
    // Rename each note in the folder
    const inFolder = state.notes.filter(n => n.rel.startsWith(folder + '/'));
    for (const n of inFolder) {
      const newRel = newName + '/' + n.rel.slice(folder.length + 1);
      await window.api.writeNote(newRel, await window.api.readNote(n.rel));
      await window.api.deleteNote(n.rel);
      if (state.currentRel === n.rel) state.currentRel = newRel;
    }
    hideModal(); await refreshVault();
  };
  $('#mi0').onkeydown = e => { if (e.key === 'Enter') $('#mOk').click(); };
  $('#mCancel').onclick = hideModal;
}

async function deleteFolder(folder) {
  const count = state.notes.filter(n => n.rel.startsWith(folder + '/')).length;
  showModal(`
    <h3>Delete folder?</h3>
    <p>Delete <strong>${folder}</strong> and all ${count} note(s) inside?</p>
    <div class="modal-btns">
      <button id="mCancel" class="modal-btn ghost">Cancel</button>
      <button id="mOk" class="modal-btn danger">Delete all</button>
    </div>`);
  $('#mOk').onclick = async () => {
    const inFolder = state.notes.filter(n => n.rel.startsWith(folder + '/'));
    for (const n of inFolder) await window.api.deleteNote(n.rel);
    if (state.currentRel && state.currentRel.startsWith(folder + '/')) { state.currentRel = null; showView('#empty'); }
    hideModal(); await refreshVault();
  };
  $('#mCancel').onclick = hideModal;
}

/* ============ Database CRUD ============ */
function promptNewDb() {
  showModal(`
    <h3>New database</h3>
    <label class="modal-label">Database name</label>
    <input id="mi0" placeholder="e.g. Projects" />
    <label class="modal-label">Columns <span class="modal-hint">(comma-separated, Name is always first)</span></label>
    <input id="mi1" placeholder="e.g. Status, Tags, Notes" />
    <div class="modal-btns">
      <button id="mCancel" class="modal-btn ghost">Cancel</button>
      <button id="mOk" class="modal-btn primary">Create</button>
    </div>`);
  $('#mOk').onclick = async () => {
    const name = $('#mi0').value.trim();
    if (!name) return;
    const extraCols = $('#mi1').value.split(',').map(s => s.trim()).filter(Boolean);
    const headers   = ['Name', ...extraCols];
    const db        = { name, headers, rows: [] };
    await window.api.saveDatabase(db);
    hideModal(); await refreshVault();
    const fresh = state.databases.find(d => d.name === name);
    if (fresh) showDb(fresh);
  };
  $('#mi0').onkeydown = e => { if (e.key === 'Enter') $('#mi1').focus(); };
  $('#mi1').onkeydown = e => { if (e.key === 'Enter') $('#mOk').click(); };
  $('#mCancel').onclick = hideModal;
}

// The column holding each row's title (and linking to its markdown page). Not always
// called "Name": Notion databases can name it anything. Stored as db.titleCol when known;
// otherwise "Name" if present, else the first visible column.
function titleKey(db) {
  const hs = db.headers || [];
  if (db.titleCol && hs.includes(db.titleCol)) return db.titleCol;
  if (hs.includes('Name')) return 'Name';
  return hs.find(h => !String(h).startsWith('_')) || 'Name';
}

// Display name (original, e.g. "Subtasks") vs. unique key (db.name, may be a vault path for page-owned databases)
function dbTitle(db) { return db.title || db.name; }
// Argument telling the main process which vault folder a database's rows/attachments live in.
function dbArg(db) { return db.folder ? 'folder:' + db.folder : db.name; }

function promptAddRow(db) {
  const tk = titleKey(db);
  const propCols = db.headers.filter(h => h !== tk && !h.startsWith('_'));
  const fields = propCols.map((h, i) => `
    <label class="modal-label">${h}</label>
    <input id="mf${i}" placeholder="${h}" />`).join('');
  showModal(`
    <h3>Add row to ${escapeHtml(dbTitle(db))}</h3>
    <label class="modal-label">${escapeHtml(tk)}</label>
    <input id="mi0" placeholder="Page title" />
    ${fields}
    <div class="modal-btns">
      <button id="mCancel" class="modal-btn ghost">Cancel</button>
      <button id="mOk" class="modal-btn primary">Add row</button>
    </div>`);
  $('#mOk').onclick = async () => {
    const name = $('#mi0').value.trim();
    if (!name) return;
    const row  = { [tk]: name };
    propCols.forEach((h, i) => { row[h] = ($(`#mf${i}`) || {}).value || ''; });
    // Create the linked MD page
    const mdRel = await window.api.createDbPage(dbArg(db), name);
    row._mdRel = mdRel; row._attachments = [];
    db.rows.push(row);
    await window.api.saveDatabase(db);
    hideModal(); await refreshVault();
    // Re-open the db with the updated data
    const fresh = state.databases.find(d => d.name === db.name);
    if (fresh) showDb(fresh);
  };
  $('#mi0').onkeydown = e => { if (e.key === 'Enter') { const f = $('#mf0'); if (f) f.focus(); else $('#mOk').click(); } };
  $('#mCancel').onclick = hideModal;
}

function promptAddColumn(db) {
  showModal(`
    <h3>Add column to ${escapeHtml(dbTitle(db))}</h3>
    <label class="modal-label">Column name</label>
    <input id="mi0" placeholder="e.g. Status, Tags, Attachments" />
    <label class="modal-label">Column type</label>
    <select id="mi2">
      <option value="text">Text / Select / Multi-select</option>
      <option value="url">URL / Link</option>
      <option value="attachments">Attachments (file links)</option>
    </select>
    <label class="modal-label">Default value <span class="modal-hint">(optional, text columns only)</span></label>
    <input id="mi1" placeholder="" />
    <div class="modal-btns">
      <button id="mCancel" class="modal-btn ghost">Cancel</button>
      <button id="mOk" class="modal-btn primary">Add column</button>
    </div>`);
  $('#mOk').onclick = async () => {
    let col = $('#mi0').value.trim();
    const type = $('#mi2').value;
    if (!col) return;
    // For attachments type, normalise name
    if (type === 'attachments' && !/^attachment/i.test(col)) col = 'Attachments';
    // If the exact column already exists, just close — no duplicate
    if (db.headers.includes(col)) {
      hideModal();
      alert(`Column "${col}" already exists in this database.`);
      return;
    }
    const def = (type === 'attachments') ? '' : ($('#mi1').value.trim());
    db.headers.push(col);
    db.rows.forEach(r => {
      if (type === 'attachments') { if (!r._attachments) r._attachments = []; }
      r[col] = r[col] !== undefined ? r[col] : def;
    });
    if (type === 'url' || type === 'attachments') {
      if (!db.colTypes) db.colTypes = {};
      db.colTypes[col] = type;
    }
    // Invalidate column order cache so new column appears immediately
    dbColState.delete(db.name);
    await window.api.saveDatabase(db);
    hideModal(); await refreshVault();
    const fresh = state.databases.find(d => d.name === db.name);
    if (fresh) showDb(fresh);
  };
  $('#mi0').onkeydown = e => { if (e.key === 'Enter') $('#mi1').focus(); };
  $('#mi1').onkeydown = e => { if (e.key === 'Enter') $('#mOk').click(); };
  $('#mCancel').onclick = hideModal;
}

function promptRenameDb(db) {
  showModal(`
    <h3>Rename database</h3>
    <input id="mi0" value="${db.name.replace(/"/g,'&quot;')}" />
    <div class="modal-btns">
      <button id="mCancel" class="modal-btn ghost">Cancel</button>
      <button id="mOk" class="modal-btn primary">Rename</button>
    </div>`);
  $('#mOk').onclick = async () => {
    const newName = $('#mi0').value.trim();
    if (!newName || newName === db.name) { hideModal(); return; }
    await window.api.deleteDatabase(db.name);
    dbColState.delete(db.name);  // clear cache for old name
    db.name = newName;
    dbColState.delete(newName);  // clear for new name too
    await window.api.saveDatabase(db);
    hideModal(); await refreshVault();
    const fresh = state.databases.find(d => d.name === newName);
    if (fresh) showDb(fresh);
  };
  $('#mi0').onkeydown = e => { if (e.key === 'Enter') $('#mOk').click(); };
  $('#mCancel').onclick = hideModal;
}

function promptDeleteDb(db) {
  showModal(`
    <h3>Delete database?</h3>
    <p>This removes the database <strong>${db.name}</strong> and its view. The notes inside are kept in your vault.</p>
    <div class="modal-btns">
      <button id="mCancel" class="modal-btn ghost">Cancel</button>
      <button id="mOk" class="modal-btn danger">Delete</button>
    </div>`);
  $('#mOk').onclick = async () => {
    await window.api.deleteDatabase(db.name);
    if (state.currentDb && state.currentDb.name === db.name) { state.currentDb = null; showView('#empty'); }
    hideModal(); await refreshVault();
  };
  $('#mCancel').onclick = hideModal;
}

/* ============ Database view ============ */
const PAGE = 100;
const dbCache    = new Map();
const dbColState = new Map();
// Per-db active filter: { col -> Set of allowed values } and search query
const dbFilters  = new Map(); // dbName -> { search:'', colFilters:{col: Set} }
const dbSortState = new Map(); // dbName -> { col: 'name'|'_mtime'|'_created', dir: 'asc'|'desc' }

function getDbFilter(db) {
  if (!dbFilters.has(db.name)) dbFilters.set(db.name, { search: '', colFilters: {} });
  return dbFilters.get(db.name);
}
function getDbSort(db) {
  if (!dbSortState.has(db.name)) dbSortState.set(db.name, { col: null, dir: 'asc' });
  return dbSortState.get(db.name);
}

function getColState(db) {
  if (!dbColState.has(db.name)) {
    const tkc = titleKey(db);
    const propHeaders = db.headers.filter(h => h !== tkc && !h.startsWith('_'));
    dbColState.set(db.name, { order: [...propHeaders], locked: false, widths: {} });
  }
  const s = dbColState.get(db.name);
  if (!s.widths) s.widths = {}; // migrate old entries
  return s;
}

function guessGroupCol(headers) {
  return headers.find(h => /^(type|status|state|stage|category|label|tag|select|group)$/i.test(h))
    || headers.find(h => /type|status|state|stage|category/i.test(h))
    || null;
}

// Detect URL column — by name convention OR explicit colTypes metadata
function isUrlCol(colName, db) {
  if (db && db.colTypes && db.colTypes[colName] === 'url') return true;
  return /^(url|link|href|website|site|reference|ref)s?$/i.test(colName.trim());
}
// Detect attachment column
function isAttCol(colName, db) {
  if (db && db.colTypes && db.colTypes[colName] === 'attachments') return true;
  return /^attachment/i.test(colName);
}

const PILL_COLORS = ['#e8f0fe','#fce8e6','#e6f4ea','#fef7e0','#f3e8fd','#e8f5e9','#fff3e0','#e3f2fd'];
const pillColor = (() => {
  const map={}; let idx=0;
  return v=>{ if(!map[v]) map[v]=PILL_COLORS[(idx++)%PILL_COLORS.length]; return map[v]; };
})();

function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// Detect if a value is "rich" — has newlines or is long enough that it needs more than a pill
function isRichText(v) {
  return v && (v.includes('\n') || v.length > 80);
}

// A short value like "**Important**" or "<u>flagged</u>" is meant to be
// rendered as formatted text, not treated as a plain tag/category label —
// without this check it would fall into the pill-rendering branch below and
// show the literal, escaped markup characters instead of being interpreted.
function hasInlineFormatting(v) {
  return /\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|<u>[\s\S]*?<\/u>|<span style="(?:color|background-color):/.test(v);
}

// Render a plain cell value as formatted HTML.
// Short/tag-like values → coloured pills.
// Multi-line, long, or explicitly-formatted content → rendered as mini-markdown
// preserving structure and inline formatting (bold/underline/color/code).
function renderProp(v) {
  if (!v || v === 'NIL') return '<span class="cell-empty">—</span>';

  // Multi-line, long, or contains formatting markup: render as formatted block
  if (isRichText(v) || hasInlineFormatting(v)) return renderRichCell(v);

  // Comma-separated short tags → pills
  if (v.includes(',') && v.split(',').every(x => x.trim().length < 35))
    return v.split(',').map(x => {
      const t = x.trim();
      return t ? `<span class="pill" style="background:${pillColor(t)}">${escapeHtml(t)}</span>` : '';
    }).join('');

  // Single short value → pill
  if (v.length < 35) return `<span class="pill" style="background:${pillColor(v)}">${escapeHtml(v)}</span>`;

  return renderRichCell(v);
}

// Render multiline / long cell content as structured HTML.
// Preserves: blank-line paragraph breaks, numbered lists, bullet lists,
// inline code (backticks), bold (**), and plain text lines.
// Backtick code spans in a Notion-imported cell value can legitimately
// contain embedded newlines — Notion applies the "code" formatting
// annotation to a whole multi-line shell snippet as a single run, which
// exports as one pair of backticks wrapping several lines. If we split the
// cell into lines FIRST and only look for backtick pairs within a single
// line (as inlineRich does), an opening backtick on one line and its
// closing backtick several lines later never match each other — each just
// shows up as a stray literal backtick character, and none of that content
// gets the code styling at all. Extract every complete backtick span from
// the RAW, un-split value first, rendering each one (newlines preserved as
// <br>) and replacing it with a single-line placeholder token before any
// line-splitting happens — so multi-line code spans survive intact
// regardless of how many lines they cover.
function extractCodeSpans(v) {
  const placeholders = [];
  const text = v.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = placeholders.length;
    const isMultiline = code.includes('\n');
    const html = escapeHtml(code).replace(/\n/g, '<br>');
    // Only genuinely multi-line spans get the block treatment — a short,
    // single-line snippet like `.exe` or `ActiveXObject` should flow inline
    // with the surrounding text, not stretch to fill the whole line width.
    placeholders.push(isMultiline ? `<code class="rich-code-block">${html}</code>` : `<code>${html}</code>`);
    return `\x00CODESPAN${idx}\x00`;
  });
  return { text, placeholders };
}

function renderRichCell(v) {
  const { text, placeholders: codePlaceholders } = extractCodeSpans(v);
  const lines = text.split('\n');
  const parts = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd(); // keep leading spaces for code/indent detection

    // Blank line → paragraph break (skip, handled by block structure)
    if (line.trim() === '') { i++; continue; }

    // Numbered list item: "  1. text" or "1. text"
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inlineRich(lines[i].replace(/^\s*\d+\.\s+/, '').trimEnd())}</li>`);
        i++;
      }
      parts.push(`<ol class="rich-list">${items.join('')}</ol>`);
      continue;
    }

    // Bullet list item: "  - text" or "• text"
    if (/^\s*[-•*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-•*]\s+/.test(lines[i])) {
        items.push(`<li>${inlineRich(lines[i].replace(/^\s*[-•*]\s+/, '').trimEnd())}</li>`);
        i++;
      }
      parts.push(`<ul class="rich-list">${items.join('')}</ul>`);
      continue;
    }

    // Paragraph — collect consecutive non-blank, non-list lines
    const paraLines = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') { i++; break; }
      if (/^\s*\d+\.\s+/.test(l) || /^\s*[-•*]\s+/.test(l)) break;
      paraLines.push(inlineRich(l.trimEnd()));
      i++;
    }
    if (paraLines.length) parts.push(`<p class="rich-p">${paraLines.join('<br>')}</p>`);
  }

  if (!parts.length) return escapeHtml(v);
  let html = `<div class="rich-cell">${parts.join('')}</div>`;
  html = html.replace(/\x00CODESPAN(\d+)\x00/g, (_, idx) => codePlaceholders[+idx]);
  return html;
}

// Database property values pulled from Notion can occasionally be truncated
// mid-formatting-run (a long colored/underlined span whose closing tag never
// arrives). Rather than showing the raw, ugly "<span style=..." as literal
// text, auto-close any genuinely dangling (complete-opening-tag-but-no-
// matching-close) <u>/<span style> tags by appending the missing closer(s).
// Uses a simple open/close COUNT comparison — complete pairs contribute
// equally to both counts and cancel out, leaving only real dangling opens.
// This does NOT touch tags that are incomplete/garbled at the point of
// truncation (e.g. a bare "<span style=" with no attribute value) — those
// still safely fall through to escaped literal text, since there's no
// color value to recover.
function autoCloseDanglingTags(s) {
  const uOpens    = (s.match(/<u>/g) || []).length;
  const uCloses   = (s.match(/<\/u>/g) || []).length;
  const spanOpens = (s.match(/<span style="(?:color|background-color):[^"]+">/g) || []).length;
  const spanCloses = (s.match(/<\/span>/g) || []).length;
  let out = s;
  for (let i = 0; i < uOpens - uCloses; i++) out += '</u>';
  for (let i = 0; i < spanOpens - spanCloses; i++) out += '</span>';
  return out;
}

// Inline formatting for rich cell content. Supports the same markup
// conventions used in the main note editor: bold, italic, strikethrough,
// inline code, and (imported from Notion) underline + text/background
// color via passthrough <u>/<span style> tags. Colored/underlined tags must
// be extracted BEFORE the HTML-escape step (same technique as markdown.js's
// inline()) — escaping first would turn <u> into &lt;u&gt; and it would
// show as literal visible text instead of being rendered.
function inlineRich(s) {
  let out = autoCloseDanglingTags(s);

  const wrapPlaceholders = [];
  out = out.replace(
    /<u>([\s\S]*?)<\/u>|<span style="(color|background-color):([^"]+)">([\s\S]*?)<\/span>/g,
    (_m, uInner, spanProp, spanCss, spanInner) => {
      const idx = wrapPlaceholders.length;
      if (uInner !== undefined) {
        wrapPlaceholders.push({ kind: 'u', html: inlineRich(uInner) });
      } else {
        wrapPlaceholders.push({ kind: 'span', prop: spanProp, css: spanCss, html: inlineRich(spanInner) });
      }
      return `\x00WRAP${idx}\x00`;
    }
  );

  out = escapeHtml(out)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '<a href="$2" target="_blank">$2</a>');

  out = out.replace(/\x00WRAP(\d+)\x00/g, (_, i) => {
    const w = wrapPlaceholders[+i];
    if (w.kind === 'u') return `<u>${w.html}</u>`;
    return `<span style="${w.prop}:${w.css}">${w.html}</span>`;
  });

  return out;
}

function renderUrl(v) {
  if (!v) return '<span class="cell-empty">—</span>';
  const urls = v.split(/[\s,]+/).filter(Boolean);
  return urls.map(u => {
    const href = /^https?:\/\//i.test(u) ? u : 'https://' + u;
    const label = u.replace(/^https?:\/\//i,'').replace(/\/.*$/,'').slice(0,40);
    return `<a class="url-chip" href="${escapeHtml(href)}" title="${escapeHtml(u)}" data-url="${escapeHtml(href)}">🔗 ${escapeHtml(label)}</a>`;
  }).join(' ');
}

function renderAttChips(attachments) {
  const atts = attachments || [];
  if (!atts.length) return '<span class="cell-empty att-empty">📎 Add file…</span>';
  return atts.map(a =>
    `<span class="att-chip ${a.exists?'':'missing'}" data-vault="${escapeHtml(a.vaultRel)}" title="${escapeHtml(a.filename)}">📎 ${escapeHtml(a.filename)}</span>`
  ).join('');
}

function renderCol(colName, value, attachments) {
  if (isAttCol(colName, null))  return renderAttChips(attachments);
  if (isUrlCol(colName, null))  return renderUrl(value);
  return renderProp(value);
}

// Filter rows based on active search + column filters
function applyFilters(rows, filterState) {
  let result = rows;
  const { search, colFilters } = filterState;
  if (search) {
    const q = search.toLowerCase();
    result = result.filter(row =>
      Object.values(row).some(v => typeof v === 'string' && v.toLowerCase().includes(q))
    );
  }
  for (const [col, allowed] of Object.entries(colFilters)) {
    if (!allowed || !allowed.size) continue;
    result = result.filter(row => {
      const val = (row[col] || '');
      const tags = val.split(',').map(t => t.trim()).filter(Boolean);
      return tags.length ? tags.some(t => allowed.has(t)) : allowed.has('(empty)');
    });
  }
  return result;
}

// Sort rows: 'name' = alphabetical by Name, '_mtime' = by _mtime field, '_created' = by row index
function applySort(rows, sortState, origRows, tk = 'Name') {
  if (!sortState || !sortState.col) return rows;
  const { col, dir } = sortState;
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (col === 'name') {
      return mul * String(a[tk] || '').localeCompare(String(b[tk] || ''));
    }
    if (col === '_created') {
      return mul * ((origRows.indexOf(a)) - (origRows.indexOf(b)));
    }
    // Sort by any column value alphabetically
    return mul * ((a[col] || '').localeCompare(b[col] || ''));
  });
}

// Get all unique tag values for a column (for filter popover)
function getColValues(rows, col) {
  const vals = new Set();
  rows.forEach(row => {
    const v = (row[col] || '').trim();
    if (!v) { vals.add('(empty)'); return; }
    v.split(',').map(t=>t.trim()).filter(Boolean).forEach(t => vals.add(t));
  });
  return [...vals].sort();
}

// Where a database view is currently mounted: the full-page #dbWrap view (default)
// or an inline block inside the open note.
const dbRoots = new Map();
function dbRoot(db) {
  const el = dbRoots.get(db.name);
  return (el && el.isConnected) ? el : document;
}
function dbQ(db, sel) { return dbRoot(db).querySelector(sel); }

// Re-show a database after its data was reloaded: refresh inline if it lives in
// the open note, otherwise open the full view.
function showDb(db) {
  const el = dbRoots.get(db.name);
  if (el && el.isConnected) { dbCache.set(db.name, db); renderDatabase(db); }
  else openDatabase(db);
}

function openDatabase(db) {
  navPush('db', db.name);
  dbRoots.delete(db.name);
  dbCache.set(db.name, db);
  state.currentDb = db;
  showView('#dbWrap');
  state.dbView = 'table';
  state.dbShown = PAGE;
  renderDatabase(db);
  renderDbList();
}

// Active filter popover (close on outside click)
let activeFilterPopover = null;
function closeFilterPopover() {
  if (activeFilterPopover) { activeFilterPopover.remove(); activeFilterPopover = null; }
}

function showFilterPopover(th, db, col) {
  closeFilterPopover();
  const filterState = getDbFilter(db);
  const allVals     = getColValues(db.rows, col);
  const active      = filterState.colFilters[col] || new Set();

  const pop = document.createElement('div');
  pop.className = 'filter-popover';
  pop.innerHTML = `
    <div class="filter-title">Filter: ${escapeHtml(col)}</div>
    <input class="filter-search" placeholder="Search values…" />
    <div class="filter-list">
      ${allVals.map(v => `
        <label class="filter-item">
          <input type="checkbox" value="${escapeHtml(v)}" ${active.has(v)?'checked':''} />
          ${v === '(empty)' ? '<em>(empty)</em>' : `<span class="pill" style="background:${pillColor(v)}">${escapeHtml(v)}</span>`}
        </label>`).join('')}
    </div>
    <div class="filter-btns">
      <button class="filter-btn" id="fpClear">Clear</button>
      <button class="filter-btn primary" id="fpApply">Apply</button>
    </div>`;

  // Position relative to the th
  const rect = th.getBoundingClientRect();
  pop.style.left = rect.left + 'px';
  pop.style.top  = (rect.bottom + 4) + 'px';
  document.body.appendChild(pop);
  activeFilterPopover = pop;

  // Live search within popover
  pop.querySelector('.filter-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    pop.querySelectorAll('.filter-item').forEach(item => {
      item.style.display = item.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  pop.querySelector('#fpClear').onclick = () => {
    delete filterState.colFilters[col];
    closeFilterPopover();
    renderDatabase(db);
  };

  pop.querySelector('#fpApply').onclick = () => {
    const checked = new Set([...pop.querySelectorAll('input[type=checkbox]:checked')].map(c=>c.value));
    if (checked.size) filterState.colFilters[col] = checked;
    else delete filterState.colFilters[col];
    closeFilterPopover();
    renderDatabase(db);
  };

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!pop.contains(e.target)) { closeFilterPopover(); document.removeEventListener('click', handler); }
    });
  }, 0);
}

function renderDatabase(db) {
  const { headers, rows } = db;
  const colState    = getColState(db);
  const filterState = getDbFilter(db);
  const sortState   = getDbSort(db);
  const groupCol    = guessGroupCol(headers);

  // Apply search + column filters, then sort
  let filteredRows = applyFilters(rows, filterState);
  filteredRows     = applySort(filteredRows, sortState, rows, titleKey(db));
  const total    = filteredRows.length;
  const totalAll = rows.length;

  const activeFilters = Object.values(filterState.colFilters).filter(s=>s&&s.size>0).length;

  // Sort dropdown options: Name A-Z, Name Z-A, then each property column
  const sortCols = [
    { value: '',         label: 'Default order' },
    { value: 'name|asc', label: `${titleKey(db)} A → Z` },
    { value: 'name|desc',label: `${titleKey(db)} Z → A` },
    { value: '_created|asc',  label: 'Created (oldest first)' },
    { value: '_created|desc', label: 'Created (newest first)' },
    ...headers.filter(h => h !== titleKey(db) && !h.startsWith('_') && !isAttCol(h, db) && !isUrlCol(h, db))
              .map(h => ({ value: `${h}|asc`, label: `${h} A → Z` })),
  ];
  const curSortVal = sortState.col ? `${sortState.col}|${sortState.dir}` : '';

  dbQ(db,'#dbToolbar').innerHTML =
    `<h1>${escapeHtml(dbTitle(db))}</h1>` +
    `<span class="db-count">${total === totalAll ? totalAll : `${total} / ${totalAll}`} rows</span>` +
    `<div class="db-search-wrap"><input id="dbSearch" class="db-search" placeholder="Search…" value="${escapeHtml(filterState.search)}" /></div>` +
    `<select id="dbSortSel" class="db-sort-sel" title="Sort rows">${sortCols.map(o => `<option value="${escapeHtml(o.value)}" ${curSortVal===o.value?'selected':''}>${escapeHtml(o.label)}</option>`).join('')}</select>` +
    `${activeFilters ? `<span class="filter-badge">${activeFilters} filter${activeFilters>1?'s':''}</span>` : ''}` +
    `<button id="btnAddRow" class="db-action-btn primary">＋ New row</button>` +
    `<button id="btnAddCol" class="db-action-btn">＋ Column</button>` +
    `<button id="btnColLock" class="col-lock-btn ${colState.locked?'locked':''}">${colState.locked?'🔒 Locked':'🔓 Reorder'}</button>`;

  dbQ(db,'#btnAddRow').onclick  = () => promptAddRow(db);
  dbQ(db,'#btnAddCol').onclick  = () => promptAddColumn(db);
  dbQ(db,'#btnColLock').onclick = () => { colState.locked = !colState.locked; renderDatabase(db); };

  dbQ(db,'#dbSortSel').addEventListener('change', e => {
    const [col, dir] = e.target.value.split('|');
    sortState.col = col || null;
    sortState.dir = dir || 'asc';
    state.dbShown = PAGE;
    renderDatabase(db);
  });

  let searchTimer;
  dbQ(db,'#dbSearch').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      filterState.search = e.target.value;
      state.dbShown = PAGE;
      renderDatabase(db);
    }, 150);
  });
  dbQ(db,'#dbSearch').addEventListener('keydown', e => { if (e.key === 'Escape') { filterState.search = ''; e.target.value=''; state.dbShown=PAGE; renderDatabase(db); } });

  const tabs = `<div class="db-tabs">
    <div class="db-tab ${state.dbView==='table'?'active':''}" data-v="table">⊞ Table</div>
    ${groupCol ? `<div class="db-tab ${state.dbView==='board'?'active':''}" data-v="board">⊟ Board</div>` : ''}
  </div>`;

  const wrap = dbQ(db,'#dbTableWrap');

  if (state.dbView === 'table') {
    const shown    = Math.min(state.dbShown, total);
    const colOrder = colState.order;
    const parts    = ['<table class="db" id="dbTable"><thead><tr>'];
    // Name column — fixed width with resize handle
    const tk = titleKey(db);
    const nameW = colState.widths[tk] || 220;
    parts.push(`<th class="col-name" data-col="${escapeHtml(tk)}" style="width:${nameW}px;min-width:80px">${escapeHtml(tk)}<span class="col-resize-handle" data-col="${escapeHtml(tk)}"></span></th>`);
    colOrder.forEach((h, ci) => {
      const drag      = colState.locked ? '' : 'draggable="true"';
      const dragCls   = colState.locked ? '' : 'draggable-col';
      const hasFilter = filterState.colFilters[h] && filterState.colFilters[h].size > 0;
      const filterInd = hasFilter ? ' <span class="col-filter-dot">●</span>' : '';
      const w         = colState.widths[h] || 180;
      parts.push(`<th class="${dragCls}" ${drag} data-col="${escapeHtml(h)}" data-ci="${ci}" style="width:${w}px;min-width:60px">${escapeHtml(h)}${filterInd}${colState.locked?'':' <span class="drag-handle">⠿</span>'}<span class="col-resize-handle" data-col="${escapeHtml(h)}"></span></th>`);
    });
    parts.push('</tr></thead><tbody>');

    const richCellQueue = []; // [{ rowIdx, col, value }] — filled in during the loop below, applied after insertion

    for (let r = 0; r < shown; r++) {
      const row     = filteredRows[r];
      const origIdx = rows.indexOf(row);
      const hasNote = !!row._mdRel;
      parts.push(`<tr class="db-row" data-idx="${origIdx}">`);
      parts.push(`<td class="col-name name-cell" data-rel="${escapeHtml(row._mdRel||'')}" data-name="${escapeHtml(row[tk]||'')}">${hasNote?'<span class="row-icon">📄</span>':''}<span class="row-title">${escapeHtml(row[tk]||'—')}</span></td>`);
      colOrder.forEach(h => {
        const isAtt  = isAttCol(h, db);
        const isUrl  = isUrlCol(h, db);
        const value  = row[h] || '';
        const rawVal = isAtt ? (row._attachments||[]).map(a=>a.filename).join(', ') : value;
        const editCls = (colState.locked || isUrl) ? '' : 'editable-cell';
        const attCls  = isAtt ? ' att-cell' : '';

        // Rich-formatted cells (multi-line, or containing bold/underline/color/code
        // markup — see hasInlineFormatting) can carry <span>/<u> tags originating
        // from Notion's own data, which occasionally arrive truncated or otherwise
        // imbalanced. Rendering them into the SAME big string as every other cell
        // means one malformed tag can bleed its styling across every subsequent
        // cell/row once the whole table is parsed as a single blob. Route these
        // through an isolated per-cell innerHTML assignment instead (queued here,
        // applied right after the table is inserted) so any imbalance is contained
        // to that one cell's own parsing context.
        const isRich = !isAtt && !isUrl && value && (isRichText(value) || hasInlineFormatting(value));
        let cellContent;
        if (isRich) {
          richCellQueue.push({ rowIdx: origIdx, col: h });
          cellContent = ''; // filled in after insertion
        } else {
          cellContent = renderCol(h, value, row._attachments);
        }

        parts.push(`<td class="prop-cell${attCls} ${editCls}" data-row="${origIdx}" data-col="${escapeHtml(h)}" data-raw="${escapeHtml(rawVal)}">${cellContent}</td>`);
      });
      parts.push('</tr>');
    }
    parts.push('</tbody></table>');
    if (shown < total) parts.push(`<button id="dbMore" class="db-more-btn">Show ${Math.min(PAGE,total-shown)} more of ${total-shown} remaining</button>`);

    wrap.innerHTML = tabs + '<div class="db-table-wrap">' + parts.join('') + '</div>';

    // Fill in rich-formatted cells individually — each gets its OWN innerHTML
    // assignment, so a malformed/imbalanced tag in one cell's content can
    // never leak into a sibling cell or row.
    for (const { rowIdx, col } of richCellQueue) {
      const td = wrap.querySelector(`td.prop-cell[data-row="${rowIdx}"][data-col="${CSS.escape(col)}"]`);
      if (td) td.innerHTML = renderRichCell(rows[rowIdx][col] || '');
    }

    // Name cell
    wrap.querySelectorAll('td.name-cell').forEach(td => {
      td.onclick = () => { if (td.dataset.rel) openLinkedNote(td.dataset.rel, td.dataset.name); };
    });

    // Text/select cells — inline edit
    if (!colState.locked) {
      wrap.querySelectorAll('td.editable-cell:not(.att-cell)').forEach(td => attachCellEdit(td, db, colState));
    }

    // Attachment cells — file picker / drag-drop
    wrap.querySelectorAll('td.att-cell').forEach(td => attachFileDrop(td, db));

    // URL cells — open link on click
    wrap.querySelectorAll('a.url-chip').forEach(a => {
      a.onclick = e => { e.stopPropagation(); e.preventDefault(); window.api.openUrl(a.dataset.url); };
    });

    // Column header right-click → filter popover
    // Note: attach at the TABLE level, not on individual th elements,
    // because draggable="true" on th suppresses contextmenu in Chromium.
    const dbTable = dbQ(db,'#dbTable');
    if (dbTable) {
      dbTable.addEventListener('contextmenu', e => {
        const th = e.target.closest('th[data-col]');
        if (!th) return; // let row contextmenu handle tr clicks
        e.preventDefault();
        e.stopPropagation();
        showFilterPopover(th, db, th.dataset.col);
      });
    }

    // Row right-click
    wrap.querySelectorAll('tr.db-row').forEach(tr => {
      tr.oncontextmenu = (e) => {
        if (e.target.closest('th')) return; // header handled separately
        e.preventDefault();
        const idx    = +tr.dataset.idx;
        const nameTd = tr.querySelector('td.name-cell');
        showCtx(e.clientX, e.clientY, [
          { label: 'Open note',  icon: '📄', action: 'open',   fn: () => { if (nameTd?.dataset.rel) openLinkedNote(nameTd.dataset.rel, nameTd.dataset.name); } },
          { label: 'Edit row',   icon: '✏️', action: 'edit',   fn: () => promptEditRow(db, idx) },
          '---',
          { label: 'Delete row', icon: '🗑',  action: 'delete', fn: () => promptDeleteRow(db, idx) },
        ]);
      };
    });

    wrap.querySelectorAll('.att-chip').forEach(chip => {
      chip.onclick = e => { e.stopPropagation(); window.api.openAttachment(chip.dataset.vault); };
    });
    const more = dbQ(db,'#dbMore');
    if (more) more.onclick = () => { state.dbShown += PAGE; renderDatabase(db); };
    if (!colState.locked) attachColDrag(db, colState);
    attachColResize(db, colState);

  } else {
    const groups = {}, order = [];
    filteredRows.forEach(r => { const k=r[groupCol]||'(none)'; if(!groups[k]){groups[k]=[];order.push(k);} groups[k].push(r); });
    const propHeaders = colState.order;
    const catCol      = propHeaders.find(h => /categor/i.test(h) && h !== groupCol);

    const parts = [tabs, '<div class="board">'];
    const richCardQueue = []; // [{ cardId, value }] — filled in after insertion, same isolation reasoning as the table view
    let cardSeq = 0;
    order.forEach(g => {
      parts.push(`<div class="board-col"><div class="board-col-head"><span class="pill" style="background:${pillColor(g)}">${escapeHtml(g)}</span><span class="board-count">${groups[g].length}</span></div>`);
      groups[g].slice(0,200).forEach(r => {
        const hasNote=!!r._mdRel;
        parts.push(`<div class="board-card ${hasNote?'has-note':''}" data-rel="${escapeHtml(r._mdRel||'')}" data-name="${escapeHtml(r[titleKey(db)]||'')}">`);
        parts.push(`<div class="card-title">${escapeHtml(r[titleKey(db)]||'—')}</div>`);
        if (catCol && r[catCol]) {
          const catVal = r[catCol];
          // Same reasoning as the table view: a category value carrying
          // formatting markup could contain an imbalanced tag, which — if
          // concatenated into this shared board-wide string — could bleed
          // its styling across other cards. Route it through an isolated
          // per-card innerHTML assignment instead.
          if (isRichText(catVal) || hasInlineFormatting(catVal)) {
            const cardId = `rich-card-${cardSeq++}`;
            richCardQueue.push({ cardId, value: catVal });
            parts.push(`<div class="card-sub" data-rich-id="${cardId}"></div>`);
          } else {
            parts.push(`<div class="card-sub">${renderProp(catVal)}</div>`);
          }
        }
        if (r._attachments&&r._attachments.length)
          parts.push(`<div class="card-atts">${r._attachments.map(a=>`<span class="att-chip ${a.exists?'':'missing'}" data-vault="${escapeHtml(a.vaultRel)}">📎 ${escapeHtml(a.filename)}</span>`).join('')}</div>`);
        parts.push(`</div>`);
      });
      parts.push(`</div>`);
    });
    parts.push('</div>');
    wrap.innerHTML = parts.join('');
    for (const { cardId, value } of richCardQueue) {
      const el = wrap.querySelector(`[data-rich-id="${cardId}"]`);
      if (el) el.innerHTML = renderRichCell(value);
    }
    wrap.querySelectorAll('.board-card').forEach(c=>{c.onclick=()=>{if(c.dataset.rel)openLinkedNote(c.dataset.rel,c.dataset.name);};});
    wrap.querySelectorAll('.att-chip').forEach(chip=>{chip.onclick=e=>{e.stopPropagation();window.api.openAttachment(chip.dataset.vault);};});
  }

  dbRoot(db).querySelectorAll('.db-tab').forEach(t => {
    t.onclick = () => { state.dbView=t.dataset.v; state.dbShown=PAGE; renderDatabase(db); };
  });
}

// ── Attachment cell: file drop zone + picker ─────────────────────────────────
// Inline cell editing — attach click handler to a td.editable-cell
function attachCellEdit(td, db, colState) {
  td.onclick = (e) => {
    e.stopPropagation();
    if (td.querySelector('input,textarea')) return;
    const rowIdx = +td.dataset.row;
    const col    = td.dataset.col;
    const row    = db.rows[rowIdx];
    if (!row) return;
    const cur = td.dataset.raw !== undefined ? td.dataset.raw : (row[col] || '');

    td.innerHTML = '';
    // Use textarea for multiline/long content, input for short single-line values
    const multiline = cur.includes('\n') || cur.length > 60;
    const el = document.createElement(multiline ? 'textarea' : 'input');
    el.className = 'cell-input';
    el.value     = cur;
    if (multiline) { el.rows = Math.min(8, (cur.match(/\n/g)||[]).length + 2); el.style.resize = 'vertical'; }
    td.appendChild(el);
    el.focus();
    if (el.select) el.select();

    async function commit() {
      const val = el.value; // preserve internal newlines, only trim edges
      const trimmed = val.replace(/^\s+|\s+$/g, '');
      row[col]  = trimmed;
      await window.api.saveDatabase(db);
      td.innerHTML   = renderProp(trimmed);
      td.dataset.raw = trimmed;
      attachCellEdit(td, db, colState);
    }

    el.onblur    = commit;
    el.onkeydown = ev => {
      if (multiline) {
        // In textarea: Escape cancels, Ctrl+Enter commits, Enter adds newline
        if (ev.key === 'Escape') { td.innerHTML = renderProp(cur); td.dataset.raw = cur; attachCellEdit(td, db, colState); }
        if (ev.key === 'Enter' && ev.ctrlKey) { ev.preventDefault(); el.blur(); }
      } else {
        if (ev.key === 'Enter')  { ev.preventDefault(); el.blur(); }
        if (ev.key === 'Escape') { td.innerHTML = renderProp(cur); td.dataset.raw = cur; attachCellEdit(td, db, colState); }
        if (ev.key === 'Tab') {
          ev.preventDefault(); el.blur();
          const cells = [...dbRoot(db).querySelectorAll('td.editable-cell')];
          const next  = cells[cells.indexOf(td) + (ev.shiftKey ? -1 : 1)];
          if (next) next.click();
        }
      }
    };
  };
}

// Column drag-and-drop reordering
function attachColDrag(db, colState) {
  const ths = dbRoot(db).querySelectorAll('#dbTable thead th.draggable-col');
  let dragSrc = null;
  ths.forEach(th => {
    th.addEventListener('dragstart', e => { dragSrc=th; e.dataTransfer.effectAllowed='move'; th.classList.add('dragging'); });
    th.addEventListener('dragend',   () => { th.classList.remove('dragging'); dbRoot(db).querySelectorAll('#dbTable th').forEach(t=>t.classList.remove('drag-over')); });
    th.addEventListener('dragover',  e => { e.preventDefault(); dbRoot(db).querySelectorAll('#dbTable th').forEach(t=>t.classList.remove('drag-over')); th.classList.add('drag-over'); });
    th.addEventListener('dragleave', () => th.classList.remove('drag-over'));
    th.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragSrc || dragSrc===th) return;
      const from=+dragSrc.dataset.ci, to=+th.dataset.ci;
      const moved=colState.order.splice(from,1)[0];
      colState.order.splice(to,0,moved);
      renderDatabase(db);
    });
  });
}

// Column resize by dragging the resize handle on the right edge of each th
function attachColResize(db, colState) {
  const handles = dbRoot(db).querySelectorAll('#dbTable .col-resize-handle');
  handles.forEach(handle => {
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation(); // don't trigger column drag
      const th      = handle.closest('th');
      const col     = handle.dataset.col;
      const startX  = e.clientX;
      const startW  = th.getBoundingClientRect().width;

      document.body.style.cursor = 'col-resize';
      handle.classList.add('resizing');

      const onMove = e => {
        const newW = Math.max(60, startW + (e.clientX - startX));
        th.style.width = newW + 'px';
      };
      const onUp = e => {
        document.body.style.cursor = '';
        handle.classList.remove('resizing');
        const finalW = Math.max(60, startW + (e.clientX - startX));
        colState.widths[col] = finalW;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  });
}


function attachFileDrop(td, db) {
  // Show drop zone UI on click
  td.onclick = async (e) => {
    e.stopPropagation();
    if (td.querySelector('.att-drop-zone')) return;

    const rowIdx = +td.dataset.row;
    const row    = db.rows[rowIdx];
    if (!row) return;

    // Build drop zone overlay inside the cell
    const zone = document.createElement('div');
    zone.className = 'att-drop-zone';
    zone.innerHTML = `
      <div class="att-drop-inner">
        <div class="att-drop-label">Drop files here or</div>
        <button class="att-browse-btn">Browse…</button>
        <button class="att-cancel-btn">✕</button>
      </div>`;
    td.appendChild(zone);

    async function addAttachments(newAtts) {
      if (!newAtts.length) return;
      if (!row._attachments) row._attachments = [];
      for (const a of newAtts) {
        if (!row._attachments.find(x => x.filename === a.filename)) row._attachments.push(a);
      }
      row._mdRel = row._mdRel || null; // unchanged
      await window.api.saveDatabase(db);
      // Re-render cell
      td.innerHTML = renderAttChips(row._attachments);
      td.dataset.raw = row._attachments.map(a=>a.filename).join(', ');
      td.querySelectorAll('.att-chip').forEach(chip => {
        chip.onclick = ev => { ev.stopPropagation(); window.api.openAttachment(chip.dataset.vault); };
      });
      attachFileDrop(td, db);
    }

    zone.querySelector('.att-browse-btn').onclick = async (ev) => {
      ev.stopPropagation();
      zone.remove();
      const results = await window.api.pickAttachment(dbArg(db));
      await addAttachments(results);
    };

    zone.querySelector('.att-cancel-btn').onclick = (ev) => { ev.stopPropagation(); zone.remove(); };

    // Drag-and-drop
    zone.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect='copy'; zone.classList.add('drag-active'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-active'));
    zone.addEventListener('drop', async e => {
      e.preventDefault();
      zone.classList.remove('drag-active');
      const files = [...(e.dataTransfer.files || [])];
      if (!files.length) return;
      zone.querySelector('.att-drop-label').textContent = `Copying ${files.length} file(s)…`;
      const newAtts = [];
      for (const f of files) {
        const result = await window.api.copyAttachment(f.path, dbArg(db));
        if (result) newAtts.push(result);
      }
      zone.remove();
      await addAttachments(newAtts);
    });

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function h(ev) {
        if (!td.contains(ev.target)) { zone.remove(); document.removeEventListener('click', h); }
      });
    }, 0);
  };
}



/* ============ Linked note ============ */
async function openLinkedNote(rel, name) {
  const content = await window.api.readNoteAbs(rel);
  if (content === null) { alert(`Note not found:\n${rel}`); return; }
  await saveNote(); // keep edits to the page we are leaving
  state.currentRel = rel;
  navPush('note', rel);
  const lines = content.split('\n');
  let title = name, body = content;
  if (/^#\s+/.test(lines[0])) { title = lines[0].replace(/^#\s+/,''); body = lines.slice(1).join('\n').replace(/^\n+/,''); }
  docTitle.value = title;
  editor.innerHTML = window.MD.mdToHtml(body);
  editor.setAttribute('contenteditable','true');
  showView('#editorWrap');
  window.MD.loadVaultImages(editor);
  hydrateEmbeds(editor);
  window._rebuildToc?.();
  editor.focus();
}


/* ============ Embedded databases / sub-pages (Notion import) ============ */
function cacheAndRender(db) { dbCache.set(db.name, db); renderDatabase(db); }

function hydrateEmbeds(root) {
  root.querySelectorAll('.db-embed').forEach(el => {
    const name = el.dataset.db || '';
    const db = state.databases.find(d => d.name === name);
    if (!db) {
      el.innerHTML = `<div class="embed-bar">🗄 <b>${escapeHtml(name)}</b> <span class="embed-missing">(database not found)</span></div>`;
      return;
    }
    // Live, fully interactive database view that belongs to this page.
    el.innerHTML =
      `<div class="embed-bar"><span>🗄</span><span class="embed-name">${escapeHtml(dbTitle(db))}</span><span class="embed-open" title="Open as a full page">Open full ↗</span></div>` +
      `<div id="dbToolbar"></div><div id="dbTableWrap"></div>`;
    dbRoots.set(name, el);
    cacheAndRender(db);
  });
  root.querySelectorAll('.note-embed').forEach(el => {
    const rel = el.dataset.rel || '';
    const label = rel.split('/').pop().replace(/\.md$/i, '');
    const exists = state.notes.some(n => n.rel === rel);
    el.innerHTML = `📄 <b>${escapeHtml(label)}</b>${exists ? '' : ' <span class="embed-missing">(page not found)</span>'}`;
  });
}

editor.addEventListener('click', async (e) => {
  const open = e.target.closest && e.target.closest('.db-embed .embed-open');
  if (open) {
    const db = state.databases.find(d => d.name === open.closest('.db-embed').dataset.db);
    if (db) { await saveNote(); openDatabase(db); }
    return;
  }
  const note = e.target.closest && e.target.closest('.note-embed');
  if (note && editor.contains(note)) {
    e.preventDefault();
    const rel = note.dataset.rel;
    if (state.notes.some(n => n.rel === rel)) openNote(rel);
  }
});

// Create a database that belongs to the open page and insert its view here.
function insertEmbeddedDatabase() {
  // Stored beside the page, in the page's own folder: <page folder>/<Table name>/ (rows live there)
  const pageFolder = (state.currentRel || 'Untitled.md').replace(/\.md$/i, '');
  let title = 'Table', n = 2;
  while (state.databases.some(d => d.name === `${pageFolder}/${title}`)) title = `Table ${n++}`;
  const folder = `${pageFolder}/${title}`;
  const parentRel = state.currentRel;
  insertHTML(`<div class="db-embed" contenteditable="false" data-db="${escapeHtml(folder)}"></div><p>&nbsp;</p>`);
  window.api.saveDatabase({ name: folder, title, folder, headers: ['Name', 'Tags'], titleCol: 'Name', rows: [], embedded: true, parentRel })
    .then(refreshVault)
    .then(() => { hydrateEmbeds(editor); scheduleSave(); });
}

/* ============ Slash command menu ============ */
const SLASH_COMMANDS = [
  { group:'Basic',  t:'Text',          d:'Plain paragraph',        run:()=>wrapBlock('p') },
  { group:'Basic',  t:'Heading 1',      d:'Big heading',             run:()=>wrapBlock('h1') },
  { group:'Basic',  t:'Heading 2',      d:'Medium heading',          run:()=>wrapBlock('h2') },
  { group:'Basic',  t:'Heading 3',      d:'Small heading',           run:()=>wrapBlock('h3') },
  { group:'Lists',  t:'Bulleted list',  d:'• item',                  run:()=>insertHTML('<ul><li>&nbsp;</li></ul>') },
  { group:'Lists',  t:'Numbered list',  d:'1. item',                 run:()=>insertHTML('<ol><li>&nbsp;</li></ol>') },
  { group:'Lists',  t:'To-do list',     d:'Checkbox task',           run:()=>insertHTML('<div class="todo"><input type="checkbox"/><span>&nbsp;</span></div>') },
  { group:'Toggle', t:'Toggle',         d:'Collapsible block',       run:()=>insertToggle('toggle','Toggle') },
  { group:'Toggle', t:'Toggle Heading 1',d:'Collapsible H1',         run:()=>insertToggle('toggle toggle-h1','Heading') },
  { group:'Toggle', t:'Toggle Heading 2',d:'Collapsible H2',         run:()=>insertToggle('toggle toggle-h2','Heading') },
  { group:'Toggle', t:'Toggle Heading 3',d:'Collapsible H3',         run:()=>insertToggle('toggle toggle-h3','Heading') },
  { group:'Blocks', t:'Quote',          d:'Capture a quote',         run:()=>wrapBlock('blockquote') },
  { group:'Blocks', t:'Divider',        d:'Horizontal line',         run:()=>insertHTML('<hr/><p>&nbsp;</p>') },
  { group:'Blocks', t:'Code',           d:'Code block',              run:()=>insertHTML('<pre data-lang=""><code>code</code></pre><p>&nbsp;</p>') },
  { group:'Blocks', t:'Database view', d:'Table that lives inside this page', run:()=>insertEmbeddedDatabase() },
  { group:'Blocks', t:'Callout',        d:'Highlighted box',         run:()=>insertHTML('<div class="callout">💡 <span>&nbsp;</span></div>') },
];
let slashActive=false, slashIndex=0, slashFiltered=[], slashAnchor=null;

function handleSlashTyping() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return hideSlash();
  const node = sel.anchorNode;
  const text = node && node.textContent ? node.textContent.slice(0, sel.anchorOffset) : '';
  const m = text.match(/\/([a-zA-Z0-9 ]*)$/);
  if (m) { slashActive=true; const q=m[1].toLowerCase(); slashFiltered=SLASH_COMMANDS.filter(c=>c.t.toLowerCase().includes(q)||c.d.toLowerCase().includes(q)); slashIndex=0; showSlash(); }
  else hideSlash();
}

function showSlash() {
  if (!slashFiltered.length) return hideSlash();
  const rect = getCaretRect();
  slashMenu.style.left = rect.left+'px';
  slashMenu.style.top  = (rect.bottom+6)+'px';
  let html='', lastGroup='';
  slashFiltered.forEach((c,i)=>{ if(c.group!==lastGroup){html+=`<div class="slash-group">${c.group}</div>`;lastGroup=c.group;} html+=`<div class="slash-item ${i===slashIndex?'sel':''}" data-i="${i}"><span class="t">${c.t}</span><span class="d">${c.d}</span></div>`; });
  slashMenu.innerHTML=html;
  slashMenu.classList.remove('hidden');
  slashMenu.querySelectorAll('.slash-item').forEach(el=>{el.onmousedown=e=>{e.preventDefault();runSlash(parseInt(el.dataset.i));};});
}
function hideSlash() { slashActive=false; slashMenu.classList.add('hidden'); }
function getCaretRect() {
  const sel=window.getSelection();
  if(sel.rangeCount){const r=sel.getRangeAt(0).cloneRange();const rects=r.getClientRects();if(rects.length)return rects[0];const span=document.createElement('span');span.textContent='\u200b';r.insertNode(span);const rect=span.getBoundingClientRect();span.remove();return rect;}
  return {left:100,bottom:100};
}
function deleteSlashText() {
  const sel=window.getSelection();const node=sel.anchorNode;const text=node.textContent.slice(0,sel.anchorOffset);const m=text.match(/\/([a-zA-Z0-9 ]*)$/);
  if(m&&node.nodeType===3){const start=sel.anchorOffset-m[0].length;node.textContent=node.textContent.slice(0,start)+node.textContent.slice(sel.anchorOffset);const r=document.createRange();r.setStart(node,start);r.collapse(true);sel.removeAllRanges();sel.addRange(r);}
}
function runSlash(i) { const cmd=slashFiltered[i];if(!cmd)return;deleteSlashText();hideSlash();cmd.run();scheduleSave(); }

// Insert a toggle block and place cursor in the summary
function insertToggle(cls, label) {
  const details = document.createElement('details');
  details.className = cls;
  details.open = true;

  const summary = document.createElement('summary');
  summary.textContent = label;
  details.appendChild(summary);

  const bodyDiv = document.createElement('div');
  bodyDiv.className = 'toggle-body';
  const p = document.createElement('p');
  p.innerHTML = '<br>';
  bodyDiv.appendChild(p);
  details.appendChild(bodyDiv);

  const sentinel = document.createElement('p');
  sentinel.innerHTML = '<br>';

  // Find the correct insertion point.
  // If the cursor is inside a .toggle-body, insert within that body (for nested toggles).
  // Otherwise insert at the editor's top-level after the current block.
  const sel = window.getSelection();
  let insertAfter = null;
  let insertParent = editor; // default: insert into the editor root

  if (sel && sel.rangeCount) {
    let node = sel.anchorNode;

    // Walk up to find the nearest .toggle-body ancestor (for nested insertion)
    let bodyAncestor = null;
    let tmp = node.nodeType === 3 ? node.parentElement : node;
    while (tmp && tmp !== editor) {
      if (tmp.classList && tmp.classList.contains('toggle-body')) {
        bodyAncestor = tmp;
        break;
      }
      tmp = tmp.parentElement;
    }

    if (bodyAncestor) {
      // Cursor is inside a toggle body — find the direct child of that body
      // that contains the cursor, and insert after it
      insertParent = bodyAncestor;
      let cur = node.nodeType === 3 ? node.parentElement : node;
      while (cur && cur.parentElement !== bodyAncestor) cur = cur.parentElement;
      insertAfter = cur;
    } else {
      // Cursor is at editor root level — find the direct editor child
      insertParent = editor;
      let cur = node.nodeType === 3 ? node.parentElement : node;
      while (cur && cur.parentElement !== editor) cur = cur.parentElement;
      insertAfter = cur;
    }
  }

  // Insert toggle (and sentinel) after insertAfter within insertParent
  if (insertAfter && insertAfter !== insertParent) {
    insertAfter.after(details);
    details.after(sentinel);
    // Remove empty triggering block
    const txt = insertAfter.textContent.replace(/\u00a0/g, '').trim();
    if (txt === '' && insertAfter.tagName !== 'DETAILS') insertAfter.remove();
  } else {
    insertParent.appendChild(details);
    insertParent.appendChild(sentinel);
  }

  // Place caret inside the summary
  const range = document.createRange();
  range.selectNodeContents(summary);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  scheduleSave();
}

// ── Tab: indent a toggle INTO the previous sibling toggle's body ──────────────
// If cursor is on a summary, wrap the whole <details> into the body of the
// previous sibling <details> (or create a new plain toggle as parent).
// If cursor is in a toggle-body, wrap the current block into a new nested toggle.
function indentToggle(e) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  const node = sel.anchorNode;

  // Case A: cursor is on a <summary> → indent the whole <details>
  const summary = node.nodeType === 3
    ? node.parentElement?.closest('summary')
    : node.closest?.('summary');

  if (summary) {
    const details = summary.closest('details.toggle');
    if (!details) return false;

    const prev = details.previousElementSibling;
    if (prev && prev.matches('details.toggle')) {
      // Move into the body of the previous toggle
      e.preventDefault();
      const prevBody = prev.querySelector(':scope > .toggle-body');
      if (!prevBody) return false;
      prevBody.appendChild(details);
      // Put cursor back in the summary
      const r = document.createRange();
      r.selectNodeContents(summary);
      r.collapse(false);
      sel.removeAllRanges(); sel.addRange(r);
      if (!prev.open) prev.open = true;
      scheduleSave();
      return true;
    }
    // No previous toggle sibling — wrap this toggle inside a new parent toggle
    e.preventDefault();
    const parent = document.createElement('details');
    parent.className = 'toggle';
    parent.open = true;
    const parentSummary = document.createElement('summary');
    parentSummary.textContent = 'Toggle';
    const parentBody = document.createElement('div');
    parentBody.className = 'toggle-body';
    parent.appendChild(parentSummary);
    parent.appendChild(parentBody);
    details.before(parent);
    parentBody.appendChild(details);
    // Place cursor on the new parent summary
    const r = document.createRange();
    r.selectNodeContents(parentSummary);
    r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
    scheduleSave();
    return true;
  }

  // Case B: cursor is in a toggle-body → nest the current block into a new child toggle
  const body = node.nodeType === 3
    ? node.parentElement?.closest('.toggle-body')
    : node.closest?.('.toggle-body');
  if (!body) return false;

  // Find the direct child block of body containing the cursor
  let block = node.nodeType === 3 ? node.parentElement : node;
  while (block && block.parentElement !== body) block = block.parentElement;
  if (!block || block === body) return false;

  // Don't nest if the block is already a toggle (use summary Tab for that)
  if (block.matches('details.toggle')) return false;

  e.preventDefault();
  // Create a new child toggle wrapping the current block's text
  const newDetails = document.createElement('details');
  newDetails.className = 'toggle';
  newDetails.open = true;
  const newSummary = document.createElement('summary');
  newSummary.textContent = block.textContent.replace(/\u00a0/g, '').trim() || 'Toggle';
  const newBody = document.createElement('div');
  newBody.className = 'toggle-body';
  const placeholder = document.createElement('p');
  placeholder.innerHTML = '<br>';
  newBody.appendChild(placeholder);
  newDetails.appendChild(newSummary);
  newDetails.appendChild(newBody);

  block.replaceWith(newDetails);
  // Place cursor in the new summary
  const r = document.createRange();
  r.selectNodeContents(newSummary);
  r.collapse(false);
  sel.removeAllRanges(); sel.addRange(r);
  scheduleSave();
  return true;
}

// ── Shift+Tab: outdent a toggle OUT of its parent toggle body ─────────────────
function outdentToggle(e) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  const node = sel.anchorNode;

  // Find the closest toggle that has a toggle-body grandparent (i.e. is nested)
  const summary = node.nodeType === 3
    ? node.parentElement?.closest('summary')
    : node.closest?.('summary');
  const details = summary?.closest('details.toggle');
  if (!details) return false;

  const parentBody = details.parentElement;
  if (!parentBody || !parentBody.classList.contains('toggle-body')) return false;

  const parentToggle = parentBody.closest('details.toggle');
  if (!parentToggle) return false;

  e.preventDefault();
  // Move the details to after the parent toggle (in the grandparent context)
  parentToggle.after(details);
  // Place cursor back in the summary
  const r = document.createRange();
  r.selectNodeContents(summary);
  r.collapse(false);
  sel.removeAllRanges(); sel.addRange(r);
  scheduleSave();
  return true;
}

// Escape out of a toggle body to a new paragraph below it.
// Triggers when: Enter pressed on an empty line in the body, OR Tab pressed anywhere in the body.
function escapeToggle(e) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  const node   = sel.anchorNode;
  const inBody = node.nodeType === 1
    ? node.closest('.toggle-body')
    : node.parentElement?.closest('.toggle-body');
  if (!inBody) return false;
  const toggle = inBody.closest('details.toggle');
  if (!toggle) return false;

  // For Tab: always escape
  // For Enter: escape only if current block is empty
  if (e.key === 'Enter') {
    const block     = node.nodeType === 3 ? node.parentElement : node;
    const blockText = block.textContent.replace(/\u00a0/g, '').trim();
    if (blockText !== '') return false;

    // Also only escape if this empty block is the LAST block in the body
    // (so Enter on an empty line mid-toggle just makes a new line normally)
    const lastBlock = inBody.lastElementChild;
    if (block !== lastBlock && inBody.contains(block) && block !== inBody) {
      // Not the last child — let the browser handle it
      return false;
    }
  }

  e.preventDefault();

  // Find or create a paragraph after the toggle
  let next = toggle.nextElementSibling;
  if (!next || next.tagName !== 'P') {
    next = document.createElement('p');
    next.innerHTML = '<br>';
    toggle.after(next);
  }
  // Remove the empty block from the body that triggered the escape
  if (e.key === 'Enter') {
    const block = node.nodeType === 3 ? node.parentElement : node;
    if (block !== inBody && inBody.contains(block)) block.remove();
  }
  const r = document.createRange();
  r.selectNodeContents(next);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  next.focus?.();
  scheduleSave();
  return true;
}

editor.addEventListener('keydown', e => {
  // Ctrl/Cmd+A inside a code block selects only that block's code, not the
  // whole note — matches the behaviour of Notion and most code editors.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const node = sel.anchorNode;
      const codeEl = (node.nodeType === 1 ? node : node.parentElement)?.closest('pre > code');
      if (codeEl) {
        e.preventDefault();
        const range = document.createRange();
        range.selectNodeContents(codeEl);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
    }
  }
  // Slash menu navigation
  if (slashActive && !slashMenu.classList.contains('hidden')) {
    if      (e.key==='ArrowDown') { e.preventDefault(); slashIndex=(slashIndex+1)%slashFiltered.length; showSlash(); return; }
    else if (e.key==='ArrowUp')   { e.preventDefault(); slashIndex=(slashIndex-1+slashFiltered.length)%slashFiltered.length; showSlash(); return; }
    else if (e.key==='Enter')     { e.preventDefault(); runSlash(slashIndex); return; }
    else if (e.key==='Escape')    { hideSlash(); return; }
  }
  // Tab / Shift+Tab — Notion-style toggle indentation
  if (e.key === 'Tab') {
    if (e.shiftKey) {
      // Shift+Tab: outdent — move the current toggle OUT of its parent toggle body
      if (outdentToggle(e)) return;
    } else {
      // Tab: if cursor is on a summary (toggle heading/list label) → indent INTO previous toggle
      // If cursor is in a toggle body on an empty last line → escape the toggle
      if (indentToggle(e)) return;
      if (escapeToggle(e)) return;
    }
    e.preventDefault(); // swallow bare Tab so it doesn't insert a tab character
  }
  // Enter on an empty last line inside toggle body = escape toggle
  if (e.key === 'Enter' && !e.shiftKey) {
    const sel = window.getSelection();
    if (sel.rangeCount) {
      const node = sel.anchorNode;
      const inBody = node.nodeType === 1
        ? node.closest('.toggle-body')
        : node.parentElement?.closest('.toggle-body');
      if (inBody) {
        // If the current block is empty, escape
        const block = (node.nodeType === 3 ? node.parentElement : node);
        const blockText = block.textContent.replace(/\u00a0/g,'').trim();
        if (blockText === '') {
          if (escapeToggle(e)) return;
        }
      }
    }
  }
});
function wrapBlock(tag) {
  // Don't apply block formatting inside a toggle summary — it corrupts the structure
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const node = sel.anchorNode;
    const inSummary = node?.nodeType === 3
      ? node.parentElement?.closest('summary')
      : node?.closest?.('summary');
    if (inSummary) return;
  }
  document.execCommand('formatBlock', false, tag);
}
function insertHTML(html) { document.execCommand('insertHTML',false,html); }

/* ============ Button wiring ============ */
async function chooseVault() {
  const p = await window.api.chooseVault();
  if (p) { state.vaultPath=p; $('#vaultName').textContent=p.split(/[\\/]/).pop(); await refreshVault(); showView('#empty'); }
}

$('#btnChooseVault').onclick  = chooseVault;
$('#btnChooseVault2').onclick = chooseVault;
$('#btnNew').onclick          = () => newNote();
$('#btnNewFolder').onclick    = () => promptNewFolder();
$('#btnNewDb').onclick        = () => { if (!state.vaultPath) return chooseVault(); promptNewDb(); };

$('#btnImportMd').onclick = async () => {
  if (!state.vaultPath) return chooseVault();
  const imported = await window.api.importMd();
  await refreshVault();
  if (imported.length) openNote(imported[0]);
};

$('#btnImportNotion').onclick = async () => {
  if (!state.vaultPath) return chooseVault();
  showImportProgress('Opening file picker…');
  try {
    const res = await window.api.importNotion();
    if (!res) { hideImportProgress(); return; }
    if (!res.ok) { hideImportProgress(); alert(`Import failed:\n${res.error}`); return; }
    await refreshVault();
    hideImportProgress();
    const orphanLine = res.orphans ? `\n• ${res.orphans} extra page(s) (not in database view)` : '';
    alert(`Import complete ✓\n\n• ${res.databases.length} database(s): ${res.databases.join(', ')}\n• ${res.pages} pages${orphanLine}\n• ${res.images} images\n• ${res.attachments} attachments`);
    { const _d = state.databases.filter(d => !d.embedded); if (_d.length) openDatabase(_d[0]); }
  } catch (err) { hideImportProgress(); alert(`Import error: ${err.message}`); }
};

/* ============ Notion API connect/import (live, not ZIP export) ============ */
// This uses Notion's official API to fetch "Enhanced Markdown" directly,
// which preserves full toggle nesting — unlike the classic ZIP export, which
// permanently flattens nested toggles before we ever see the file.

$('#btnNotionConnect').onclick = async () => {
  if (!state.vaultPath) return chooseVault();
  const existing = await window.api.notionGetToken();
  if (existing) { openNotionSearchModal(); return; }
  openNotionTokenModal();
};

function openNotionTokenModal() {
  showModal(`
    <h2>Connect Notion</h2>
    <p class="modal-help">
      This uses Notion's official API — it preserves toggle nesting fully,
      unlike the ZIP export. Create a free integration at
      <a href="#" id="notionIntegLink">notion.so/my-integrations</a>,
      copy its secret, then share the pages/databases you want with it
      (Share → Add connections).
    </p>
    <input id="notionTokenInput" placeholder="ntn_… (integration secret)" type="password" />
    <div id="notionTokenError" class="modal-error hidden"></div>
    <div class="modal-btns">
      <button id="notionTokenCancel" class="sb-btn">Cancel</button>
      <button id="notionTokenSave" class="sb-btn primary">Connect</button>
    </div>
  `);
  $('#notionIntegLink').onclick = (e) => { e.preventDefault(); window.api.openUrl('https://www.notion.so/my-integrations'); };
  $('#notionTokenCancel').onclick = hideModal;
  $('#notionTokenSave').onclick = async () => {
    const token = $('#notionTokenInput').value.trim();
    if (!token) return;
    $('#notionTokenSave').textContent = 'Verifying…';
    $('#notionTokenSave').disabled = true;
    const res = await window.api.notionSetToken(token);
    if (!res.ok) {
      $('#notionTokenError').textContent = res.error || 'Could not verify token.';
      $('#notionTokenError').classList.remove('hidden');
      $('#notionTokenSave').textContent = 'Connect';
      $('#notionTokenSave').disabled = false;
      return;
    }
    hideModal();
    openNotionSearchModal();
  };
}

let notionSelected = new Map(); // id -> {id, type, title}
let notionTypeFilter = null;    // null = all, 'page', 'database'

async function openNotionSearchModal(query) {
  notionTypeFilter = null; // reset to "All" each time the modal opens fresh
  showModal(`
    <h2>Import from Notion</h2>
    <input id="notionSearchInput" placeholder="Search your workspace…" value="${escapeHtml(query || '')}" />
    <div class="notion-filter-tabs">
      <button class="notion-filter-tab active" data-filter="">All</button>
      <button class="notion-filter-tab" data-filter="page">Pages</button>
      <button class="notion-filter-tab" data-filter="database">Databases</button>
    </div>
    <div class="notion-toolbar">
      <label class="notion-select-all"><input type="checkbox" id="notionSelectAll" /> Select all shown</label>
      <span id="notionResultCount" class="notion-result-count"></span>
    </div>
    <div id="notionResults" class="notion-results"><div class="notion-loading">Searching…</div></div>
    <div class="modal-btns">
      <button id="notionSearchCancel" class="sb-btn">Cancel</button>
      <button id="notionReconnect" class="sb-btn">Use different token</button>
      <button id="notionDoImport" class="sb-btn primary" disabled>Import (0 selected)</button>
    </div>
  `);
  $('#notionSearchCancel').onclick = hideModal;
  $('#notionReconnect').onclick = async () => { await window.api.notionSetToken(''); openNotionTokenModal(); };
  $('#notionDoImport').onclick = performNotionImport;
  $('#notionSelectAll').onchange = (e) => toggleSelectAllVisible(e.target.checked);

  document.querySelectorAll('.notion-filter-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.notion-filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      notionTypeFilter = tab.dataset.filter || null;
      runNotionSearch($('#notionSearchInput').value);
    };
  });

  let searchTimer2;
  $('#notionSearchInput').addEventListener('input', e => {
    clearTimeout(searchTimer2);
    searchTimer2 = setTimeout(() => runNotionSearch(e.target.value), 250);
  });

  await runNotionSearch(query || '');
}

async function runNotionSearch(query) {
  const results = $('#notionResults');
  results.innerHTML = `<div class="notion-loading">${notionTypeFilter === 'database' ? 'Loading all databases…' : 'Searching…'}</div>`;
  try {
    const items = await window.api.notionSearch(query, notionTypeFilter);
    if (!items.length) {
      results.innerHTML = '<div class="notion-loading">No results.</div>';
      $('#notionResultCount').textContent = '';
      $('#notionSelectAll').checked = false;
      updateNotionImportBtn();
      return;
    }
    $('#notionResultCount').textContent = `${items.length} result${items.length === 1 ? '' : 's'}`;
    results.innerHTML = items.map(it => {
      const checked = notionSelected.has(it.id) ? 'checked' : '';
      const icon = it.icon || (it.type === 'database' ? '🗄' : '📄');
      const label = it.type === 'database' ? 'Database' : 'Page';
      return `<label class="notion-result-row">
        <input type="checkbox" data-id="${it.id}" data-type="${it.type}"
               data-title="${escapeHtml(it.title)}" data-datasource="${it.isDataSource ? '1' : ''}" ${checked} />
        <span class="notion-result-icon">${icon}</span>
        <span class="notion-result-title">${escapeHtml(it.title)}</span>
        <span class="notion-result-type">${label}</span>
      </label>`;
    }).join('');
    results.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.onchange = () => {
        const { id, type, title, datasource } = cb.dataset;
        if (cb.checked) notionSelected.set(id, { id, type, title, isDataSource: datasource === '1' });
        else notionSelected.delete(id);
        syncSelectAllCheckbox();
        updateNotionImportBtn();
      };
    });
    syncSelectAllCheckbox();
  } catch (err) {
    results.innerHTML = `<div class="notion-loading">Search failed: ${escapeHtml(err.message)}</div>`;
    $('#notionResultCount').textContent = '';
  }
  updateNotionImportBtn();
}

// Check/uncheck every currently-rendered result row and keep notionSelected in sync
function toggleSelectAllVisible(checked) {
  const boxes = document.querySelectorAll('#notionResults input[type="checkbox"]');
  boxes.forEach(cb => {
    cb.checked = checked;
    const { id, type, title, datasource } = cb.dataset;
    if (checked) notionSelected.set(id, { id, type, title, isDataSource: datasource === '1' });
    else notionSelected.delete(id);
  });
  updateNotionImportBtn();
}

// Reflect whether all currently-visible rows are selected on the "Select all" checkbox
function syncSelectAllCheckbox() {
  const selectAll = $('#notionSelectAll');
  if (!selectAll) return;
  const boxes = [...document.querySelectorAll('#notionResults input[type="checkbox"]')];
  selectAll.checked = boxes.length > 0 && boxes.every(cb => cb.checked);
  selectAll.indeterminate = boxes.some(cb => cb.checked) && !selectAll.checked;
}

function updateNotionImportBtn() {
  const btn = $('#notionDoImport');
  if (!btn) return;
  btn.textContent = `Import (${notionSelected.size} selected)`;
  btn.disabled = notionSelected.size === 0;
}

async function performNotionImport() {
  const items = [...notionSelected.values()];
  if (!items.length) return;
  hideModal();
  showImportProgress('Starting Notion import…');
  try {
    const res = await window.api.notionImport(items);
    await refreshVault();
    hideImportProgress();
    notionSelected = new Map();
    const errLine = res.errors?.length ? `\n\n⚠ ${res.errors.length} issue(s):\n${res.errors.slice(0, 5).join('\n')}` : '';
    alert(`Notion import complete ✓\n\n• ${res.pages} page(s)\n• ${res.databases} database(s)\n• ${res.images} image(s)${errLine}`);
    { const _d = state.databases.filter(d => !d.embedded); if (_d.length) openDatabase(_d[_d.length - 1]); }
  } catch (err) {
    hideImportProgress();
    alert(`Notion import error: ${err.message}`);
  }
}

let searchTimer;
$('#search').addEventListener('input', e => {
  clearTimeout(searchTimer); const v=e.target.value;
  searchTimer = setTimeout(() => renderNoteList(v), 120);
});

/* ============ Dark mode ============ */
(function() {
  const saved=localStorage.getItem('notai-theme');
  const dark=saved ? saved==='dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  // Always set data-theme EXPLICITLY (never leave it unset). The CSS has an
  // OS-preference fallback rule — :root:not([data-theme="light"]) inside
  // @media(prefers-color-scheme:dark) — which has HIGHER specificity than
  // the plain :root light defaults. If the attribute is merely absent
  // (rather than explicitly "light"), that fallback rule still matches for
  // anyone whose OS is set to dark mode, silently reapplying dark colors
  // regardless of what the user or saved preference actually chose. Setting
  // the attribute explicitly either way is what makes light mode "stick".
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  updateDarkBtn(dark);
})();
function updateDarkBtn(d) { const b=$('#btnDarkMode'); if(b){b.textContent=d?'☀️':'🌙';b.title=d?'Light mode':'Dark mode';} }
$('#btnDarkMode').onclick = () => {
  const d = document.documentElement.getAttribute('data-theme')==='dark';
  document.documentElement.setAttribute('data-theme', d ? 'light' : 'dark');
  localStorage.setItem('notai-theme', d?'light':'dark');
  updateDarkBtn(!d);
};

/* ============ Zoom ============ */
const ZOOM_STEPS = [70, 80, 90, 100, 110, 125, 150, 175, 200];
let zoomIdx = ZOOM_STEPS.indexOf(100);

function applyZoom() {
  const pct = ZOOM_STEPS[zoomIdx];
  editor.style.fontSize   = (pct / 100) + 'em';
  docTitle.style.fontSize = (pct / 100 * 40) + 'px';
  $('#zoomLabel').textContent = pct + '%';
  localStorage.setItem('notai-zoom', pct);
}

(function initZoom() {
  const saved = parseInt(localStorage.getItem('notai-zoom') || '100');
  const idx   = ZOOM_STEPS.indexOf(saved);
  if (idx >= 0) zoomIdx = idx;
  applyZoom();
})();

$('#btnZoomIn').onclick    = () => { if (zoomIdx < ZOOM_STEPS.length - 1) { zoomIdx++; applyZoom(); } };
$('#btnZoomOut').onclick   = () => { if (zoomIdx > 0) { zoomIdx--; applyZoom(); } };
$('#btnZoomReset').onclick = () => { zoomIdx = ZOOM_STEPS.indexOf(100); applyZoom(); };

// Ctrl+scroll to zoom
document.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (e.deltaY < 0) { if (zoomIdx < ZOOM_STEPS.length-1) { zoomIdx++; applyZoom(); } }
  else              { if (zoomIdx > 0)                    { zoomIdx--; applyZoom(); } }
}, { passive: false });

// Ctrl += / Ctrl+- / Ctrl+0
document.addEventListener('keydown', e => {
  if (!e.ctrlKey) return;
  // Don't intercept when user is typing in an input, textarea, or contenteditable cell
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (document.activeElement?.getAttribute('contenteditable') === 'true') return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); if (zoomIdx < ZOOM_STEPS.length-1) { zoomIdx++; applyZoom(); } }
  if (e.key === '-')                  { e.preventDefault(); if (zoomIdx > 0) { zoomIdx--; applyZoom(); } }
  if (e.key === '0')                  { e.preventDefault(); zoomIdx = ZOOM_STEPS.indexOf(100); applyZoom(); }
});

/* ============ Sidebar resize handle ============ */
(function() {
  const handle  = $('#sbResizeHandle');
  const dbSec   = handle.previousElementSibling;  // .sb-section-db
  if (!handle || !dbSec) return;

  // Restore saved height
  const saved = parseInt(localStorage.getItem('notai-db-height') || '0');
  if (saved > 0) dbSec.style.maxHeight = saved + 'px';

  let startY = 0, startH = 0;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startY = e.clientY;
    startH = dbSec.getBoundingClientRect().height;
    handle.classList.add('dragging');

    const onMove = e => {
      const delta = e.clientY - startY;
      const newH  = Math.max(40, Math.min(startH + delta, window.innerHeight * 0.7));
      dbSec.style.maxHeight = newH + 'px';
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      localStorage.setItem('notai-db-height', dbSec.getBoundingClientRect().height);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();
window.api.onMenu('menu:new-note',      () => newNote());
window.api.onMenu('menu:choose-vault',  chooseVault);
window.api.onMenu('menu:import-md',     () => $('#btnImportMd').click());
window.api.onMenu('menu:import-notion', () => $('#btnImportNotion').click());

document.addEventListener('click', e => { if(!slashMenu.contains(e.target)) hideSlash(); });
window.api.onLowMemory(() => { dbCache.clear(); });

init();

/* ============ Find bar (Ctrl+F) ============ */
const findBar   = $('#findBar');
const findInput = $('#findInput');
const findCount = $('#findCount');
let findMatches = [], findIdx = 0;

function openFind() {
  findBar.classList.remove('hidden');
  findInput.focus();
  findInput.select();
  if (findInput.value) runFind();
}

function closeFind() {
  findBar.classList.add('hidden');
  clearHighlights();
  findMatches = []; findIdx = 0; findCount.textContent = '';
  editor.focus();
}

function clearHighlights() {
  editor.querySelectorAll('mark.find-highlight').forEach(m => {
    const parent = m.parentNode;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  });
}

function runFind() {
  clearHighlights();
  findMatches = []; findIdx = 0;
  const q = findInput.value;
  if (!q) { findCount.textContent = ''; return; }

  // Walk text nodes in the editor, wrap matches in <mark>
  const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  walkTextNodes(editor, regex);
  findMatches = [...editor.querySelectorAll('mark.find-highlight')];
  if (!findMatches.length) { findCount.textContent = 'No results'; return; }
  goToMatch(0);
}

function walkTextNodes(node, regex) {
  if (node.nodeType === 3) {
    const text = node.textContent;
    if (!regex.test(text)) return;
    regex.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = regex.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.className = 'find-highlight';
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  } else if (node.nodeType === 1 && node.tagName !== 'SCRIPT' && node.tagName !== 'STYLE') {
    [...node.childNodes].forEach(c => walkTextNodes(c, regex));
  }
}

function goToMatch(idx) {
  findMatches.forEach(m => m.classList.remove('current'));
  if (!findMatches.length) return;
  findIdx = ((idx % findMatches.length) + findMatches.length) % findMatches.length;
  const cur = findMatches[findIdx];
  cur.classList.add('current');
  cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  findCount.textContent = `${findIdx + 1} / ${findMatches.length}`;
}

$('#btnZoomOut') && (document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && $('#editorWrap').classList.contains('active')) {
    e.preventDefault(); openFind();
  }
}));

$('#findInput').addEventListener('input',   () => runFind());
$('#findNext').addEventListener('click',    () => goToMatch(findIdx + 1));
$('#findPrev').addEventListener('click',    () => goToMatch(findIdx - 1));
$('#findClose').addEventListener('click',   closeFind);
$('#findInput').addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); goToMatch(e.shiftKey ? findIdx - 1 : findIdx + 1); }
  if (e.key === 'Escape') closeFind();
});

/* ============ Table of Contents ============ */
const tocPanel = $('#tocPanel');
const tocList  = $('#tocList');
let tocVisible = false;

function buildToc() {
  tocList.innerHTML = '';
  // Collect headings and toggle-heading summaries
  const items = [];
  editor.querySelectorAll('h1, h2, h3, h4, h5, h6, details.toggle-h1 > summary, details.toggle-h2 > summary, details.toggle-h3 > summary, details.toggle-h4 > summary, details.toggle-h5 > summary, details.toggle-h6 > summary').forEach((el, i) => {
    const tag   = el.tagName.toLowerCase();
    const level = tag === 'summary'
      ? parseInt(el.closest('details').className.match(/toggle-h(\d)/)?.[1] || '1', 10)
      : parseInt(tag[1], 10);
    const text  = el.textContent.trim();
    if (!text) return;
    const id = `toc-anchor-${i}`;
    el.dataset.tocId = id;
    items.push({ level, text, el });
  });

  if (!items.length) {
    tocList.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:13px">No headings</div>';
    return;
  }

  items.forEach(({ level, text, el }) => {
    const a = document.createElement('a');
    a.className = `toc-item toc-h${level}`;
    a.textContent = text;
    a.title = text;
    a.href = '#';
    a.onclick = e => {
      e.preventDefault();
      // Open the parent toggle if collapsed
      const details = el.closest('details.toggle');
      if (details && !details.open) details.open = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Highlight briefly
      tocList.querySelectorAll('.toc-item').forEach(i => i.classList.remove('active'));
      a.classList.add('active');
    };
    tocList.appendChild(a);
  });
}

function toggleToc() {
  tocVisible = !tocVisible;
  tocPanel.classList.toggle('hidden', !tocVisible);
  if (tocVisible) buildToc();
  localStorage.setItem('notai-toc', tocVisible ? '1' : '0');
}

// Persist TOC state
if (localStorage.getItem('notai-toc') === '1') {
  tocVisible = true;
  tocPanel.classList.remove('hidden');
}

$('#btnToc').onclick = toggleToc;

// Rebuild TOC whenever a note is opened (called from openNote/openLinkedNote)
window._rebuildToc = () => { if (tocVisible) buildToc(); };
