// Renderers: each takes (blob, container, opts) and returns { cleanup, meta }.
import * as pdfjs from './lib/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
export const fmtSize = (n) => n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- type sniffing from the first bytes ----------
export async function sniffKind(blob, fallbackKind, contentType = '') {
  const head = new Uint8Array(await blob.slice(0, 2048).arrayBuffer());
  const s = String.fromCharCode(...head.slice(0, 64));
  const ct = contentType.toLowerCase();
  if (s.startsWith('%PDF')) return 'pdf';
  if (head[0] === 0x89 && s.slice(1, 4) === 'PNG') return 'image';
  if (s.startsWith('GIF8')) return 'image';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image';
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return 'image';
  if (s.startsWith('BM') && head.length > 30 && fallbackKind === 'image') return 'image';
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WAVE') return 'audio';
  if (s.startsWith('ID3') || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && fallbackKind !== 'video')) return 'audio';
  if (s.startsWith('OggS') || s.startsWith('fLaC')) return fallbackKind === 'video' ? 'video' : 'audio';
  if (s.slice(4, 8) === 'ftyp') return /M4A|M4B/.test(s.slice(8, 12)) ? 'audio' : 'video';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video';
  if (s.startsWith('PK\x03\x04')) {
    if (['doc', 'sheet', 'slides', 'archive'].includes(fallbackKind)) return fallbackKind;
    try {
      const zip = await JSZip.loadAsync(blob);
      if (zip.file('word/document.xml')) return 'doc';
      if (zip.file('xl/workbook.xml')) return 'sheet';
      if (zip.file('ppt/presentation.xml')) return 'slides';
    } catch {}
    return 'archive';
  }
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return fallbackKind === 'sheet' ? 'sheet' : 'other'; // old .xls/.doc
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon)/.test(ct)) return 'image';
  if (/^video\/(mp4|webm|ogg|quicktime)/.test(ct)) return 'video';
  if (/^audio\/(mpeg|mp3|mp4|wav|x-wav|ogg|webm|aac|flac)/.test(ct)) return 'audio';
  // text?
  const isText = !head.some(b => b === 0);
  if (isText) {
    const t = new TextDecoder().decode(head);
    if (/^\s*<\?xml/.test(t) && /<project\b/.test(t)) return 'circuit';
    if (/^\s*\{/.test(t) && /"cells"\s*:/.test(t)) return 'notebook';
    if (/^\s*<svg\b|^\s*<\?xml[^>]*>\s*<svg\b/i.test(t)) return 'image';
    if (fallbackKind !== 'other') return fallbackKind;
    return 'code';
  }
  return fallbackKind;
}

// Does this blob look like an HTML page (e.g. a login/preview page) rather than the file?
export async function looksLikeHtmlPage(blob) {
  const t = (await blob.slice(0, 600).text()).trimStart().toLowerCase();
  return t.startsWith('<!doctype html') || t.startsWith('<html');
}

// ---------- dispatcher ----------
export async function renderInto(kind, blob, host, opts = {}) {
  const fn = {
    image: renderImage, pdf: renderPdf, video: renderVideo, audio: renderAudio,
    code: renderCode, sheet: renderSheet, doc: renderDocx, slides: renderPptx,
    archive: renderZip, notebook: renderNotebook, model3d: renderModel, circuit: renderCircuit,
  }[kind] || renderInfo;
  return fn(blob, host, opts);
}

