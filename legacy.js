// Previews for old binary Office files (Word 97–2003 .doc, PowerPoint 97–2003 .ppt).
// Both are "Compound File Binary" containers (a small FAT file system inside one file).
// We read the container, then pull out the text (and, for .ppt, the pictures).
// This is a text-first preview: layout and formatting are not reproduced.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const END = 0xfffffffe, FREE = 0xffffffff;

export const isCfb = (b) => b.length >= 8 && u32(b, 0) === 0xe011cfd0 && u32(b, 4) === 0xe11ab1a1;

// ---------- Compound File Binary reader ----------
// Returns Map<streamName, Uint8Array> (storage hierarchy is flattened; names are unique in .doc/.ppt).
export function readCfb(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (!isCfb(b)) throw new Error('Not an Office 97–2003 file.');
  const secSize = 1 << u16(b, 30), miniSize = 1 << u16(b, 32);
  const cutoff = u32(b, 56) || 4096;
  const sec = (n) => b.subarray((n + 1) * secSize, (n + 2) * secSize);

  // FAT sectors are listed in the header DIFAT (109 entries) and then in a DIFAT chain.
  const fatSecs = [];
  for (let i = 0; i < 109; i++) { const v = u32(b, 76 + i * 4); if (v < 0xfffffffa) fatSecs.push(v); }
  for (let d = u32(b, 68), guard = 0; d < 0xfffffffa && guard++ < 10000;) {
    const s = sec(d), per = secSize / 4 - 1;
    for (let i = 0; i < per; i++) { const v = u32(s, i * 4); if (v < 0xfffffffa) fatSecs.push(v); }
    d = u32(s, per * 4);
  }
  const fat = new Uint32Array(fatSecs.length * secSize / 4);
  fatSecs.forEach((n, i) => { const s = sec(n); for (let j = 0; j < secSize / 4; j++) fat[i * secSize / 4 + j] = u32(s, j * 4); });

  const chain = (start, table) => {
    const out = [], seen = new Set();
    for (let n = start; n !== END && n !== FREE && n < table.length && !seen.has(n); n = table[n]) { seen.add(n); out.push(n); }
    return out;
  };
  const readBig = (start, size) => {
    const ns = chain(start, fat), out = new Uint8Array(ns.length * secSize);
    ns.forEach((n, i) => out.set(sec(n), i * secSize));
    return size != null ? out.subarray(0, Math.min(size, out.length)) : out;
  };

  const dir = readBig(u32(b, 48));
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = u16(dir, o + 64), type = dir[o + 66];
    if (!type || nameLen < 2) continue;
    let name = '';
    for (let i = 0; i < nameLen - 2; i += 2) name += String.fromCharCode(u16(dir, o + i));
    entries.push({ name, type, start: u32(dir, o + 116), size: u32(dir, o + 120) });
  }
  const root = entries.find(e => e.type === 5);
  const miniStream = root ? readBig(root.start, root.size) : new Uint8Array(0);
  const miniFatRaw = u32(b, 60) < 0xfffffffa ? readBig(u32(b, 60)) : new Uint8Array(0);
  const miniFat = new Uint32Array(miniFatRaw.length / 4);
  for (let i = 0; i < miniFat.length; i++) miniFat[i] = u32(miniFatRaw, i * 4);

  const streams = new Map();
  for (const e of entries) {
    if (e.type !== 2) continue;
    if (e.size < cutoff) {
      const ns = chain(e.start, miniFat), out = new Uint8Array(ns.length * miniSize);
      ns.forEach((n, i) => out.set(miniStream.subarray(n * miniSize, (n + 1) * miniSize), i * miniSize));
      streams.set(e.name, out.subarray(0, e.size));
    } else streams.set(e.name, readBig(e.start, e.size));
  }
  return streams;
}

// ---------- Word 97–2003 (.doc) ----------
// Text lives in the WordDocument stream; the piece table (CLX) in the 0Table/1Table stream says where.
const CP1252 = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ' };

export function docText(buf) {
  const st = readCfb(buf);
  const wd = st.get('WordDocument');
  if (!wd || u16(wd, 0) !== 0xa5ec) throw new Error('This .doc file has no Word 97–2003 document inside (it may be Word 6/95 or another format).');
  const flags = u16(wd, 0x0a);
  if (flags & 0x0100) throw new Error('This Word file is password-protected.');
  const table = st.get(flags & 0x0200 ? '1Table' : '0Table');
  if (!table) throw new Error('This .doc file is damaged (no table stream).');

  // FibBase (32) → csw → FibRgW → cslw → FibRgLw → cbRgFcLcb → FibRgFcLcb; fcClx/lcbClx is pair #33.
  const csw = u16(wd, 32);
  const cslwAt = 34 + csw * 2;
  const cslw = u16(wd, cslwAt);
  const rg = cslwAt + 2 + cslw * 4 + 2;
  const fcClx = u32(wd, rg + 33 * 8), lcbClx = u32(wd, rg + 33 * 8 + 4);
  if (!lcbClx) throw new Error('This .doc file has no text table.');

  let o = fcClx;
  while (table[o] === 0x01) o += 3 + u16(table, o + 1); // skip Prc (formatting) blocks
  if (table[o] !== 0x02) throw new Error('Could not find the text in this .doc file.');
  const lcb = u32(table, o + 1), plc = o + 5;
  const n = (lcb - 4) / 12;
  let text = '';
  for (let i = 0; i < n; i++) {
    const cpStart = u32(table, plc + i * 4), cpEnd = u32(table, plc + (i + 1) * 4);
    const pcd = plc + (n + 1) * 4 + i * 8;
    const fcRaw = u32(table, pcd + 2);
    const compressed = (fcRaw & 0x40000000) !== 0;
    const fc = fcRaw & 0x3fffffff;
    const len = cpEnd - cpStart;
    if (compressed) {
      const start = fc / 2;
      for (let k = 0; k < len; k++) { const c = wd[start + k]; text += CP1252[c] || String.fromCharCode(c); }
    } else {
      for (let k = 0; k < len; k++) text += String.fromCharCode(u16(wd, fc + k * 2));
    }
  }
  return cleanWordText(text);
}

