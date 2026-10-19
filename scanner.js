// This function is injected into the page (every frame) by the popup.
// It must be fully self-contained: it is serialised and run in the page.
function ggScanPage(knownExts, includeAll) {
  const known = new Set(knownExts);
  const extRe = /\.([a-z0-9_]{1,10})$/i;
  const out = [];
  const seen = new Set();

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const extOf = (s) => {
    const m = clean(s).match(extRe);
    return m ? m[1].toLowerCase() : '';
  };
  const lastSeg = (u) => {
    try {
      const p = new URL(u).pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(p);
    } catch { return ''; }
  };

  // Try to guess who submitted the file: table row cells, a list item, or a nearby card.
  function contextFor(a, fileName) {
    const linkText = clean(a.innerText);
    const row = a.closest('tr');
    if (row) {
      const cells = [...row.cells]
        .map(c => clean(c.innerText))
        .filter(t => t && t !== linkText && !t.includes(fileName) && t.length < 60 && !/^(select|download|view|grade|edit|\d+)$/i.test(t) && !/^(submitted|not submitted|no submission|graded|not graded|turned in|handed in|missing|late|on time|draft|assigned|done|needs grading)\b/i.test(t));
      if (cells.length) return cells.slice(0, 2).join(' · ');
    }
    let el = a.parentElement;
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
      const t = clean(el.innerText);
      if (t.length > linkText.length + 2 && t.length < 400) {
        let rest = t.replace(linkText, ' ').replace(fileName, ' ');
        rest = clean(rest).split(/ (?:Download|View|Submitted|Due|Turned in)\b/i)[0];
        if (rest.length >= 2) return rest.slice(0, 60);
      }
      if (t.length >= 400) break;
    }
    return '';
  }

  const anchors = document.querySelectorAll('a[href]');
  for (const a of anchors) {
    const raw = a.getAttribute('href') || '';
    if (/^(javascript:|mailto:|tel:|#)/i.test(raw)) continue;
    let url = a.href;
    if (!/^(https?|blob|data):/i.test(url)) continue;

    let params = {};
    try { params = Object.fromEntries(new URL(url).searchParams); } catch {}

    const candidates = [
      a.getAttribute('download'),
      clean(a.innerText),
      a.getAttribute('title'),
      a.getAttribute('aria-label'),
      lastSeg(url),
      params.filename, params.file, params.name, params.f,
    ].filter(Boolean);

    let name = '', ext = '';
    for (const c of candidates) {
      const e = extOf(c);
      if (e && known.has(e)) { name = clean(c).split(/[\\/]/).pop(); ext = e; break; }
    }

    // Google Drive / Classroom attachments → direct download URL
    const drive = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:.*&)?id=)([\w-]{10,})/);
    if (drive) {
      url = 'https://drive.google.com/uc?export=download&id=' + drive[1];
      if (!name) name = clean(a.innerText) || clean(a.getAttribute('aria-label')) || ('drive-file-' + drive[1].slice(0, 6));
    }

    // Moodle style pluginfile links always point at a file
    const looksLikeFile = /pluginfile\.php|forcedownload=1|\/download\b|attachment/i.test(url);

    if (!name && !drive) {
      if (!includeAll && !looksLikeFile) continue;
      name = lastSeg(url) || clean(a.innerText) || url;
      ext = extOf(name);
    }
    if (seen.has(url)) continue;
    seen.add(url);

    out.push({ url, name: name.slice(0, 140), ext, context: contextFor(a, name), guessed: !ext });
  }

  // Embedded audio / video players on the page (even when the URL has no extension)
  let mediaN = 0;
  for (const m of document.querySelectorAll('video, audio')) {
    const srcs = [m.currentSrc, m.getAttribute('src') && m.src, ...[...m.querySelectorAll('source[src]')].map(s => s.src)].filter(Boolean);
    const url = srcs.find(u => /^https?:/i.test(u));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const kind = m.tagName === 'VIDEO' ? 'video' : 'audio';
    const seg = lastSeg(url);
    const ext = extOf(seg);
    const name = (ext && known.has(ext)) ? seg : `${kind}-${++mediaN}${seg ? ' (' + seg.slice(0, 40) + ')' : ''}`;
    out.push({ url, name, ext: (ext && known.has(ext)) ? ext : '', kindHint: kind, context: contextFor(m, name), guessed: false, embedded: true });
  }

  // Other embedded documents / large images on the page itself
  for (const el of document.querySelectorAll('img[src], embed[src], object[data], iframe[src]')) {
    const url = el.src || el.data;
    if (!url || seen.has(url) || !/^https?:/i.test(url)) continue;
    const name = lastSeg(url);
    const ext = extOf(name);
    if (!ext || !known.has(ext)) continue;
    if (el.tagName === 'IMG' && (el.naturalWidth < 120 || el.naturalHeight < 120)) continue; // skip icons
    seen.add(url);
    out.push({ url, name, ext, context: '', guessed: false, embedded: true });
  }

  return { title: document.title, url: location.href, files: out, isTop: window === window.top };
}