// ---------- image ----------
async function renderImage(blob, host, opts) {
  let b = blob;
  if (opts.ext === 'svg' && !b.type.includes('svg')) b = new Blob([await blob.arrayBuffer()], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(b);
  const img = el('img', 'fit');
  img.src = url;
  img.alt = opts.name || '';
  img.title = 'Click to toggle actual size';
  img.onclick = () => img.classList.toggle('zoom');
  host.appendChild(img);
  await img.decode().catch(() => { throw new Error('This image format can\'t be displayed by the browser.'); });
  return { cleanup: () => URL.revokeObjectURL(url), meta: `${img.naturalWidth}×${img.naturalHeight}` };
}

// ---------- pdf ----------
async function renderPdf(blob, host, opts) {
  const data = new Uint8Array(await blob.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const wrap = el('div', 'pdf-pages');
  host.appendChild(wrap);
  const maxW = opts.large ? 1000 : Infinity;
  const first = await pdf.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = el('div', 'pdf-page');
    p.style.width = opts.large ? `min(100%, ${maxW}px)` : '100%';
    p.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
    p.appendChild(el('span', 'pno', `${i}/${pdf.numPages}`));
    p.dataset.n = i;
    wrap.appendChild(p);
    pages.push({ div: p, renderedAt: 0, busy: false });
  }
  let dead = false;
  async function draw(idx) {
    const pg = pages[idx];
    const cssW = pg.div.clientWidth || host.clientWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const target = Math.min(Math.max(cssW * dpr, 300), 2400);
    if (pg.busy || (pg.renderedAt && pg.renderedAt >= target * 0.8)) return;
    pg.busy = true;
    try {
      const page = await pdf.getPage(idx + 1);
      if (dead) return;
      const base = page.getViewport({ scale: 1 });
      pg.div.style.aspectRatio = `${base.width} / ${base.height}`;
      const vp = page.getViewport({ scale: target / base.width });
      const canvas = el('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      if (dead) return;
      pg.div.querySelector('canvas')?.remove();
      pg.div.prepend(canvas);
      pg.renderedAt = target;
    } finally { pg.busy = false; }
  }
  const visible = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = +e.target.dataset.n - 1;
      if (e.isIntersecting) { visible.add(i); draw(i); } else visible.delete(i);
    }
  }, { root: host, rootMargin: '600px 0px' });
  pages.forEach(p => io.observe(p.div));
  const ro = new ResizeObserver(() => visible.forEach(i => draw(i)));
  ro.observe(host);
  return {
    cleanup: () => { dead = true; io.disconnect(); ro.disconnect(); pdf.destroy(); },
    meta: `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`,
  };
}

// ---------- video / audio ----------
async function renderVideo(blob, host) {
  const url = URL.createObjectURL(blob);
  const v = el('video', 'fit');
  v.controls = true; v.preload = 'metadata'; v.src = url;
  host.appendChild(v);
  const meta = await new Promise((res, rej) => {
    v.onloadedmetadata = () => res(`${fmtTime(v.duration)} · ${v.videoWidth}×${v.videoHeight}`);
    v.onerror = () => rej(new Error('The browser can\'t play this video format (common with .avi, .wmv, .flv and some .mov/.mkv files). Download it to watch.'));
  });
  return { cleanup: () => { v.pause(); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }, meta };
}
async function renderAudio(blob, host, opts) {
  const url = URL.createObjectURL(blob);
  const w = el('div', 'audio-wrap');
  w.append(el('div', 'wave', '♪'), el('div', null, opts.name || ''));
  const a = el('audio');
  a.controls = true; a.preload = 'metadata'; a.src = url;
  w.appendChild(a);
  host.appendChild(w);
  const meta = await new Promise((res, rej) => {
    a.onloadedmetadata = () => res(fmtTime(a.duration));
    a.onerror = () => rej(new Error('The browser can\'t play this audio format (common with .wma and .amr). Download it to listen.'));
  });
  return { cleanup: () => { a.pause(); URL.revokeObjectURL(url); }, meta };
}
const fmtTime = (s) => !isFinite(s) ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------- code / text ----------
const MAX_TEXT = 1.5 * 1024 * 1024;
async function renderCode(blob, host, opts) {
  if (['csv', 'tsv'].includes(opts.ext)) return renderSheet(blob, host, opts);
  const text = await blob.slice(0, MAX_TEXT).text();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const LIMIT = 20000;
  const pre = el('pre', 'code' + (['txt', 'md', 'markdown', 'log', 'tex'].includes(opts.ext) ? ' wrap' : ''));
  const frag = document.createDocumentFragment();
  for (const ln of lines.slice(0, LIMIT)) frag.appendChild(el('span', 'l', ln || ' '));
  pre.appendChild(frag);
  host.appendChild(pre);
  if (lines.length > LIMIT || blob.size > MAX_TEXT) host.appendChild(el('div', 'trunc', 'File truncated in preview — download for the full file.'));
  return { cleanup: () => {}, meta: `${lines.length.toLocaleString()} lines` };
}

