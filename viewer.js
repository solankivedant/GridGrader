import { renderInto, sniffKind, looksLikeHtmlPage, fmtSize } from './renderers.js';

const $ = (s) => document.querySelector(s);
const hasChrome = typeof chrome !== 'undefined' && chrome.storage;

// ---------- storage helpers (fall back to localStorage when opened outside the extension) ----------
const store = {
  async get(k) {
    if (hasChrome) return (await chrome.storage.local.get(k))[k];
    try { return JSON.parse(localStorage.getItem(k)); } catch { return undefined; }
  },
  async set(k, v) {
    if (hasChrome) return chrome.storage.local.set({ [k]: v });
    localStorage.setItem(k, JSON.stringify(v));
  },
};

// ---------- state ----------
let job = { page: {}, files: [] };
const items = [];
let notes = {};
let seq = 0;
const MAX_PARALLEL = 3;
let running = 0;
const queue = [];

const prefs = Object.assign({ cols: 3, height: 440 }, JSON.parse(localStorage.getItem('gg_prefs') || '{}'));
applyPrefs();

function applyPrefs() {
  document.documentElement.style.setProperty('--cols', prefs.cols);
  document.documentElement.style.setProperty('--tile-h', prefs.height + 'px');
  $('#cols').value = prefs.cols; $('#colsVal').textContent = prefs.cols;
  $('#height').value = prefs.height;
  localStorage.setItem('gg_prefs', JSON.stringify(prefs));
}

const noteKey = (it) => it.url ? it.url : `local:${it.name}:${it.size || ''}`;
const safe = (s) => (s || '').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

// ---------- boot ----------
(async function init() {
  notes = (await store.get('gg_notes')) || {};
  const id = new URLSearchParams(location.search).get('job');
  if (id) job = (await store.get('job_' + id)) || job;
  const t = job.page && job.page.title;
  document.title = t ? `Grid · ${t}` : 'GridGrader';
  $('#title').textContent = t || 'GridGrader';
  if (job.page && job.page.url) { $('#source').href = job.page.url; $('#source').textContent = '← ' + job.page.url; }
  else $('#source').textContent = 'Drop files anywhere to add them';
  for (const f of job.files || []) addItem({ url: f.url, name: f.name, ext: f.ext, kind: f.kind || ggKindOf(f.ext), context: f.context });
  refreshEmpty();
  updateStatus();
})();

// ---------- items & tiles ----------
function addItem(data, afterItem) {
  const it = Object.assign({ id: ++seq, state: 'idle', meta: '', cleanup: null }, data);
  it.ext = (it.ext || '').toLowerCase();
  it.kind = it.kind || ggKindOf(it.ext);
  it.tile = buildTile(it);
  if (afterItem) {
    items.splice(items.indexOf(afterItem) + 1, 0, it);
    afterItem.tile.after(it.tile);
  } else {
    items.push(it);
    $('#grid').appendChild(it.tile);
  }
  tileObserver.observe(it.tile);
  updateKindFilter();
  renumber();
  refreshEmpty();
  return it;
}

const svg = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  expand:   svg('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  external: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  remove:   svg('<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>'),
};

function buildTile(it) {
  const t = document.createElement('div');
  t.className = 'tile';
  t.innerHTML = `
    <div class="thead">
      <span class="num"></span>
      <div class="tnames" title="Open large view"></div>
      <span class="kind"></span>
      <div class="tact">
        <button data-a="large" title="Large view">${ICON.expand}<span>Enlarge</span></button>
        <a data-a="orig" title="Open original in a new tab" target="_blank" rel="noopener">${ICON.external}<span>Open</span></a>
        <button data-a="dl" title="Download">${ICON.download}<span>Save</span></button>
        <button data-a="rm" class="danger" title="Remove from grid">${ICON.remove}<span>Remove</span></button>
      </div>
    </div>
    <div class="tbody"><div class="center"><div class="spinner"></div></div></div>
    <div class="tfoot"><input class="note" placeholder="Marks / note…"><span class="meta"></span></div>`;
  const names = t.querySelector('.tnames');
  if (it.context) names.appendChild(Object.assign(document.createElement('div'), { className: 'tctx', textContent: it.context }));
  names.appendChild(Object.assign(document.createElement('div'), { className: 'tname', textContent: it.name }));
  names.title = `${it.context ? it.context + ' — ' : ''}${it.name}\nClick for large view`;
  t.querySelector('.kind').textContent = it.ext || ggKindLabel(it.kind);
  const orig = t.querySelector('[data-a=orig]');
  if (it.url) orig.href = it.url; else orig.style.display = 'none';
  names.onclick = () => openModal(it);
  t.querySelector('[data-a=large]').onclick = () => openModal(it);
  t.querySelector('[data-a=dl]').onclick = () => downloadItem(it);
  t.querySelector('[data-a=rm]').onclick = () => removeItem(it);
  const note = t.querySelector('.note');
  note.value = notes[noteKey(it)] || '';
  note.classList.toggle('has', !!note.value);
  note.oninput = () => saveNote(it, note.value);
  return t;
}