function cleanWordText(t) {
  // Fields: \x13 instruction \x14 result \x15 → keep only the result.
  let out = '', depth = 0, inInstr = [];
  for (const ch of t) {
    if (ch === '\x13') { depth++; inInstr.push(true); continue; }
    if (ch === '\x14') { if (depth) inInstr[depth - 1] = false; continue; }
    if (ch === '\x15') { if (depth) { depth--; inInstr.pop(); } continue; }
    if (inInstr.some(Boolean)) continue;
    out += ch;
  }
  return out
    .replace(/\x07\x07/g, '\n')     // last cell mark + row mark = end of table row
    .replace(/\r\x07/g, '\n')
    .replace(/\x07/g, '\t')         // end of table cell
    .replace(/[\r\x0b\x0c\x0e]/g, '\n')
    .replace(/[\x00-\x08\x0f-\x1f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Very old "Word" files are sometimes really RTF. Strip it down to readable text.
export function rtfText(s) {
  return s
    .replace(/\\par[d]?\b ?/g, '\n').replace(/\\line\b ?/g, '\n').replace(/\\tab\b ?/g, '\t')
    .replace(/\{\\\*[^{}]*\}/g, '').replace(/\{\\(fonttbl|colortbl|stylesheet|info)[\s\S]*?\}\s*\}/g, '')
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => CP1252[parseInt(h, 16)] || String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(n < 0 ? 65536 + +n : +n))
    .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- PowerPoint 97–2003 (.ppt) ----------
// "PowerPoint Document" is a tree of records. Slide text sits in SlideListWithText (instance 0),
// one SlidePersistAtom per slide followed by its text atoms. Pictures are in the "Pictures" stream.
export function pptContent(buf) {
  const st = readCfb(buf);
  const doc = st.get('PowerPoint Document');
  if (!doc) throw new Error('This .ppt file has no PowerPoint 97–2003 presentation inside.');
  if (st.has('EncryptedSummary')) throw new Error('This PowerPoint file is password-protected.');

  const fromList = [], fromSlides = [];
  let cur = null, slideCur = null;
  const atomText = (type, o, len) => {
    if (type === 0x0fa0) { let s = ''; for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(u16(doc, o + k)); return s; }
    let s = ''; for (let k = 0; k < len; k++) s += CP1252[doc[o + k]] || String.fromCharCode(doc[o + k]); return s;
  };
  const walk = (start, end, ctx) => {
    for (let o = start; o + 8 <= end;) {
      const vi = u16(doc, o), type = u16(doc, o + 2), len = u32(doc, o + 4);
      const ver = vi & 0xf, inst = vi >> 4, body = o + 8;
      if (body + len > end) break;
      if (type === 0x0ff0) { // SlideListWithText
        if (inst === 0) { walk(body, body + len, 'list'); cur = null; }
      } else if (type === 0x03ee) { // Slide container
        slideCur = []; fromSlides.push(slideCur); walk(body, body + len, 'slide'); slideCur = null;
      } else if (ctx === 'list' && type === 0x03f3) { // SlidePersistAtom
        cur = []; fromList.push(cur);
      } else if (type === 0x0fa0 || type === 0x0fa8) {
        const t = atomText(type, body, len).replace(/\r/g, '\n').replace(/\x0b/g, '\n').trim();
        if (t && t !== '*') { if (ctx === 'list' && cur) cur.push(t); else if (ctx === 'slide' && slideCur) slideCur.push(t); }
      } else if (ver === 0xf) {
        walk(body, body + len, ctx);
      }
      o = body + len;
    }
  };
  walk(0, doc.length, null);
  const slides = fromList.some(s => s.length) ? fromList : fromSlides.filter(s => s.length);

  // Pictures: OfficeArtBlip records. Bitmap blips have 1 or 2 16-byte UIDs and a 1-byte tag before the data.
  const pics = [];
  const pic = st.get('Pictures');
  if (pic) {
    for (let o = 0; o + 8 <= pic.length && pics.length < 24;) {
      const vi = u16(pic, o), type = u16(pic, o + 2), len = u32(pic, o + 4), inst = vi >> 4, body = o + 8;
      if (len <= 0 || body + len > pic.length) break;
      const mime = { 0xf01d: 'image/jpeg', 0xf02a: 'image/jpeg', 0xf01e: 'image/png', 0xf029: 'image/tiff' }[type];
      if (mime && mime !== 'image/tiff') {
        const skip = 16 * ((inst & 1) ? 2 : 1) + 1;
        pics.push(new Blob([pic.slice(body + skip, body + len)], { type: mime }));
      }
      o = body + len;
    }
  }
  return { slides, pics };
}