// ---------- spreadsheets ----------
async function renderSheet(blob, host, opts) {
  let wb;
  if (['csv', 'tsv'].includes(opts.ext)) {
    wb = XLSX.read(await blob.text(), { type: 'string', sheetRows: 3000, FS: opts.ext === 'tsv' ? '\t' : undefined });
  } else {
    wb = XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array', sheetRows: 3000, cellDates: true });
  }
  const tabs = el('div', 'tabs');
  const body = el('div', 'sheet-wrap');
  const show = (name, btn) => {
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
    body.innerHTML = XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' });
  };
  wb.SheetNames.forEach((n, i) => {
    const b = el('button', null, n);
    b.onclick = () => show(n, b);
    tabs.appendChild(b);
    if (i === 0) setTimeout(() => show(n, b));
  });
  if (wb.SheetNames.length > 1) host.appendChild(tabs);
  host.appendChild(body);
  show(wb.SheetNames[0], tabs.firstChild);
  return { cleanup: () => {}, meta: `${wb.SheetNames.length} sheet${wb.SheetNames.length === 1 ? '' : 's'}` };
}

// ---------- Word ----------
async function renderDocx(blob, host, opts) {
  const inner = el('div', 'docx-host');
  host.appendChild(inner);
  await docx.renderAsync(blob, inner, null, {
    inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true,
    useBase64URL: true, renderHeaders: true, renderFooters: true, experimental: false,
  });
  const fit = () => {
    const page = inner.querySelector('section.docx');
    const pw = (page ? page.offsetWidth : 816) + 24;
    const z = Math.min(1, (host.clientWidth - 4) / pw);
    inner.style.zoom = z;
    inner.style.margin = opts.large ? '0 auto' : '';
    inner.style.width = opts.large ? `${pw}px` : '';
  };
  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(host);
  const pagesN = inner.querySelectorAll('section.docx').length;
  const words = (inner.innerText.match(/\S+/g) || []).length;
  return { cleanup: () => ro.disconnect(), meta: `${pagesN} page${pagesN === 1 ? '' : 's'} · ${words.toLocaleString()} words` };
}

// ---------- PowerPoint (text + images preview) ----------
async function renderPptx(blob, host) {
  const zip = await JSZip.loadAsync(blob);
  const urls = [];
  const wrap = el('div', 'slides');
  host.appendChild(el('div', 'note-banner', 'Slide text & images preview — layout is not reproduced. Download for the full deck.'));
  const thumb = zip.file('docProps/thumbnail.jpeg');
  if (thumb) {
    const u = URL.createObjectURL(await thumb.async('blob')); urls.push(u);
    const i = el('img', 'thumb'); i.src = u; wrap.appendChild(i);
  }
  const slideFiles = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  const parser = new DOMParser();
  for (const [i, path] of slideFiles.entries()) {
    const xml = parser.parseFromString(await zip.file(path).async('string'), 'application/xml');
    const paras = [...xml.getElementsByTagNameNS('*', 'p')].map(p =>
      [...p.getElementsByTagNameNS('*', 't')].map(t => t.textContent).join('')).filter(Boolean);
    const card = el('div', 'slide');
    card.appendChild(el('h4', null, `Slide ${i + 1}`));
    card.appendChild(el('div', 'st', paras.join('\n') || '(no text)'));
    // images referenced by this slide
    const relsPath = path.replace('slides/', 'slides/_rels/') + '.rels';
    const rels = zip.file(relsPath);
    if (rels) {
      const rx = parser.parseFromString(await rels.async('string'), 'application/xml');
      const imgs = [...rx.getElementsByTagName('Relationship')].filter(r => /image/.test(r.getAttribute('Type'))).slice(0, 2);
      for (const r of imgs) {
        const target = 'ppt/' + r.getAttribute('Target').replace(/^\.\.\//, '');
        const f = zip.file(target);
        if (f && /\.(png|jpe?g|gif|webp|svg)$/i.test(target)) {
          const u = URL.createObjectURL(await f.async('blob')); urls.push(u);
          const im = el('img'); im.src = u; card.appendChild(im);
        }
      }
    }
    wrap.appendChild(card);
  }
  host.appendChild(wrap);
  return { cleanup: () => urls.forEach(URL.revokeObjectURL), meta: `${slideFiles.length} slides` };
}

// ---------- ZIP ----------
async function renderZip(blob, host, opts) {
  const zip = await JSZip.loadAsync(blob);
  const entries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name));
  const ul = el('ul', 'zip-list');
  let nFiles = 0;
  for (const f of entries) {
    if (/(^|\/)(__MACOSX|\.DS_Store)/.test(f.name)) continue;
    const li = el('li');
    const n = el('span', 'zn' + (f.dir ? ' dir' : ''), f.name);
    n.title = f.name;
    const size = f._data && f._data.uncompressedSize;
    li.append(n, el('span', 'zs', f.dir ? '' : fmtSize(size)));
    if (!f.dir) {
      nFiles++;
      const ext = (f.name.match(/\.([^.\/]+)$/) || [])[1]?.toLowerCase() || '';
      const b = el('button', null, 'View');
      b.title = 'Open this file as its own tile';
      b.onclick = () => opts.onOpenEntry && opts.onOpenEntry(f.name, ext, () => f.async('blob'));
      li.appendChild(b);
    } else li.appendChild(el('span'));
    ul.appendChild(li);
  }
  host.appendChild(ul);
  return { cleanup: () => {}, meta: `${nFiles} files inside` };
}