function saveNote(it, v) {
  const k = noteKey(it);
  if (v) notes[k] = v; else delete notes[k];
  const n = it.tile.querySelector('.note');
  if (n.value !== v) n.value = v;
  n.classList.toggle('has', !!v);
  clearTimeout(saveNote.t);
  saveNote.t = setTimeout(() => store.set('gg_notes', notes), 300);
}

function renumber() {
  let n = 0;
  for (const it of items) {
    const vis = it.tile.style.display !== 'none';
    it.tile.querySelector('.num').textContent = vis ? '#' + (++n) : '';
  }
}

function removeItem(it) {
  it.cleanup && it.cleanup();
  tileObserver.unobserve(it.tile);
  it.tile.remove();
  items.splice(items.indexOf(it), 1);
  renumber(); updateStatus(); updateKindFilter(); refreshEmpty();
}

function refreshEmpty() { $('#emptyState').hidden = items.length > 0; }

// ---------- lazy loading ----------
const tileObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const it = items.find(i => i.tile === e.target);
    if (it && it.state === 'idle') enqueue(it);
  }
}, { rootMargin: '400px 0px' });

function enqueue(it) {
  if (it.state !== 'idle') return;
  it.state = 'queued';
  queue.push(it);
  pump();
}
function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const it = queue.shift();
    if (!items.includes(it)) continue;
    running++;
    loadItem(it).finally(() => { running--; updateStatus(); pump(); });
  }
}

async function loadItem(it) {
  const body = it.tile.querySelector('.tbody');
  it.state = 'loading';
  body.innerHTML = '<div class="center"><div class="spinner"></div><div>Loading…</div></div>';
  try {
    await getBlob(it);
    body.innerHTML = '';
    const r = await renderInto(it.kind, it.blob, body, rendererOpts(it, false));
    it.cleanup = r.cleanup;
    it.meta = [r.meta, fmtSize(it.blob.size)].filter(Boolean).join(' · ');
    it.state = 'done';
  } catch (err) {
    console.warn('GridGrader:', it.name, err);
    it.state = 'error';
    it.error = err.message || String(err);
    body.innerHTML = '';
    const c = document.createElement('div');
    c.className = 'center';
    c.innerHTML = '<div class="err">Couldn\'t show this file</div><div class="msg"></div><div><button class="btn retry">Retry</button></div>';
    c.querySelector('.msg').textContent = it.error;
    c.querySelector('.retry').onclick = () => { it.state = 'idle'; enqueue(it); };
    body.appendChild(c);
  }
  it.tile.querySelector('.meta').textContent = it.meta || '';
  it.tile.querySelector('.kind').textContent = it.ext || ggKindLabel(it.kind);
}

function rendererOpts(it, large) {
  return {
    large, ext: it.ext, name: it.name,
    onOpenEntry: (entryName, ext, getBlobFn) => {
      const child = addItem({
        name: `${it.name} › ${entryName}`, ext, kind: ggKindOf(ext), context: it.context,
        fromZip: getBlobFn, parentKey: noteKey(it) + '#' + entryName,
      }, it);
      child.url = '';
      child.tile.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      child.tile.classList.add('focus');
      setTimeout(() => child.tile.classList.remove('focus'), 1600);
      if ($('#modal').hidden === false) closeModal();
    },
  };
}

