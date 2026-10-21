// Near-copy detection for Logisim .circ files.
// Each file becomes a set of weighted "features" that survive the usual ways a copy gets disguised:
// moving the whole drawing, renaming the file, changing pin labels. Two files are compared with a
// weighted Jaccard score per feature group (shared ÷ total), then the groups are blended.

const P = (s) => { const m = /\((-?\d+)\s*,\s*(-?\d+)\)/.exec(s || ''); return m ? [+m[1], +m[2]] : null; };
const SKIP_ATTRS = new Set(['label', 'labelfont', 'labelloc', 'labelcolor', 'font', 'color', 'offcolor', 'text', 'tunnelname']);

// Feature groups and how much each counts towards the final score.
const GROUPS = {
  layout: 0.35,  // component type at its position relative to the drawing's top-left (catches moved copies)
  wires: 0.25,   // wire segments as direction + length (translation-proof)
  parts: 0.2,    // component type + settings (bit width, inputs, size…)
  labels: 0.1,   // pin / tunnel / text labels, lower-cased
  names: 0.1,    // subcircuit names
};

export function circuitFeatures(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const f = Object.fromEntries(Object.keys(GROUPS).map(k => [k, new Map()]));
  const add = (g, key, n = 1) => f[g].set(key, (f[g].get(key) || 0) + n);
  let comps = 0, wires = 0;

  for (const circ of doc.querySelectorAll('project > circuit')) {
    const cname = (circ.getAttribute('name') || '').toLowerCase();
    if (cname && cname !== 'main') add('names', cname);
    const items = [];
    for (const c of circ.querySelectorAll(':scope > comp')) {
      const loc = P(c.getAttribute('loc'));
      if (!loc) continue;
      const name = c.getAttribute('name') || '?';
      const attrs = [...c.querySelectorAll(':scope > a')]
        .filter(a => !SKIP_ATTRS.has(a.getAttribute('name')))
        .map(a => `${a.getAttribute('name')}=${a.getAttribute('val') ?? a.textContent}`).sort().join(',');
      items.push({ name, loc, attrs });
      const label = c.querySelector(':scope > a[name="label"]')?.getAttribute('val') || (name === 'Text' ? c.querySelector(':scope > a[name="text"]')?.getAttribute('val') : '');
      if (label) add('labels', label.trim().toLowerCase());
      comps++;
    }
    const ws = [...circ.querySelectorAll(':scope > wire')].map(w => [P(w.getAttribute('from')), P(w.getAttribute('to'))]).filter(w => w[0] && w[1]);
    wires += ws.length;
    const allPts = [...items.map(i => i.loc), ...ws.flat()];
    const minX = allPts.length ? Math.min(...allPts.map(p => p[0])) : 0;
    const minY = allPts.length ? Math.min(...allPts.map(p => p[1])) : 0;
    for (const it of items) {
      add('parts', `${cname}|${it.name}|${it.attrs}`);
      add('layout', `${cname}|${it.name}@${it.loc[0] - minX},${it.loc[1] - minY}`);
    }
    for (const [a, b] of ws) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      add('wires', `${cname}|${dx < 0 || (dx === 0 && dy < 0) ? `${-dx},${-dy}` : `${dx},${dy}`}`); // direction-agnostic
      add('layout', `${cname}|w@${Math.min(a[0], b[0]) - minX},${Math.min(a[1], b[1]) - minY},${Math.abs(dx)},${Math.abs(dy)}`, 0.5);
    }
  }
  return { f, comps, wires };
}

const jaccard = (a, b) => {
  if (!a.size && !b.size) return null;
  let inter = 0, union = 0;
  for (const [k, v] of a) { const w = b.get(k) || 0; inter += Math.min(v, w); union += Math.max(v, w); }
  for (const [k, w] of b) if (!a.has(k)) union += w;
  return union ? inter / union : 0;
};

// 0..1, plus the per-group breakdown so the UI can explain the score.
export function circuitSimilarity(A, B) {
  let sum = 0, wsum = 0;
  const parts = {};
  for (const [g, w] of Object.entries(GROUPS)) {
    const s = jaccard(A.f[g], B.f[g]);
    if (s == null) continue;
    parts[g] = s; sum += s * w; wsum += w;
  }
  return { score: wsum ? sum / wsum : 0, parts };
}