// ---------- Jupyter notebook ----------
async function renderNotebook(blob, host) {
  const nb = JSON.parse(await blob.text());
  const cells = nb.cells || (nb.worksheets && nb.worksheets[0].cells) || [];
  const wrap = el('div', 'nb');
  const join = (s) => Array.isArray(s) ? s.join('') : (s || '');
  let codeN = 0;
  for (const c of cells) {
    const box = el('div', 'cell');
    if (c.cell_type === 'markdown') {
      box.appendChild(el('div', 'md', join(c.source)));
    } else if (c.cell_type === 'code') {
      codeN++;
      box.appendChild(el('div', 'lab', `In [${c.execution_count ?? ' '}]`));
      box.appendChild(el('pre', null, join(c.source || c.input)));
      for (const o of (c.outputs || [])) {
        const out = el('div', 'out');
        const d = o.data || o;
        if (d['image/png']) { const i = el('img'); i.src = 'data:image/png;base64,' + join(d['image/png']).replace(/\s/g, ''); out.appendChild(i); }
        else if (d['image/jpeg']) { const i = el('img'); i.src = 'data:image/jpeg;base64,' + join(d['image/jpeg']).replace(/\s/g, ''); out.appendChild(i); }
        else if (o.output_type === 'error') out.appendChild(el('pre', 'err', `${o.ename}: ${o.evalue}`));
        else { const t = join(o.text) || join(d['text/plain']); if (t) out.appendChild(el('pre', null, t)); }
        if (out.childNodes.length) box.appendChild(out);
      }
    } else box.appendChild(el('pre', null, join(c.source)));
    wrap.appendChild(box);
  }
  host.appendChild(wrap);
  return { cleanup: () => {}, meta: `${cells.length} cells · ${codeN} code` };
}