// ---------- fetching ----------
async function getBlob(it) {
  if (it.blob) return it.blob;
  let blob = null, ctype = '', cd = '', lastErr = null;
  if (it.file) blob = it.file;
  else if (it.fromZip) blob = await it.fromZip();
  else {
    try {
      const r = await fetch(it.url, { credentials: 'include' });
      if (!r.ok) throw new Error(`Server said ${r.status} ${r.statusText}`.trim());
      ctype = r.headers.get('content-type') || '';
      cd = r.headers.get('content-disposition') || '';
      blob = await r.blob();
      if (it.kind !== 'code' && /text\/html/i.test(ctype) && await looksLikeHtmlPage(blob)) { lastErr = new Error('htmlpage'); blob = null; }
    } catch (e) { lastErr = e; blob = null; }

    // Fallback: fetch from inside the original tab (uses that page's login session)
    if (!blob && hasChrome && job.tabId != null) {
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId: job.tabId }, func: fetchInPage, args: [it.url] });
        const v = res && res.result;
        if (v && v.b64) {
          const bin = atob(v.b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          blob = new Blob([arr], { type: v.type || '' });
          ctype = v.type || ''; cd = v.cd || '';
          if (it.kind !== 'code' && await looksLikeHtmlPage(blob)) { blob = null; lastErr = new Error('htmlpage'); }
        } else if (v && v.error) lastErr = new Error(v.error);
      } catch (e) { /* tab closed or no access */ }
    }
    if (!blob) {
      if (lastErr && lastErr.message === 'htmlpage')
        throw new Error('The site returned a web page instead of the file (a login or preview page). Make sure you\'re signed in, then Retry — or use Open to view it on the site.');
      throw new Error((lastErr && lastErr.message) || 'Download failed.');
    }
  }
  // Better name/extension from Content-Disposition (e.g. Google Drive links)
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd || '');
  if (m) {
    const real = decodeURIComponent(m[1].replace(/"/g, ''));
    const ext = (real.match(/\.([a-z0-9]{1,10})$/i) || [])[1];
    if (ext && (!it.ext || it.kind === 'other')) { it.ext = ext.toLowerCase(); it.kind = ggKindOf(it.ext); if (!/\.[a-z0-9]{1,10}$/i.test(it.name)) it.name = real; }
  }
  it.kind = await sniffKind(blob, it.kind, ctype);
  it.size = blob.size;
  it.blob = blob;
  return blob;
}

// Runs inside the original page.
async function fetchInPage(url) {
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) return { error: `Server said ${r.status}` };
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 80e6) return { error: 'File is larger than 80 MB.' };
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { b64: btoa(s), type: r.headers.get('content-type') || '', cd: r.headers.get('content-disposition') || '' };
  } catch (e) { return { error: String(e && e.message || e) }; }
}

// ---------- download ----------
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function downloadItem(it) {
  try { await getBlob(it); saveBlob(it.blob, (it.name.split(' › ').pop()) || 'file'); }
  catch (e) { if (it.url) window.open(it.url, '_blank'); }
}

$('#dlAll').onclick = async () => {
  closeMenu();
  const zip = new JSZip();
  const vis = items.filter(i => i.tile.style.display !== 'none');
  let n = 0, failed = 0;
  for (const [i, it] of vis.entries()) {
    setStatus(`Preparing ZIP… ${i + 1}/${vis.length}`);
    try {
      await getBlob(it);
      const base = it.name.split(' › ').pop();
      zip.file(`${String(i + 1).padStart(2, '0')} ${safe(it.context) ? safe(it.context) + ' - ' : ''}${safe(base)}`, it.blob);
      n++;
    } catch { failed++; }
  }
  const out = await zip.generateAsync({ type: 'blob' });
  saveBlob(out, `${safe(job.page && job.page.title) || 'submissions'}.zip`);
  setStatus(`ZIP ready: ${n} files${failed ? `, ${failed} couldn't be downloaded` : ''}.`);
  setTimeout(updateStatus, 5000);
};

$('#exportNotes').onclick = () => {
  closeMenu();
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['#', 'Student / context', 'File', 'Marks / note', 'Link'].map(q).join(',')];
  items.forEach((it, i) => rows.push([i + 1, it.context, it.name, notes[noteKey(it)] || '', it.url || ''].map(q).join(',')));
  saveBlob(new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv' }), `${safe(job.page && job.page.title) || 'grid'}-notes.csv`);
};
$('#reloadAll').onclick = () => {
  closeMenu();
  for (const it of items) if (it.state === 'error') { it.state = 'idle'; enqueue(it); }
};
$('#clearNotes').onclick = () => {
  closeMenu();
  if (!confirm('Clear all marks/notes for the files in this grid?')) return;
  for (const it of items) saveNote(it, '');
};

// ---------- status ----------
function setStatus(s) { $('#status').textContent = s; }
function updateStatus() {
  const total = items.length;
  if (!total) return setStatus('');
  const done = items.filter(i => i.state === 'done').length;
  const err = items.filter(i => i.state === 'error').length;
  const vis = items.filter(i => i.tile.style.display !== 'none').length;
  setStatus(`${total} file${total === 1 ? '' : 's'}${vis !== total ? ` (${vis} shown)` : ''} · ${done} loaded${err ? ` · ${err} failed` : ''}`);
}

// ---------- toolbar ----------
$('#cols').oninput = (e) => { prefs.cols = +e.target.value; applyPrefs(); };
$('#height').oninput = (e) => { prefs.height = +e.target.value; applyPrefs(); };
$('#search').oninput = applyFilter;
$('#kindFilter').onchange = applyFilter;
function applyFilter() {
  const q = $('#search').value.trim().toLowerCase();
  const k = $('#kindFilter').value;
  for (const it of items) {
    const ok = (!k || it.kind === k) && (!q || it.name.toLowerCase().includes(q) || (it.context || '').toLowerCase().includes(q) || (notes[noteKey(it)] || '').toLowerCase().includes(q));
    it.tile.style.display = ok ? '' : 'none';
  }
  renumber(); updateStatus();
}
function updateKindFilter() {
  const sel = $('#kindFilter');
  const cur = sel.value;
  const kinds = [...new Set(items.map(i => i.kind))].sort();
  sel.innerHTML = '<option value="">All types</option>' + kinds.map(k => `<option value="${k}">${ggKindLabel(k)}</option>`).join('');
  sel.value = kinds.includes(cur) ? cur : '';
}
const closeMenu = () => { $('#morePop').hidden = true; };
$('#moreBtn').onclick = (e) => { e.stopPropagation(); $('#morePop').hidden = !$('#morePop').hidden; };
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenu(); });

