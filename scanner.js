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

  // Table cells that are buttons, statuses, dates or plugin widgets — never a student's name.
  const junkCell = /^(select|download|view|grade|edit|\d+|-)$|^(submitted|not submitted|no submission|graded|not graded|turned in|handed in|missing|late|on time|draft|assigned|done|needs grading|no attempt|comments?\b|feedback|similarity|originality)|turnitin|resubmit|plagiarism|ouriginal|urkund/i;
  const dateCell = /\b(19|20)\d\d\b.*\d{1,2}:\d{2}|\d{1,2}:\d{2}.*\b(19|20)\d\d\b/;

  // Try to guess who submitted the file: table row cells, a list item, or a nearby card.
  function contextFor(a, fileName) {
    const linkText = clean(a.innerText);
    // Plugins like Turnitin nest their own small table inside the file cell, so start from the
    // outermost row (the student's row) rather than the closest <tr>.
    const rows = [];
    for (let r = a.closest('tr'); r; r = r.parentElement && r.parentElement.closest('tr')) rows.push(r);
    for (const row of rows.reverse()) {
      const cells = [];
      for (const c of row.cells) {
        // Moodle's checkbox cell has a hidden label "Select <student name>"
        const t = clean(c.innerText).replace(/^select\s+(?=\S)/i, '');
        if (!t || t === linkText || t.includes(fileName) || t.length >= 60 || junkCell.test(t) || dateCell.test(t)) continue;
        // skip repeats ("Dhruvil Joshi" from the checkbox label and again from the name column)
        const k = t.toLowerCase();
        if (cells.some(x => x.toLowerCase().includes(k) || k.includes(x.toLowerCase()))) continue;
        cells.push(t);
      }
      if (cells.length) return cells.slice(0, 2).join(' · ');
    }
    let el = a.parentElement;
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
      const t = clean(el.innerText);
      if (t.length > linkText.length + 2 && t.length < 400) {
        let rest = t.replace(linkText, ' ').replace(fileName, ' ').replace(/resubmit to turnitin|turnitin|similarity:?\s*\d*%?/gi, ' ');
        rest = clean(rest).split(/ (?:Download|View|Submitted|Due|Turned in)\b/i)[0];
        if (rest.length >= 2) return rest.slice(0, 60);
      }
      if (t.length >= 400) break;
    }
    return '';
  }

  // Late status and submission time, read from the student's row (or the nearby card).
  // Moodle: "Assignment was submitted 1 day 4 hours late"; Classroom: "Turned in late" / "Done late".
  const UNIT = '(?:days?|hours?|hrs?|mins?|minutes?|secs?|seconds?|weeks?)';
  const lateExact = new RegExp(`(\\d+\\s+${UNIT}(?:,?\\s+\\d+\\s+${UNIT})*)\\s+late\\b`, 'i');
  const lateWord = /\b(turned in late|done late|submitted late|handed in late|overdue|past due)\b|(^|[\s(])late([\s).,]|$)/i;
  const dateText = /((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(\d{1,2}\s+[a-z]{3,9},?\s+\d{4}|[a-z]{3,9}\s+\d{1,2},?\s+\d{4})(,?\s+(at\s+)?\d{1,2}:\d{2}(\s*[ap]\.?m\.?)?)?/i;
  const parseDate = (s) => {
    const t = Date.parse(s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/i, '').replace(/,|\bat\b/gi, ' ').replace(/\s+/g, ' ').replace(/([ap])\.m\./i, '$1m'));
    return isNaN(t) ? null : t;
  };
  function submissionInfo(a) {
    let box = null;
    for (let r = a.closest('tr'); r; r = r.parentElement && r.parentElement.closest('tr')) box = r;
    if (!box) for (let el = a.parentElement, i = 0; el && i < 6; i++, el = el.parentElement) { if (clean(el.innerText).length > 400) break; box = el; }
    if (!box) return {};
    const text = clean(box.innerText).replace(clean(a.innerText), ' ');
    const info = {};
    const m = text.match(lateExact);
    if (m) { info.late = true; info.lateText = m[1] + ' late'; }
    else if (lateWord.test(text) && !/\bnot late\b|\bon time\b/i.test(text)) { info.late = true; info.lateText = 'Late'; }
    const d = text.match(dateText);
    if (d) { const t = parseDate(d[0]); if (t) { info.modified = t; info.modifiedText = clean(d[0]); } }
    return info;
  }

  // Site decoration (logos, icons, avatars, header/footer art) is never a submission.
  const IMG_EXTS = new Set(['png','jpg','jpeg','gif','webp','bmp','svg','ico','avif']);
  const decorRe = /logo|favicon|icon|avatar|banner|sprite|badge|emoji|spinner|loader|placeholder/i;
  const inChrome = (el) => !!el.closest('header, nav, footer, [role=banner], [role=navigation], [role=contentinfo], .navbar, .logo, .brand');
  const isDecor = (el, name, ext) => IMG_EXTS.has(ext) && (decorRe.test(name) || inChrome(el));

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
    if (isDecor(a, name, ext)) continue;
    seen.add(url);

    out.push({ url, name: name.slice(0, 140), ext, context: contextFor(a, name), guessed: !ext, ...submissionInfo(a) });
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
    if (el.tagName === 'IMG') {
      if (el.naturalWidth < 120 || el.naturalHeight < 120) continue; // skip icons
      if (isDecor(el, name + ' ' + (el.alt || '') + ' ' + (el.className || ''), ext)) continue;
    }
    seen.add(url);
    out.push({ url, name, ext, context: el.alt ? clean(el.alt).slice(0, 60) : '', guessed: false, embedded: true });
  }

  return { title: document.title, url: location.href, files: out, isTop: window === window.top };
}