// ---------- 3D (STL / OBJ) ----------
async function renderModel(blob, host, opts) {
  const THREE = await import('./lib/three.module.min.js');
  const { STLLoader } = await import('./lib/STLLoader.js');
  const { OBJLoader } = await import('./lib/OBJLoader.js');
  const { OrbitControls } = await import('./lib/OrbitControls.js');

  const wrap = el('div', 'three-host');
  host.appendChild(wrap);
  const W = () => Math.max(50, host.clientWidth), H = () => Math.max(50, host.clientHeight);

  let object, tris = 0;
  const mat = new THREE.MeshStandardMaterial({ color: 0x8fa8ff, metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide });
  if (opts.ext === 'obj') {
    object = new OBJLoader().parse(await blob.text());
    object.traverse(o => { if (o.isMesh) { o.material = mat; tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; } });
  } else {
    const geo = new STLLoader().parse(await blob.arrayBuffer());
    geo.rotateX(-Math.PI / 2);   // CAD exports are Z-up; three.js is Y-up
    geo.computeVertexNormals(); // many STLs ship with zero normals
    tris = geo.attributes.position.count / 3;
    object = new THREE.Mesh(geo, mat);
  }
  const scene = new THREE.Scene();
  scene.add(object);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center);
  const radius = Math.max(size.x, size.y, size.z) || 1;

  const camera = new THREE.PerspectiveCamera(40, W() / H(), radius / 100, radius * 100);
  const dist = radius / (2 * Math.tan((camera.fov * Math.PI / 180) / 2)) * 1.35;
  camera.position.set(dist * 0.8, dist * 0.6, dist * 0.9);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  camera.add(key); key.position.set(1, 1, 2);
  scene.add(camera);
  const grid = new THREE.GridHelper(radius * 2, 10, 0x8890a0, 0xc6cad3);
  grid.position.y = -size.y / 2;
  grid.material.transparent = true; grid.material.opacity = 0.5;
  scene.add(grid);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !opts.large });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(W(), H());
  const meta = `${Math.round(tris).toLocaleString()} triangles · ${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)}`;

  if (!opts.large) {
    // Tiles get a still image so many models don't exhaust WebGL contexts.
    renderer.render(scene, camera);
    const img = el('img', 'fit');
    img.style.cursor = 'default';
    img.style.background = 'transparent';
    img.src = renderer.domElement.toDataURL('image/png');
    wrap.appendChild(img);
    wrap.appendChild(el('div', 'hint', 'Open large view (⤢) to rotate'));
    renderer.dispose(); renderer.forceContextLoss();
    return { cleanup: () => {}, meta };
  }
  wrap.appendChild(renderer.domElement);
  wrap.appendChild(el('div', 'hint', 'Drag to rotate · scroll to zoom · right-drag to pan'));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  let raf;
  const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
  loop();
  const ro = new ResizeObserver(() => { camera.aspect = W() / H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H()); });
  ro.observe(host);
  return { cleanup: () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); renderer.forceContextLoss(); }, meta };
}

