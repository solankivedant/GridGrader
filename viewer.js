import { renderInto, sniffKind, looksLikeHtmlPage, fmtSize } from './renderers.js';
import { circuitFeatures, circuitSimilarity } from './circsim.js';

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

const prefs = Object.assign({ cols: 3, height: 440, view: 'side', sideW: 640, sort: 'order' }, JSON.parse(localStorage.getItem('gg_prefs') || '{}'));
applyPrefs();

// Use the chosen column count, but never squeeze tiles below ~280px (e.g. when the side view is open).
function fitCols() {
  const main = document.querySelector('main');
  const avail = main ? main.clientWidth - 36 : innerWidth;
  const fit = Math.max(1, Math.floor((avail + 40) / (280 + 40)));
  const n = Math.min(prefs.cols, fit);
  document.documentElement.style.setProperty('--cols', n);
  const v = document.getElementById('colsVal');
  if (v) v.textContent = n < prefs.cols ? `${n}/${prefs.cols}` : prefs.cols;
}

function applyPrefs() {
  fitCols();
  document.documentElement.style.setProperty('--tile-h', prefs.height + 'px');
  $('#cols').value = prefs.cols;
  $('#height').value = prefs.height;
  localStorage.setItem('gg_prefs', JSON.stringify(prefs));
}

const noteKey = (it) => it.noteKey || (it.url ? it.url : `local:${it.name}:${it.size || ''}`);
const safe = (s) => (s || '').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

// ---------- boot ----------
(async function init() {
  notes = (await store.get('gg_notes')) || {};
  const id = new URLSearchParams(location.search).get('job');
  if (id) job = (await store.get('job_' + id)) || job;
  const t = job.page && job.page.title;
  document.title = t ? `Grid · ${t}` : 'GridGrader';
  $('#title').textContent = t || 'New grid';
  if (job.page && job.page.url) { $('#source').href = job.page.url; $('#source').innerHTML = ggIcon('link', 12); $('#source').append(job.page.url.replace(/^https?:\/\//, '')); $('#source').dataset.tip = 'Source page'; }
  else $('#source').textContent = 'Drop files anywhere to add them';
  for (const f of job.files || []) addItem({ url: f.url, name: f.name, ext: f.ext, kind: f.kind || ggKindOf(f.ext), context: f.context, noteKey: f.noteKey,
    late: !!f.late, lateText: f.lateText, modified: f.modified, modifiedText: f.modifiedText });
  $('#sortBy').value = prefs.sort;
  applySort();
  updateFilterDot();
  refreshEmpty();
  updateStatus();
  // A tab opened with "New tab" shows its one file straight away, full screen.
  if (job.single && items.length) { document.title = items[0].context || items[0].name; openModal(items[0], 'full', false); }
})();

// Keep marks/notes in sync when another GridGrader tab edits them.
if (hasChrome && chrome.storage.onChanged) chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !ch.gg_notes) return;
  notes = ch.gg_notes.newValue || {};
  for (const it of items) {
    const v = notes[noteKey(it)] || '', n = it.tile.querySelector('.note');
    if (n !== document.activeElement && n.value !== v) { n.value = v; n.classList.toggle('has', !!v); }
  }
  if (modalItem && $('#mNote') !== document.activeElement) $('#mNote').value = notes[noteKey(modalItem)] || '';
});

// ---------- open one file in its own GridGrader tab ----------
// The original link often forces a download (Moodle pluginfile, forcedownload=1), so instead we
// hand the file to a new viewer tab. If it is already loaded here we pass a blob: URL, which the new
// tab (same extension origin) can read instantly without downloading it again.
async function openInNewTab(it) {
  let url = it.url;
  try {
    if (it.blob || !url) { await getBlob(it); url = URL.createObjectURL(it.blob); }
  } catch { /* fall back to the network URL */ }
  if (!url) return;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await store.set('job_' + id, {
    created: Date.now(), tabId: job.tabId, page: job.page, single: true,
    files: [{ url, name: it.name, ext: it.ext, kind: it.kind, context: it.context, noteKey: noteKey(it), late: it.late, lateText: it.lateText, modified: it.modified, modifiedText: it.modifiedText }],
  });
  const page = 'viewer.html?job=' + id;
  if (hasChrome && chrome.tabs && chrome.tabs.create) {
    // chrome.tabs is not subject to popup blocking, and lets us place the tab next to this one
    const cur = chrome.tabs.getCurrent ? await chrome.tabs.getCurrent() : null;
    chrome.tabs.create({ url: chrome.runtime.getURL(page), index: cur ? cur.index + 1 : undefined, openerTabId: cur ? cur.id : undefined });
  } else window.open(page, '_blank');
}