// ---------- local files ----------
$('#addFiles').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addLocal(e.target.files); e.target.value = ''; };
function addLocal(fileList) {
  for (const f of fileList) {
    const ext = (f.name.match(/\.([^.]+)$/) || [])[1] || '';
    const it = addItem({ file: f, name: f.name, ext, context: '', size: f.size });
    it.url = '';
  }
  updateStatus();
}
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#dropOverlay').hidden = false; } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true;
  if (e.dataTransfer.files.length) addLocal(e.dataTransfer.files);
});

// ---------- large view ----------
let modalItem = null, modalCleanup = null;
function visibleItems() { return items.filter(i => i.tile.style.display !== 'none'); }

async function openModal(it) {
  modalCleanup && modalCleanup(); modalCleanup = null;
  modalItem = it;
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#mCtx').textContent = it.context || it.name;
  $('#mName').textContent = it.context ? it.name : (it.meta || '');
  $('#mNote').value = notes[noteKey(it)] || '';
  const o = $('#mOpen');
  if (it.url) { o.href = it.url; o.style.display = ''; } else o.style.display = 'none';
  const body = $('#mBody');
  body.innerHTML = '<div class="center"><div class="spinner"></div></div>';
  body.scrollTop = 0;
  items.forEach(i => i.tile.classList.toggle('focus', i === it));
  try {
    await getBlob(it);
    if (modalItem !== it) return;
    body.innerHTML = '';
    const r = await renderInto(it.kind, it.blob, body, rendererOpts(it, true));
    if (modalItem !== it) { r.cleanup(); return; }
    modalCleanup = r.cleanup;
    if (it.context) $('#mName').textContent = `${it.name}${r.meta ? ' · ' + r.meta : ''}`;
  } catch (err) {
    if (modalItem !== it) return;
    body.innerHTML = '<div class="center"><div class="err">Couldn\'t show this file</div><div class="msg"></div></div>';
    body.querySelector('.msg').textContent = err.message || String(err);
  }
}
function closeModal() {
  modalCleanup && modalCleanup(); modalCleanup = null;
  $('#modal').hidden = true;
  $('#mBody').innerHTML = '';
  document.body.style.overflow = '';
  if (modalItem) {
    modalItem.tile.scrollIntoView({ block: 'nearest' });
    const t = modalItem.tile; setTimeout(() => t.classList.remove('focus'), 1200);
  }
  modalItem = null;
}
function step(d) {
  const vis = visibleItems();
  if (!vis.length || !modalItem) return;
  const i = vis.indexOf(modalItem);
  openModal(vis[(i + d + vis.length) % vis.length]);
}
$('#close').onclick = closeModal;
$('#prev').onclick = () => step(-1);
$('#next').onclick = () => step(1);
$('#mDl').onclick = () => modalItem && downloadItem(modalItem);
$('#mNote').oninput = (e) => modalItem && saveNote(modalItem, e.target.value);
addEventListener('keydown', (e) => {
  if ($('#modal').hidden) return;
  if (e.target.matches('input, textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === 'Escape') closeModal();
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
});