// ---------- Logisim .circ ----------
async function renderCircuit(blob, host) {
  const doc = new DOMParser().parseFromString(await blob.text(), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This .circ file is not valid XML.');
  const circuits = [...doc.querySelectorAll('project > circuit')];
  if (!circuits.length) throw new Error('No circuits found in this .circ file.');
  const mainName = doc.querySelector('project > main')?.getAttribute('name');
  const circuitNames = new Set(circuits.map(c => c.getAttribute('name')));

  const box = el('div', 'circ-host');
  const tabs = el('div', 'tabs');
  const stage = el('div');
  stage.style.cssText = 'flex:1;min-height:0;display:flex;';
  const stats = el('div', 'circ-stats');
  if (circuits.length > 1) box.appendChild(tabs);
  box.append(stage, stats);
  host.appendChild(box);

  let totalComps = 0;
  const show = (circ, btn) => {
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
    const { svg, summary } = drawCircuit(circ, circuitNames);
    stage.innerHTML = '';
    stage.appendChild(svg);
    enablePanZoom(svg);
    stats.textContent = summary + ' · approximate schematic';
    stats.title = stats.textContent;
  };
  let start = circuits[0];
  circuits.forEach(c => {
    totalComps += c.querySelectorAll(':scope > comp').length;
    const b = el('button', null, c.getAttribute('name'));
    b.onclick = () => show(c, b);
    tabs.appendChild(b);
    if (c.getAttribute('name') === mainName) start = c;
  });
  show(start, tabs.children[circuits.indexOf(start)]);
  return { cleanup: () => {}, meta: `${circuits.length} circuit${circuits.length === 1 ? '' : 's'} · ${totalComps} components` };
}

function drawCircuit(circ, circuitNames) {
  const P = (s) => { const m = /\((-?\d+)\s*,\s*(-?\d+)\)/.exec(s || ''); return m ? [+m[1], +m[2]] : null; };
  const attr = (c, n) => { const a = c.querySelector(`:scope > a[name="${n}"]`); return a ? (a.getAttribute('val') ?? a.textContent) : null; };
  const pts = [];
  const parts = [];
  const texts = [];
  const counts = {};

  // wires
  const ends = new Map();
  const bump = (p) => { const k = p.join(','); ends.set(k, (ends.get(k) || 0) + 1); };
  const wires = [...circ.querySelectorAll(':scope > wire')];
  for (const w of wires) {
    const a = P(w.getAttribute('from')), b = P(w.getAttribute('to'));
    if (!a || !b) continue;
    pts.push(a, b); bump(a); bump(b);
    parts.push(`<line class="cw" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`);
  }
  for (const [k, n] of ends) if (n >= 3) { const [x, y] = k.split(',').map(Number); parts.push(`<circle class="cj" cx="${x}" cy="${y}" r="3.2"/>`); }

  const ANG = { east: 0, south: 90, west: 180, north: 270 };
  const GATES = /^(AND|OR|NOT|XOR|NAND|NOR|XNOR|Buffer|Odd Parity|Even Parity|Controlled Buffer|Controlled Inverter)( Gate)?$/;
  const comps = [...circ.querySelectorAll(':scope > comp')];
  for (const c of comps) {
    const name = c.getAttribute('name') || '?';
    const loc = P(c.getAttribute('loc'));
    if (!loc) continue;
    counts[name] = (counts[name] || 0) + 1;
    const [x, y] = loc;
    const label = attr(c, 'label') || '';
    const defFacing = (name === 'LED' || name === 'Tunnel') ? 'west' : 'east';
    const facing = attr(c, 'facing') || defFacing;
    const a = ANG[facing] ?? 0;
    const sizeAttr = +attr(c, 'size') || 50;
    let w = 40, h = 40, shape = 'box', inner = '';

    if (name === 'Text') {
      const t = attr(c, 'text') || '';
      texts.push(`<text class="ct big" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${esc(t)}</text>`);
      pts.push(loc);
      continue;
    }
    if (GATES.test(name)) {
      const g = name.replace(' Gate', '');
      if (g === 'NOT' || g === 'Buffer') { w = sizeAttr <= 30 ? 20 : 30; h = 20; }
      else { w = sizeAttr; h = sizeAttr; }
      shape = 'gate:' + g;
    } else if (name === 'Pin') { w = 20; h = 20; shape = attr(c, 'output') === 'true' ? 'outpin' : 'inpin'; }
    else if (name === 'Probe') { w = 20; h = 20; shape = 'round'; }
    else if (name === 'Tunnel') { w = Math.max(30, label.length * 7 + 14); h = 20; shape = 'tunnel'; }
    else if (name === 'Constant') { w = 20; h = 20; inner = attr(c, 'value') || '1'; }
    else if (name === 'Clock') { w = 20; h = 20; inner = 'CLK'; }
    else if (name === 'Ground' || name === 'Power') { w = 16; h = 16; inner = name === 'Ground' ? 'GND' : 'VCC'; }
    else if (name === 'Splitter') { const f = +attr(c, 'fanout') || 2; w = 10; h = 10 * f + 10; shape = 'splitter'; }
    else if (name === 'LED' || name === 'Button') { w = 20; h = 20; shape = name === 'LED' ? 'round' : 'box'; inner = ''; }
    else if (/Display/.test(name)) { w = 40; h = 60; inner = 'DISP'; }
    else if (/Multiplexer|Demultiplexer|Decoder|Priority Encoder|Bit Selector/.test(name)) { w = 30; h = 50; inner = name.replace(/plexer|coder/, '').slice(0, 5).toUpperCase(); }
    else if (/Flip-Flop/.test(name)) { w = 40; h = 50; inner = name.split(' ')[0]; }
    else if (/Register|Counter|Shift|RAM|ROM|Random/.test(name)) { w = 50; h = 50; inner = name.split(' ')[0].toUpperCase(); }
    else if (/Adder|Subtractor|Multiplier|Divider|Comparator|Negator|Shifter|Bit Adder|Bit Finder/.test(name)) { w = 40; h = 40; inner = { Adder: '+', Subtractor: '−', Multiplier: '×', Divider: '÷', Comparator: '<>', Negator: '−x' }[name] || name.slice(0, 4); }
    else if (circuitNames.has(name)) { w = 50; h = 40; inner = name; shape = 'sub'; }
    else { inner = name.slice(0, 6); }

    // body sits "behind" the connection point, opposite to facing
    const bx = { 0: [x - w, y - h / 2, w, h], 90: [x - h / 2, y - w, h, w], 180: [x, y - h / 2, w, h], 270: [x - h / 2, y, h, w] }[a] || [x - w, y - h / 2, w, h];
    pts.push([bx[0], bx[1]], [bx[0] + bx[2], bx[1] + bx[3]]);
    const cx = bx[0] + bx[2] / 2, cy = bx[1] + bx[3] / 2;

    if (shape.startsWith('gate:')) {
      parts.push(`<g transform="translate(${x} ${y}) rotate(${a})">${gatePath(shape.slice(5), w, h)}</g>`);
    } else if (shape === 'tunnel') {
      parts.push(`<g transform="translate(${x} ${y}) rotate(${a})"><path class="cc" d="M0 0 L-8 ${-h / 2} H${-w} V${h / 2} H-8 Z"/></g>`);
      texts.push(`<text class="ct" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle">${esc(label)}</text>`);
    } else if (shape === 'inpin' || shape === 'outpin') {
      const r = shape === 'outpin' ? 9 : 2;
      parts.push(`<rect class="cc pin" x="${bx[0]}" y="${bx[1]}" width="${bx[2]}" height="${bx[3]}" rx="${r}"/>`);
      texts.push(`<text class="ct small" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle">${shape === 'outpin' ? 'out' : 'in'}</text>`);
    } else if (shape === 'round') {
      parts.push(`<circle class="cc" cx="${cx}" cy="${cy}" r="${Math.min(bx[2], bx[3]) / 2}"/>`);
    } else if (shape === 'splitter') {
      parts.push(`<rect class="cc split" x="${bx[0]}" y="${bx[1]}" width="${bx[2]}" height="${bx[3]}"/>`);
    } else {
      parts.push(`<rect class="cc${shape === 'sub' ? ' sub' : ''}" x="${bx[0]}" y="${bx[1]}" width="${bx[2]}" height="${bx[3]}" rx="3"/>`);
      if (inner) texts.push(`<text class="ct small" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle">${esc(inner)}</text>`);
    }
    if (label && shape !== 'tunnel') {
      const ly = bx[1] - 5;
      texts.push(`<text class="ct lab" x="${cx}" y="${ly}" text-anchor="middle">${esc(label)}</text>`);
      pts.push([cx, ly - 10]);
    }
  }

  if (!pts.length) pts.push([0, 0], [200, 120]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const pad = 30;
  const vb = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + pad * 2, Math.max(...ys) - Math.min(...ys) + pad * 2];
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', vb.join(' '));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.innerHTML = `<defs><pattern id="gg-dots" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.7" class="cg"/></pattern></defs>
    <rect x="${vb[0] - 5000}" y="${vb[1] - 5000}" width="${vb[2] + 10000}" height="${vb[3] + 10000}" fill="url(#gg-dots)"/>
    ${parts.join('')}${texts.join('')}`;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${k}× ${n.replace(' Gate', '')}`).join(', ');
  const summary = `${circ.getAttribute('name')}: ${comps.length} components, ${wires.length} wires${top ? ' — ' + top : ''}`;
  return { svg, summary };
}