// ---------- items & tiles ----------
function addItem(data, afterItem) {
  const it = Object.assign({ id: ++seq, state: 'idle', meta: '', cleanup: null }, data);
  it.ext = (it.ext || '').toLowerCase();
  it.kind = it.kind || ggKindOf(it.ext);
  it.tile = buildTile(it);
  if (afterItem) {
    // files opened from a ZIP sit right after their ZIP, whatever the sort order
    const kids = items.filter(i => i.parent === afterItem).length;
    it.parent = afterItem;
    it.order = afterItem.order + (kids + 1) / 1000;
    const anchor = [afterItem, ...items.filter(i => i.parent === afterItem)].pop();
    items.splice(items.indexOf(anchor) + 1, 0, it);
    anchor.tile.after(it.tile);
  } else {
    it.order = it.id;
    items.push(it);
    $('#grid').appendChild(it.tile);
  }
  tileObserver.observe(it.tile);
  updateKindFilter();
  updateLate();
  renumber();
  refreshEmpty();
  return it;
}

function buildTile(it) {
  const t = document.createElement('div');
  t.className = 'tile';
  t.innerHTML = `
    <div class="thead">
      <button class="pick" data-tip="Select" data-key="X" aria-label="Select this file"><span class="box">${ggIcon('check', 12)}</span><span class="num"></span></button>
      <span class="ficon"></span>
      <div class="tnames"></div>
      <button class="simb" hidden></button>
      <span class="lateb" hidden>Late</span>
      <span class="kind"></span>
      <div class="tact">
        <button data-a="side" data-tip="Side view" aria-label="Open in side view">${ggIcon('side', 16)}</button>
        <button data-a="full" data-tip="Full screen" aria-label="Open full screen">${ggIcon('full', 16)}</button>
        <button data-a="orig" data-tip="New tab" aria-label="Open in a new tab">${ggIcon('external', 16)}</button>
        <button data-a="dl" data-tip="Download" aria-label="Download">${ggIcon('download', 16)}</button>
        <button data-a="rm" class="danger" data-tip="Remove" aria-label="Remove from grid">${ggIcon('trash', 16)}</button>
      </div>
    </div>
    <div class="tbody"><div class="center"><div class="spinner"></div></div></div>
    <div class="tfoot">${ggIcon('note', 14)}<input class="note" placeholder="Add marks or a note…" aria-label="Marks or note"><span class="meta"></span></div>`;
  const names = t.querySelector('.tnames');
  if (it.context) names.appendChild(Object.assign(document.createElement('div'), { className: 'tctx', textContent: it.context }));
  names.appendChild(Object.assign(document.createElement('div'), { className: 'tname', textContent: it.name }));
  names.title = `${it.context ? it.context + ' — ' : ''}${it.name}\nClick for large view · Ctrl+click to select`;
  if (it.late) {
    const lb = t.querySelector('.lateb');
    lb.hidden = false;
    lb.dataset.tip = it.lateText || 'Late';
  }
  if (it.modifiedText) t.querySelector('.tnames').title += `\nSubmitted ${it.modifiedText}`;
  t.querySelector('.pick').onclick = (e) => { e.stopPropagation(); togglePick(it, e.shiftKey); };
  t.addEventListener('pointerdown', () => setCursor(it, false));
  t.querySelector('.kind').textContent = it.ext || ggKindLabel(it.kind);
  t.querySelector('.kind').dataset.kind = it.kind;
  t.querySelector('.ficon').dataset.kind = it.kind;
  t.querySelector('.ficon').innerHTML = ggKindIcon(it.kind, 16);
  t.querySelector('[data-a=orig]').onclick = () => openInNewTab(it);
  names.onclick = (e) => {
    if (e.ctrlKey || e.metaKey) togglePick(it, false);
    else if (e.shiftKey) togglePick(it, true);
    else openModal(it);
  };
  t.querySelector('[data-a=side]').onclick = () => openModal(it, 'side');
  t.querySelector('[data-a=full]').onclick = () => openModal(it, 'full');
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
  picked.delete(it);
  if (cursor === it) cursor = null;
  renumber(); updateStatus(); updateKindFilter(); refreshEmpty(); updatePicks(); updateLate();
}

