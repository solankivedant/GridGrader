const $ = (s) => document.querySelector(s);
const knownExts = [...Object.keys(GG_EXT_TO_KIND), ...GG_EXTRA_FILE_EXTS];

let tab = null;
let page = { title: '', url: '' };
let files = [];             // all scanned files
const selected = new Set(); // urls
const activeKinds = new Set();
const firstOpen = {};       // kind -> seen

async function scan() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const includeAll = $('#includeAll').checked;
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: ggScanPage,
      args: [knownExts, includeAll],
    });
  } catch (e) {
    $('#pageTitle').textContent = 'Can\'t read this page (browser pages and the Web Store are blocked).';
    files = [];
    render();
    return;
  }
  const seen = new Set();
  files = [];
  for (const r of results) {
    const res = r.result;
    if (!res) continue;
    if (res.isTop) page = { title: res.title, url: res.url };
    for (const f of res.files) {
      if (seen.has(f.url)) continue;
      seen.add(f.url);
      f.kind = f.kindHint || ggKindOf(f.ext);
      if (GG_HIDDEN_IN_SELECTION.includes(f.kind)) continue; // code files are not offered
      files.push(f);
    }
  }
  $('#pageTitle').textContent = `${files.length} file${files.length === 1 ? '' : 's'} on “${page.title || tab.title}”`;
  selected.clear();
  // Images are listed but not ticked: on most pages they are logos or page art, not submissions.
  for (const f of files) if (!f.guessed && f.kind !== 'image') selected.add(f.url);
  for (const f of files) if (!(f.kind in firstOpen)) { firstOpen[f.kind] = true; activeKinds.add(f.kind); }
  render();
}

function visibleFiles() {
  const q = $('#search').value.trim().toLowerCase();
  return files.filter(f => activeKinds.has(f.kind) &&
    (!q || f.name.toLowerCase().includes(q) || (f.context || '').toLowerCase().includes(q)));
}

function render() {
  // chips
  const counts = {};
  for (const f of files) counts[f.kind] = (counts[f.kind] || 0) + 1;
  const chips = $('#chips');
  chips.innerHTML = '';
  for (const kind of Object.keys(counts).sort()) {
    const b = document.createElement('button');
    b.className = 'chip' + (activeKinds.has(kind) ? ' on' : '');
    b.innerHTML = `${ggKindLabel(kind)}<span class="n">${counts[kind]}</span>`;
    b.onclick = () => { activeKinds.has(kind) ? activeKinds.delete(kind) : activeKinds.add(kind); render(); };
    chips.appendChild(b);
  }

  const list = $('#list');
  list.innerHTML = '';
  const vis = visibleFiles();
  vis.forEach((f, i) => {
    const row = document.createElement('label');
    row.className = 'item';
    row.title = f.url;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(f.url);
    cb.onchange = () => { cb.checked ? selected.add(f.url) : selected.delete(f.url); updateButton(); };
    const mid = document.createElement('div');
    mid.style.minWidth = '0';
    const n = document.createElement('div'); n.className = 'name'; n.textContent = f.name;
    mid.appendChild(n);
    if (f.context) { const c = document.createElement('div'); c.className = 'ctx'; c.textContent = f.context; mid.appendChild(c); }
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = f.ext || ggKindLabel(f.kind); badge.dataset.kind = f.kind;
    const idx = document.createElement('span'); idx.className = 'idx'; idx.textContent = i + 1;
    if (f.late) { const l = document.createElement("span"); l.className = "late"; l.textContent = "Late"; l.dataset.tip = f.lateText || "Late"; n.appendChild(l); }
    row.append(cb, idx, mid, badge);
    list.appendChild(row);
  });
  $('#empty').hidden = files.length > 0;
  syncRange(vis.length);
  updateButton();
}

function updateButton() {
  const vis = visibleFiles();
  const n = vis.filter(f => selected.has(f.url)).length;
  $('#selAll').disabled = n === vis.length;
  $('#selNone').disabled = selected.size === 0;
  const btn = $('#open');
  $('#openLabel').textContent = n ? `Open ${n} file${n === 1 ? '' : 's'} in grid` : (files.length ? 'Select files to open' : 'Open empty grid');
  btn.disabled = files.length > 0 && n === 0;
}

let rangeTouched = false; // until the user edits "to", it follows the list length

function syncRange(n) {
  $('#rangeRow').hidden = n === 0;
  const from = $('#rFrom'), to = $('#rTo');
  from.max = to.max = n;
  $('#rOf').textContent = `of ${n}`;
  if (!rangeTouched || +to.value > n) to.value = n;
  if (+from.value > n) from.value = n;
}

function applyRange() {
  const vis = visibleFiles();
  if (!vis.length) return;
  const clamp = (v, d) => Math.min(vis.length, Math.max(1, parseInt(v, 10) || d));
  let a = clamp($('#rFrom').value, 1), b = clamp($('#rTo').value, vis.length);
  if (a > b) [a, b] = [b, a];
  rangeTouched = true;
  $('#rFrom').value = a; $('#rTo').value = b;
  vis.forEach((f, i) => (i >= a - 1 && i < b) ? selected.add(f.url) : selected.delete(f.url));
  render();
}

$('#rFrom').oninput = $('#rTo').oninput = () => { rangeTouched = true; };
$('#rFrom').onkeydown = $('#rTo').onkeydown = (e) => { if (e.key === 'Enter') applyRange(); };
$('#rApply').onclick = applyRange;
$('#rescan').onclick = scan;
$('#search').oninput = render;
$('#includeAll').onchange = scan;
$('#selAll').onclick = () => { for (const f of visibleFiles()) selected.add(f.url); render(); };
$('#selNone').onclick = () => { selected.clear(); render(); };

$('#open').onclick = async () => {
  const chosen = visibleFiles().filter(f => selected.has(f.url));
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await chrome.storage.local.set({
    ['job_' + id]: { created: Date.now(), tabId: tab && tab.id, page, files: chosen },
  });
  // tidy up jobs older than 7 days
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter(k => k.startsWith('job_') && Date.now() - (all[k].created || 0) > 7 * 864e5);
  if (old.length) chrome.storage.local.remove(old);
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + '?job=' + id, index: tab ? tab.index + 1 : undefined });
  window.close();
};

scan();
