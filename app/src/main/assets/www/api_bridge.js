/**
 * NotAI Android API Bridge
 * Replaces window.api (Electron IPC) with calls to the Android JavascriptInterface.
 * All methods that returned Promises are wrapped to still return Promises so the
 * existing renderer.js code works unchanged.
 *
 * The Android side exposes: window.AndroidBridge.*
 * Async results are delivered by calling window._bridgeCb[callId](result).
 */
(function () {
  let _callId = 0;
  const _cbs = {};
  window._bridgeCb = {}; // called by Kotlin to deliver async results

  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++_callId;
      window._bridgeCb[id] = (result) => {
        delete window._bridgeCb[id];
        try {
          resolve(typeof result === 'string' ? JSON.parse(result) : result);
        } catch {
          resolve(result);
        }
      };
      try {
        window.AndroidBridge[method](id, JSON.stringify(args));
      } catch (e) {
        delete window._bridgeCb[id];
        reject(e);
      }
    });
  }

  // Menu event emitter (Android triggers these via window.dispatchEvent)
  const _menuHandlers = {};
  window.addEventListener('notai-menu', e => {
    const fn = _menuHandlers[e.detail];
    if (fn) fn();
  });

  // Progress events
  let _progressHandler = null;
  window.addEventListener('notai-progress', e => {
    if (_progressHandler) _progressHandler(e.detail);
  });

  window.api = {
    // Settings & vault
    getSettings:     ()       => call('getSettings'),
    chooseVault:     ()       => call('chooseVault'),

    // Notes
    listVault:       ()       => call('listVault'),
    readNote:        (rel)    => call('readNote', rel),
    readNoteAbs:     (rel)    => call('readNoteAbs', rel),
    writeNote:       (r, c)   => call('writeNote', r, c),
    createNote:      (n, f)   => call('createNote', n, f),
    renameNote:      (r, n)   => call('renameNote', r, n),
    deleteNote:      (r)      => call('deleteNote', r),

    // Databases
    listDatabases:   ()       => call('listDatabases'),
    saveDatabase:    (db)     => call('saveDatabase', JSON.stringify(db)),
    deleteDatabase:  (name)   => call('deleteDatabase', name),
    createDbPage:    (r, c)   => call('createDbPage', r, c),

    // Attachments
    openAttachment:  (rel)    => call('openAttachment', rel),
    loadImage:       (rel)    => call('loadImage', rel),
    pickAttachment:  (dbName) => call('pickAttachment', dbName),
    copyAttachment:  (src, db)=> call('copyAttachment', src, db),
    openUrl:         (url)    => call('openUrl', url),

    // Import
    importMd:        ()       => call('importMd'),
    importNotion:    ()       => call('importNotion'),

    // Notion API (live connection, not the ZIP export)
    notionGetToken:  ()       => call('notionGetToken'),
    notionSetToken:  (token)  => call('notionSetToken', token),
    notionSearch:    (query, type) => type ? call('notionSearch', query, type) : call('notionSearch', query),
    notionImport:    (items)  => call('notionImport', JSON.stringify(items)),

    // Events (no-ops or custom Android events)
    onMenu:          (ev, fn) => { _menuHandlers[ev] = fn; },
    onProgress:      (fn)     => { _progressHandler = fn; },
    onLowMemory:     (fn)     => {
      window.addEventListener('notai-lowmemory', fn);
    },
  };

  // ── Mobile sidebar hamburger ──────────────────────────────────────────────
  function isMobile() { return window.innerWidth <= 600; }

  function openSidebar() {
    const sb = document.getElementById('sidebar');
    const bd = document.getElementById('sidebarBackdrop');
    if (sb) sb.classList.add('open');
    if (bd) bd.classList.add('open');
  }
  function closeSidebar() {
    const sb = document.getElementById('sidebar');
    const bd = document.getElementById('sidebarBackdrop');
    if (sb) sb.classList.remove('open');
    if (bd) bd.classList.remove('open');
  }

  document.addEventListener('DOMContentLoaded', () => {
    const hamburger = document.getElementById('btnHamburger');
    const backdrop  = document.getElementById('sidebarBackdrop');

    if (hamburger) hamburger.addEventListener('click', openSidebar);
    if (backdrop)  backdrop.addEventListener('click', closeSidebar);

    // On mobile, close sidebar when a note or database is opened
    if (isMobile()) {
      document.addEventListener('click', e => {
        const target = e.target;
        // Close if user clicked a note, db item, or folder inside the sidebar
        if (target.closest('.sb-list li') || target.closest('.sb-folder')) {
          setTimeout(closeSidebar, 80);
        }
      });
    }
  });
})();