// ---------- keyboard cursor (J/K) ----------
let cursor = null;
function setCursor(it, scroll = true) {
  if (cursor === it) return;
  if (cursor) cursor.tile.classList.remove('cursor');
  cursor = it;
  if (it) {
    it.tile.classList.add('cursor');
    if (scroll) it.tile.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
function moveCursor(d) {
  const vis = visibleItems();
  if (!vis.length) return;
  if (!$('#modal').hidden) return step(d);
  const i = vis.indexOf(cursor);
  setCursor(vis[i < 0 ? 0 : Math.max(0, Math.min(vis.length - 1, i + d))]);
}
const current = () => modalItem || cursor;

// ---------- multi-select ----------
const picked = new Set();
let lastPick = null;
function togglePick(it, range) {
  const vis = visibleItems();
  if (range && lastPick && vis.includes(lastPick) && vis.includes(it)) {
    const [a, b] = [vis.indexOf(lastPick), vis.indexOf(it)].sort((x, y) => x - y);
    const on = !picked.has(it) || picked.has(lastPick);
    for (const i of vis.slice(a, b + 1)) on ? picked.add(i) : picked.delete(i);
  } else picked.has(it) ? picked.delete(it) : picked.add(it);
  lastPick = it;
  setCursor(it, false);
  updatePicks();
}
function clearPicks() { picked.clear(); updatePicks(); }
function updatePicks() {
  for (const it of items) it.tile.classList.toggle('picked', picked.has(it));
  const n = picked.size;
  $('#selbar').hidden = n === 0;
  document.body.classList.toggle('has-selbar', n > 0);
  $('#selCount').textContent = n;
  const cmp = $('#selCompare');
  cmp.disabled = n !== 2;
  cmp.dataset.tip = n === 2 ? 'Compare side by side' : 'Pick exactly 2';
  $('#selTabs').disabled = n > 12;
  $('#selTabs').dataset.tip = n > 12 ? 'Up to 12 at once' : 'One tab each';
  $('#selDl').innerHTML = ggIcon(n > 1 ? 'zip' : 'download', 16) + (n > 1 ? 'Download ZIP' : 'Download');
}
const pickedList = () => items.filter(i => picked.has(i)); // in grid order
$('#selClear').onclick = clearPicks;
$('#selAll').onclick = () => { visibleItems().forEach(i => picked.add(i)); updatePicks(); };
$('#selCompare').onclick = () => { const p = pickedList(); if (p.length === 2) openCompare(p[0], p[1]); };
$('#selTabs').onclick = async () => { for (const it of pickedList().slice(0, 12)) await openInNewTab(it); };
$('#selDl').onclick = () => { const p = pickedList(); p.length === 1 ? downloadItem(p[0]) : zipItems(p, `${safe(job.page && job.page.title) || 'submissions'} - selected.zip`); };
$('#selRm').onclick = () => {
  const p = pickedList();
  if (p.length > 3 && !confirm(`Remove ${p.length} files from this grid? (Nothing is deleted on the website.)`)) return;
  p.forEach(removeItem);
};

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
    c.innerHTML = '<div class="err">Couldn\'t show this file</div><div class="msg"></div><div><button class="btn retry">' + ggIcon('retry', 14) + 'Retry</button></div>';
    c.querySelector('.msg').textContent = it.error;
    c.querySelector('.retry').onclick = () => { it.state = 'idle'; enqueue(it); };
    body.appendChild(c);
  }
  it.tile.querySelector('.meta').textContent = it.meta || '';
  it.tile.querySelector('.kind').textContent = it.ext || ggKindLabel(it.kind);
  it.tile.querySelector('.kind').dataset.kind = it.kind;
  it.tile.querySelector('.ficon').dataset.kind = it.kind;
  it.tile.querySelector('.ficon').innerHTML = ggKindIcon(it.kind, 16);
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

async function zipItems(list, fileName) {
  const zip = new JSZip();
  let n = 0, failed = 0;
  for (const [i, it] of list.entries()) {
    setStatus(`Preparing ZIP… ${i + 1}/${list.length}`);
    try {
      await getBlob(it);
      const base = it.name.split(' › ').pop();
      zip.file(`${String(i + 1).padStart(2, '0')} ${safe(it.context) ? safe(it.context) + ' - ' : ''}${safe(base)}`, it.blob);
      n++;
    } catch { failed++; }
  }
  const out = await zip.generateAsync({ type: 'blob' });
  saveBlob(out, fileName);
  setStatus(`ZIP ready: ${n} files${failed ? `, ${failed} couldn't be downloaded` : ''}.`);
  setTimeout(updateStatus, 5000);
}
$('#dlAll').onclick = () => { closeMenu(); zipItems(visibleItems(), `${safe(job.page && job.page.title) || 'submissions'}.zip`); };

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
  const late = items.filter(i => i.late).length;
  setStatus(`${total} file${total === 1 ? '' : 's'}${vis !== total ? ` (${vis} shown)` : ''} · ${done} loaded${err ? ` · ${err} failed` : ''}${late ? ` · ${late} late` : ''}`);
}

// ---------- late submissions ----------
let lateOnly = false;
function updateLate() {
  const n = items.filter(i => i.late).length;
  $('#lateOnly').hidden = n === 0;
  $('#lateCount').textContent = n || '';
  if (!n && lateOnly) { lateOnly = false; applyFilter(); }
}
$('#lateOnly').onclick = () => {
  lateOnly = !lateOnly;
  $('#lateOnly').classList.toggle('on', lateOnly);
  $('#lateOnly').setAttribute('aria-pressed', lateOnly);
  $('#lateOnly').dataset.tip = lateOnly ? 'Show all' : 'Late only';
  applyFilter();
};

// ---------- sorting ----------
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const student = (it) => it.context || it.name;
const SORTS = {
  order: () => 0,
  name: (a, b) => collator.compare(student(a), student(b)),
  nameDesc: (a, b) => collator.compare(student(b), student(a)),
  file: (a, b) => collator.compare(a.name, b.name),
  type: (a, b) => collator.compare(ggKindLabel(a.kind), ggKindLabel(b.kind)) || collator.compare(a.ext, b.ext),
  newest: (a, b) => (b.modified || 0) - (a.modified || 0),
  oldest: (a, b) => (a.modified || Infinity) - (b.modified || Infinity),
  late: (a, b) => (b.late ? 1 : 0) - (a.late ? 1 : 0),
  similar: (a, b) => ((b.sim && b.sim.score) || 0) - ((a.sim && a.sim.score) || 0),
};
function applySort() {
  const cmp = SORTS[prefs.sort] || SORTS.order;
  const top = items.filter(i => !i.parent).sort((a, b) => cmp(a, b) || a.order - b.order);
  const sorted = [];
  for (const it of top) sorted.push(it, ...items.filter(i => i.parent === it).sort((a, b) => a.order - b.order));
  items.splice(0, items.length, ...sorted);
  const grid = $('#grid');
  for (const it of items) grid.appendChild(it.tile);
  renumber();
}
$('#sortBy').onchange = (e) => { prefs.sort = e.target.value; applyPrefs(); applySort(); updateFilterDot(); };

// ---------- toolbar ----------
$('#cols').oninput = (e) => { prefs.cols = +e.target.value; applyPrefs(); };
$('#height').oninput = (e) => { prefs.height = +e.target.value; applyPrefs(); };
$('#search').oninput = applyFilter;
$('#kindFilter').onchange = applyFilter;
function applyFilter() {
  const q = $('#search').value.trim().toLowerCase();
  const k = $('#kindFilter').value;
  for (const it of items) {
    const ok = (!k || it.kind === k) && (!lateOnly || it.late) && (!q || it.name.toLowerCase().includes(q) || (it.context || '').toLowerCase().includes(q) || (notes[noteKey(it)] || '').toLowerCase().includes(q));
    it.tile.style.display = ok ? '' : 'none';
  }
  renumber(); updateStatus(); updateFilterDot();
}
function updateKindFilter() {
  const sel = $('#kindFilter');
  const cur = sel.value;
  const kinds = [...new Set(items.map(i => i.kind))].sort();
  sel.innerHTML = '<option value="">All types</option>' + kinds.map(k => `<option value="${k}">${ggKindLabel(k)}</option>`).join('');
  sel.value = kinds.includes(cur) ? cur : '';
}
// ---------- collapsible filters (narrow grid, e.g. next to the side view) ----------
const bar = document.querySelector('.bar');
new ResizeObserver(() => {
  const compact = bar.clientWidth < 1180;
  if (compact !== bar.classList.contains('compact')) {
    bar.classList.toggle('compact', compact);
    if (!compact) setFiltersOpen(false);
  }
}).observe(bar);
function setFiltersOpen(open) {
  bar.classList.toggle('open', open);
  $('#filterToggle').setAttribute('aria-expanded', open);
  $('#filterToggle').classList.toggle('on', open);
  $('#filterToggle').dataset.tip = open ? 'Hide filters' : 'Filters';
}
$('#filterToggle').onclick = () => setFiltersOpen(!bar.classList.contains('open'));
function updateFilterDot() {
  const active = !!$('#search').value.trim() || !!$('#kindFilter').value || lateOnly || prefs.sort !== 'order';
  $('#filterDot').hidden = !active;
}

const closeMenu = () => { $('#morePop').hidden = true; };
$('#moreBtn').onclick = (e) => { e.stopPropagation(); $('#morePop').hidden = !$('#morePop').hidden; };
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenu(); });