function gatePath(g, w, h) {
  const bubble = /^N|XNOR/.test(g) && g !== 'NOT' ? 6 : 0;
  const L = -w, T = -h / 2, B = h / 2;
  const R = -bubble;
  let d;
  if (g === 'NOT' || g === 'Buffer' || /Controlled/.test(g)) {
    d = `M${L} ${T} L${g === 'NOT' ? -6 : 0} 0 L${L} ${B} Z`;
    return `<path class="cc" d="${d}"/>` + (g === 'NOT' ? `<circle class="cc" cx="-3" cy="0" r="3"/>` : '');
  }
  if (/AND/.test(g)) {
    const mid = R - h / 2;
    d = `M${L} ${T} H${mid} A${h / 2} ${h / 2} 0 0 1 ${mid} ${B} H${L} Z`;
  } else if (/OR|Parity/.test(g)) {
    const k = /X/.test(g) || /Parity/.test(g) ? 6 : 0;
    d = `M${L + k} ${T} Q${L + (R - L) * 0.55} ${T} ${R} 0 Q${L + (R - L) * 0.55} ${B} ${L + k} ${B} Q${L + k + w * 0.22} 0 ${L + k} ${T} Z`;
    if (k) d += ` M${L} ${T} Q${L + w * 0.22} 0 ${L} ${B}`;
  } else {
    d = `M${L} ${T} H${R} V${B} H${L} Z`;
  }
  let s = `<path class="cc" d="${d}"/>`;
  if (bubble) s += `<circle class="cc" cx="-3" cy="0" r="3"/>`;
  return s;
}