// ---------- local files ----------
$('#addFiles').onclick = $('#emptyAdd').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addLocal(e.target.files); e.target.value = ''; };
function addLocal(fileList) {
  for (const f of fileList) {
    const ext = (f.name.match(/\.([^.]+)$/) || [])[1] || '';
    const it = addItem({ file: f, name: f.name, ext, context: '', size: f.size });
    it.url = '';
  }
  applySort();
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

async function openModal(it, mode, remember = true) {
  if (mode && mode !== prefs.view) { prefs.view = mode; if (remember) applyPrefs(); }
  modalCleanup && modalCleanup(); modalCleanup = null;
  modalItem = it;
  $('#modal').hidden = false;
  applyView();
  if (prefs.view === 'side') it.tile.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('#mCtx').textContent = it.context || it.name;
  $('#mName').textContent = it.context ? it.name : (it.meta || '');
  $('#mNote').value = notes[noteKey(it)] || '';
  const vis = visibleItems();
  $('#mPos').textContent = vis.includes(it) ? `${vis.indexOf(it) + 1} / ${vis.length}` : '';
  const body = $('#mBody');
  body.innerHTML = '<div class="center"><div class="spinner"></div></div>';
  body.scrollTop = 0;
  items.forEach(i => i.tile.classList.toggle('focus', i === it));
  setCursor(it, false);
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
  applyView();
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

// ---------- side view: large view docked on the left, grid keeps scrolling on the right ----------
function applyView() {
  const open = !$('#modal').hidden, side = prefs.view === 'side';
  const w = Math.round(Math.min(Math.max(prefs.sideW, 360), innerWidth - 320));
  document.documentElement.style.setProperty('--side-w', w + 'px');
  $('#modal').classList.toggle('side', side);
  document.body.classList.toggle('side-open', open && side);
  document.body.style.overflow = open && !side ? 'hidden' : '';
  fitCols();
  const m = $('#mMode');
  m.innerHTML = ggIcon(side ? 'full' : 'side');
  m.dataset.tip = side ? 'Full screen' : 'Side view';
}
$('#mMode').onclick = () => {
  prefs.view = prefs.view === 'side' ? 'full' : 'side';
  applyPrefs(); applyView();
  if (modalItem && prefs.view === 'side') modalItem.tile.scrollIntoView({ block: 'nearest' });
};
$('#sideGrip').onpointerdown = (e) => {
  e.preventDefault();
  const grip = e.currentTarget;
  grip.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  grip.onpointermove = (ev) => { prefs.sideW = ev.clientX; applyView(); };
  grip.onpointerup = () => {
    grip.onpointermove = grip.onpointerup = null;
    document.body.classList.remove('resizing');
    prefs.sideW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-w'));
    applyPrefs();
  };
};
$('#sideGrip').ondblclick = () => { prefs.sideW = Math.round(innerWidth / 2); applyView(); applyPrefs(); };
addEventListener('resize', () => $('#modal').hidden ? fitCols() : applyView());
applyView();
$('#prev').onclick = () => step(-1);
$('#next').onclick = () => step(1);
$('#mDl').onclick = () => modalItem && downloadItem(modalItem);
$('#mOpen').onclick = () => modalItem && openInNewTab(modalItem);
$('#mNote').oninput = (e) => modalItem && saveNote(modalItem, e.target.value);

// ---------- keyboard shortcuts ----------
function focusNote() {
  const it = current();
  if (!$('#modal').hidden) return $('#mNote').focus();
  if (it) { it.tile.scrollIntoView({ block: 'nearest' }); it.tile.querySelector('.note').focus(); }
}
const showKeys = (on = $('#keysDlg').hidden) => { $('#keysDlg').hidden = !on; };
$('#showKeys').onclick = () => { closeMenu(); showKeys(true); };
$('#keysClose').onclick = () => showKeys(false);
for (const d of document.querySelectorAll('.dialog-back')) d.addEventListener('pointerdown', (e) => { if (e.target === d) d.hidden = true; });

addEventListener('keydown', (e) => {
  const t = e.target;
  if (t.matches && t.matches('input, textarea, select, [contenteditable]')) {
    if (e.key === 'Escape') t.blur();
    else if (e.key === 'Enter' && t.classList.contains('note')) { t.blur(); } // Enter finishes a note
    return;
  }
  const k = e.key, mod = e.ctrlKey || e.metaKey;
  // dialogs and compare take Esc first
  for (const id of ['#keysDlg', '#simDlg']) if (!$(id).hidden) { if (k === 'Escape' || (k === '?' && id === '#keysDlg')) { $(id).hidden = true; e.preventDefault(); } return; }
  if (!$('#compare').hidden) { if (k === 'Escape') { closeCompare(); e.preventDefault(); } return; }
  if (e.altKey) return;
  if (mod) {
    if (k.toLowerCase() === 'a') { e.preventDefault(); visibleItems().forEach(i => picked.add(i)); updatePicks(); }
    return;
  }
  const modalOpen = !$('#modal').hidden;
  const it = current();
  switch (k) {
    case 'ArrowRight': if (!modalOpen) return; step(1); break;
    case 'ArrowLeft': if (!modalOpen) return; step(-1); break;
    case 'j': case 'J': moveCursor(1); break;
    case 'k': case 'K': moveCursor(-1); break;
    case 'Enter': case 's': case 'S': if (!cursor) return; openModal(cursor, 'side'); break;
    case 'f': case 'F': if (!it) return; openModal(it, 'full'); break;
    case 'n': case 'N': focusNote(); break;
    case 'x': case 'X': if (!it) return; togglePick(it, e.shiftKey); break;
    case 'c': case 'C': if (picked.size !== 2) return; $('#selCompare').click(); break;
    case 'o': case 'O': if (!it) return; openInNewTab(it); break;
    case 'd': case 'D': if (!it) return; downloadItem(it); break;
    case '/': $('#search').focus(); break;
    case '?': showKeys(); break;
    case 'Escape': if (modalOpen) closeModal(); else if (picked.size) clearPicks(); else return; break;
    default: return;
  }
  e.preventDefault();
});

// ---------- compare two side by side ----------
let cmpPair = null, cmpCleanups = [];
function closeCompare() {
  cmpCleanups.forEach(f => f && f()); cmpCleanups = [];
  $('#compare').hidden = true; $('#cmpPanes').innerHTML = '';
  document.body.style.overflow = $('#modal').hidden || prefs.view === 'side' ? '' : 'hidden';
  cmpPair = null;
}
async function openCompare(a, b, score) {
  if (!$('#modal').hidden) closeModal();
  cmpCleanups.forEach(f => f && f()); cmpCleanups = [];
  cmpPair = [a, b];
  $('#compare').hidden = false;
  document.body.style.overflow = 'hidden';
  const sc = $('#cmpScore');
  const s = score != null ? score : (a.sim && a.sim.all && a.sim.all.get(b)) ?? null;
  sc.hidden = s == null;
  if (s != null) { sc.textContent = `${Math.round(s * 100)}% similar`; sc.className = 'cmp-score ' + simLevel(s); }
  const panes = $('#cmpPanes');
  panes.innerHTML = '';
  [a, b].forEach((it, i) => {
    if (i) panes.appendChild(Object.assign(document.createElement('div'), { className: 'cmp-div' }));
    const pane = document.createElement('section');
    pane.className = 'cmp-pane';
    pane.innerHTML = `<div class="cmp-phead"><span class="num"></span><span class="ficon" data-kind="${it.kind}">${ggKindIcon(it.kind, 16)}</span>
      <div class="cmp-names"><div class="tctx"></div><div class="tname"></div></div>
      <label class="field notefield" data-tip="Marks / note">${ggIcon('note', 15)}<input class="note" placeholder="Marks / note" aria-label="Marks or note"></label>
      <button class="ibtn" data-a="side" data-tip="Open in side view" aria-label="Open in side view">${ggIcon('side', 16)}</button></div>
      <div class="cmp-body"><div class="center"><div class="spinner"></div></div></div>`;
    pane.querySelector('.num').textContent = it.tile.querySelector('.num').textContent;
    pane.querySelector('.tctx').textContent = it.context || it.name;
    pane.querySelector('.tname').textContent = it.context ? it.name : '';
    if (it.late) pane.querySelector('.cmp-names').insertAdjacentHTML('beforeend', `<span class="lateb" data-tip="${(it.lateText || 'Late').replace(/"/g, '')}">Late</span>`);
    const note = pane.querySelector('.note');
    note.value = notes[noteKey(it)] || '';
    note.oninput = () => saveNote(it, note.value);
    pane.querySelector('[data-a=side]').onclick = () => { closeCompare(); openModal(it, 'side'); };
    panes.appendChild(pane);
    const body = pane.querySelector('.cmp-body');
    getBlob(it).then(() => {
      if (!cmpPair || !cmpPair.includes(it)) return;
      body.innerHTML = '';
      return renderInto(it.kind, it.blob, body, rendererOpts(it, true)).then(r => cmpCleanups.push(r.cleanup));
    }).catch(err => { body.innerHTML = '<div class="center"><div class="err">Couldn\'t show this file</div><div class="msg"></div></div>'; body.querySelector('.msg').textContent = err.message || String(err); });
  });
}
$('#cmpClose').onclick = closeCompare;
$('#cmpSwap').onclick = () => cmpPair && openCompare(cmpPair[1], cmpPair[0]);

// ---------- near-copy detection for Logisim circuits ----------
const simLevel = (s) => s >= 0.9 ? 'high' : s >= 0.75 ? 'mid' : 'low';
let simPairs = [];
$('#findSim').onclick = async () => {
  closeMenu();
  const circs = items.filter(i => i.kind === 'circuit');
  if (circs.length < 2) { setStatus('Need at least 2 Logisim .circ files to compare.'); setTimeout(updateStatus, 4000); return; }
  const feats = new Map(), texts = new Map();
  for (const [i, it] of circs.entries()) {
    setStatus(`Reading circuits… ${i + 1}/${circs.length}`);
    try {
      const txt = await (await getBlob(it)).text();
      const f = circuitFeatures(txt);
      if (f && f.comps) { feats.set(it, f); texts.set(it, txt.replace(/\s+/g, ' ')); }
    } catch { /* skip files that fail to load */ }
  }
  const list = [...feats.keys()];
  simPairs = [];
  for (const it of list) it.sim = { score: 0, other: null, all: new Map() };
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    const identical = texts.get(a) === texts.get(b);
    const r = identical ? { score: 1, parts: {} } : circuitSimilarity(feats.get(a), feats.get(b));
    simPairs.push({ a, b, score: r.score, parts: r.parts, identical });
    for (const [x, y] of [[a, b], [b, a]]) {
      x.sim.all.set(y, r.score);
      if (r.score > x.sim.score) { x.sim.score = r.score; x.sim.other = y; }
    }
  }
  simPairs.sort((p, q) => q.score - p.score);
  updateStatus();
  renderSimBadges();
  renderSimList();
  $('#simSub').textContent = `${list.length} circuits checked · ${simPairs.length} pairs compared`;
  $('#simDlg').hidden = false;
  if (prefs.sort === 'similar') applySort();
};
function renderSimBadges() {
  const th = +$('#simTh').value / 100;
  for (const it of items) {
    const b = it.tile.querySelector('.simb');
    if (!it.sim || !it.sim.other || it.sim.score < th) { b.hidden = true; continue; }
    const o = it.sim.other;
    b.hidden = false;
    b.className = 'simb ' + simLevel(it.sim.score);
    b.innerHTML = ggIcon('similar', 12) + Math.round(it.sim.score * 100) + '%';
    b.dataset.tip = `Like ${o.context || o.name}`;
    b.onclick = (e) => { e.stopPropagation(); openCompare(it, o, it.sim.score); };
  }
}
const GROUP_LABEL = { layout: 'layout', wires: 'wiring', parts: 'parts', labels: 'labels', names: 'subcircuits' };
function renderSimList() {
  const th = +$('#simTh').value / 100;
  $('#simThVal').textContent = Math.round(th * 100) + '%';
  const box = $('#simList');
  box.innerHTML = '';
  const shown = simPairs.filter(p => p.score >= th);
  if (!shown.length) { box.innerHTML = '<div class="sim-empty">No pairs above this level. Lower the slider to see weaker matches.</div>'; return; }
  for (const p of shown) {
    const row = document.createElement('div');
    row.className = 'sim-row';
    const who = (it) => `<span class="sim-who"><span class="num">${it.tile.querySelector('.num').textContent}</span><b></b><small></small></span>`;
    row.innerHTML = `<div class="sim-pct ${simLevel(p.score)}"><span>${Math.round(p.score * 100)}%</span><i style="width:${Math.round(p.score * 100)}%"></i></div>
      <div class="sim-pair">${who(p.a)}<span class="sim-vs">${ggIcon('swap', 14)}</span>${who(p.b)}
      <div class="sim-why">${p.identical ? '<em>Identical file</em>' : Object.entries(p.parts).map(([g, v]) => `${GROUP_LABEL[g]} ${Math.round(v * 100)}%`).join(' · ')}</div></div>
      <button class="btn sim-cmp">${ggIcon('compare', 14)}Compare</button>`;
    const [wa, wb] = row.querySelectorAll('.sim-who');
    for (const [w, it] of [[wa, p.a], [wb, p.b]]) { w.querySelector('b').textContent = it.context || it.name; w.querySelector('small').textContent = it.context ? it.name : ''; }
    row.querySelector('.sim-cmp').onclick = () => { $('#simDlg').hidden = true; openCompare(p.a, p.b, p.score); };
    box.appendChild(row);
  }
}
$('#simTh').oninput = () => { renderSimList(); renderSimBadges(); };
$('#simClose').onclick = () => { $('#simDlg').hidden = true; };