function enablePanZoom(svg) {
  let vb = svg.getAttribute('viewBox').split(' ').map(Number);
  const set = () => svg.setAttribute('viewBox', vb.join(' '));
  const toSvg = (e) => {
    const r = svg.getBoundingClientRect();
    const s = Math.max(vb[2] / r.width, vb[3] / r.height);
    const ox = (r.width * s - vb[2]) / 2, oy = (r.height * s - vb[3]) / 2;
    return [vb[0] - ox + (e.clientX - r.left) * s, vb[1] - oy + (e.clientY - r.top) * s, s];
  };
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [px, py] = toSvg(e);
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    vb = [px - (px - vb[0]) * f, py - (py - vb[1]) * f, vb[2] * f, vb[3] * f];
    set();
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vb: [...vb], s: toSvg(e)[2] }; svg.setPointerCapture(e.pointerId); });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    vb = [drag.vb[0] - (e.clientX - drag.x) * drag.s, drag.vb[1] - (e.clientY - drag.y) * drag.s, vb[2], vb[3]];
    set();
  });
  svg.addEventListener('pointerup', () => { drag = null; });
  svg.addEventListener('dblclick', () => { vb = svg.dataset.home.split(' ').map(Number); set(); });
  svg.dataset.home = vb.join(' ');
}

// ---------- fallback: file info, hex, strings ----------
const SPECIAL = {
  dwg: 'AutoCAD DWG is a closed format — open it in AutoCAD, DWG TrueView (free) or LibreCAD.',
  dxf: 'DXF drawing — open in LibreCAD, FreeCAD or AutoCAD.',
  step: 'STEP CAD model — open in FreeCAD or any CAD tool.', stp: 'STEP CAD model — open in FreeCAD or any CAD tool.',
  iges: 'IGES CAD model — open in FreeCAD.', igs: 'IGES CAD model — open in FreeCAD.',
  sldprt: 'SolidWorks part — needs SolidWorks or eDrawings.', sldasm: 'SolidWorks assembly — needs SolidWorks or eDrawings.',
  doc: 'Old Word .doc format — download and open in Word/LibreOffice.', ppt: 'Old PowerPoint .ppt — download to open.',
  rar: 'RAR archive — extract with 7-Zip/WinRAR.', '7z': '7-Zip archive — extract with 7-Zip.',
};
async function renderInfo(blob, host, opts) {
  const box = el('div', 'info');
  box.appendChild(el('h3', null, `No built-in viewer for .${opts.ext || '?'}`));
  box.appendChild(el('p', null, SPECIAL[opts.ext] || 'Download the file to open it in its own app. Below is what\'s inside the first bytes.'));
  const buf = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  let hex = '';
  for (let i = 0; i < Math.min(buf.length, 256); i += 16) {
    const row = buf.slice(i, i + 16);
    hex += i.toString(16).padStart(6, '0') + '  ' +
      [...row].map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(48) + '  ' +
      [...row].map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('') + '\n';
  }
  box.appendChild(el('div', 'hex', hex || '(empty file)'));
  const strings = (new TextDecoder('latin1').decode(buf).match(/[\x20-\x7e]{6,}/g) || []).slice(0, 60);
  if (strings.length) {
    box.appendChild(el('p', null, 'Readable text found in the file:'));
    box.appendChild(el('div', 'strings', strings.join('\n')));
  }
  host.appendChild(box);
  return { cleanup: () => {}, meta: '' };
}
