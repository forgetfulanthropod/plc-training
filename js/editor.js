// Ladder editor: SVG rendering, selection, editing operations and live highlighting.
import { normalizeSeries, pathKey, COMPARE_TYPES, MATH_TYPES } from './ladder.js';

const NS = 'http://www.w3.org/2000/svg';
const CW = 104;   // contact cell width
const RH = 66;    // row height
const BP = 16;    // branch padding
const LEFT = 44;  // x of left power rail
const OUTW = 190; // output column width
const HEAD = 24;  // rung comment header height
const CMPW = 150; // compare block width

function el(tag, attrs = {}, parent = null, text = null) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  if (text !== null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export function measureSeries(series) {
  let w = 0, h = 1;
  for (const it of series) {
    const m = measureItem(it);
    w += m.w;
    h = Math.max(h, m.h);
  }
  return { w, h };
}

export function measureItem(it) {
  if (COMPARE_TYPES.includes(it.type)) return { w: CMPW, h: 1 };
  if (it.type !== 'BRANCH') return { w: CW, h: 1 };
  let w = 0, h = 0;
  for (const leg of it.legs) {
    const m = measureSeries(leg);
    w = Math.max(w, m.w);
    h += m.h;
  }
  return { w: w + 2 * BP, h };
}

// ------------------------------------------------------------------ path helpers
export function seriesAt(rung, prefix) {
  let s = rung.logic;
  for (let i = 0; i < prefix.length; i += 2) s = s[prefix[i]].legs[prefix[i + 1]];
  return s;
}
const itemAt = (rung, path) => seriesAt(rung, path.slice(0, -1))[path[path.length - 1]];

export function nextName(program, prefix) {
  const used = new Set();
  for (const r of program.rungs) for (const o of r.outputs) used.add(o.tag);
  let n = 1;
  while (used.has(prefix + n)) n++;
  return prefix + n;
}

// ------------------------------------------------------------------ edit operations
// Selection: { r, kind: 'rung'|'item'|'branch'|'leg'|'out', path?, o? }
export const ops = {
  addRung(program, sel) {
    const at = sel ? sel.r + 1 : program.rungs.length;
    program.rungs.splice(at, 0, { comment: '', logic: [], outputs: [] });
    return { r: at, kind: 'rung' };
  },

  moveRung(program, sel, dir) {
    if (!sel) return sel;
    const to = sel.r + dir;
    if (to < 0 || to >= program.rungs.length) return sel;
    const [r] = program.rungs.splice(sel.r, 1);
    program.rungs.splice(to, 0, r);
    return { r: to, kind: 'rung' };
  },

  insertContact(program, sel, type = 'NO', tag = 'NEW_BIT') {
    return ops.insertItem(program, sel, { type, tag });
  },

  /** Insert an input instruction (contact or compare) after the selection. */
  insertItem(program, sel, c) {
    if (!program.rungs.length) { program.rungs.push({ comment: '', logic: [], outputs: [] }); sel = { r: 0, kind: 'rung' }; }
    if (!sel) sel = { r: program.rungs.length - 1, kind: 'rung' };
    const rung = program.rungs[sel.r];
    if (sel.kind === 'item' || sel.kind === 'branch') {
      const s = seriesAt(rung, sel.path.slice(0, -1));
      const idx = sel.path[sel.path.length - 1] + 1;
      s.splice(idx, 0, c);
      return { r: sel.r, kind: 'item', path: [...sel.path.slice(0, -1), idx] };
    }
    if (sel.kind === 'leg') {
      const s = seriesAt(rung, sel.path);
      s.push(c);
      return { r: sel.r, kind: 'item', path: [...sel.path, s.length - 1] };
    }
    rung.logic.push(c);
    return { r: sel.r, kind: 'item', path: [rung.logic.length - 1] };
  },

  /** Add a parallel branch around the selection (or another leg to a selected branch). */
  addBranch(program, sel, tag = 'NEW_BIT') {
    if (!sel) return sel;
    const rung = program.rungs[sel.r];
    const c = { type: 'NO', tag };
    if (sel.kind === 'item' || sel.kind === 'branch') {
      const s = seriesAt(rung, sel.path.slice(0, -1));
      const idx = sel.path[sel.path.length - 1];
      const it = s[idx];
      if (it.type === 'BRANCH') {
        it.legs.push([c]);
        return { r: sel.r, kind: 'item', path: [...sel.path, it.legs.length - 1, 0] };
      }
      s[idx] = { type: 'BRANCH', legs: [[it], [c]] };
      return { r: sel.r, kind: 'item', path: [...sel.path, 1, 0] };
    }
    if (sel.kind === 'leg') {
      return ops.addBranch(program, { r: sel.r, kind: 'branch', path: sel.path.slice(0, -1) }, tag);
    }
    // whole rung
    if (!rung.logic.length) return ops.insertContact(program, sel, 'NO', tag);
    rung.logic = [{ type: 'BRANCH', legs: [rung.logic, [c]] }];
    return { r: sel.r, kind: 'item', path: [0, 1, 0] };
  },

  addOutput(program, sel, type, extra = {}) {
    if (!program.rungs.length) program.rungs.push({ comment: '', logic: [], outputs: [] });
    const r = sel ? sel.r : program.rungs.length - 1;
    const rung = program.rungs[r];
    let o;
    if (type === 'TON') o = { type, tag: nextName(program, 'T'), preset: 2000 };
    else if (type === 'CTU') o = { type, tag: nextName(program, 'C'), preset: 5 };
    else if (type === 'RES') {
      const tc = program.rungs.flatMap((x) => x.outputs).find((x) => x.type === 'TON' || x.type === 'CTU');
      o = { type, tag: tc ? tc.tag : 'C1' };
    } else if (type === 'MOV') o = { type, src: '0', dest: 'NEW_DINT' };
    else if (MATH_TYPES.includes(type)) o = { type, a: '0', b: '1', dest: 'NEW_DINT' };
    else if (type === 'JSR') o = { type, routine: extra.routine || 'Subroutine' };
    else if (type === 'AOI') o = { type, aoi: extra.aoi || 'MyAOI', tag: extra.tag || 'AOI_1', args: {} };
    else o = { type, tag: 'NEW_COIL' };
    rung.outputs.push(o);
    return { r, kind: 'out', o: rung.outputs.length - 1 };
  },

  remove(program, sel) {
    if (!sel) return null;
    const rung = program.rungs[sel.r];
    if (sel.kind === 'rung') {
      program.rungs.splice(sel.r, 1);
      if (!program.rungs.length) program.rungs.push({ comment: '', logic: [], outputs: [] });
      return { r: Math.min(sel.r, program.rungs.length - 1), kind: 'rung' };
    }
    if (sel.kind === 'out') {
      rung.outputs.splice(sel.o, 1);
    } else if (sel.kind === 'item' || sel.kind === 'branch') {
      seriesAt(rung, sel.path.slice(0, -1)).splice(sel.path[sel.path.length - 1], 1);
    } else if (sel.kind === 'leg') {
      const br = itemAt(rung, sel.path.slice(0, -1));
      br.legs.splice(sel.path[sel.path.length - 1], 1);
    }
    normalizeSeries(rung.logic);
    return { r: sel.r, kind: 'rung' };
  },

  getSelected(program, sel) {
    if (!sel || !program.rungs[sel.r]) return null;
    const rung = program.rungs[sel.r];
    try {
      if (sel.kind === 'rung') return rung;
      if (sel.kind === 'out') return rung.outputs[sel.o];
      if (sel.kind === 'item' || sel.kind === 'branch') return itemAt(rung, sel.path);
      if (sel.kind === 'leg') return seriesAt(rung, sel.path);
    } catch { return null; }
    return null;
  },
};

const selKey = (s) => (s ? `${s.r}|${s.kind}|${s.path ? s.path.join('.') : ''}|${s.o ?? ''}` : '');

// ------------------------------------------------------------------ rendering
const fmtVal = (v) => {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (v === undefined) return '?';
  return '{…}';
};

export class LadderView {
  constructor(container, onSelect) {
    this.container = container;
    this.onSelect = onSelect;
    this.sel = null;
    this.svg = null;
    this.aois = {};
  }

  outRows(o) {
    if (o.type !== 'AOI') return 1;
    const def = this.aois[o.aoi];
    const n = def ? def.params.length : Object.keys(o.args || {}).length;
    return Math.max(1, Math.ceil((34 + 13 * n) / RH));
  }

  /** opts: { aois: { name: def } } */
  render(program, sel, opts = {}) {
    this.sel = sel;
    this.aois = opts.aois || {};
    const sizes = program.rungs.map((r) => measureSeries(r.logic));
    const contentW = Math.max(2 * CW, ...sizes.map((s) => s.w));
    const J = LEFT + contentW + 24;
    const RR = J + OUTW;
    let total = 10;
    const heights = program.rungs.map((r, i) => {
      const outRows = r.outputs.reduce((a, o) => a + this.outRows(o), 0);
      const h = HEAD + Math.max(sizes[i].h, outRows, 1) * RH + 6;
      total += h;
      return h;
    });
    const width = RR + 16;
    const svg = el('svg', { width, height: total + 10, viewBox: `0 0 ${width} ${total + 10}`, class: 'ladder' });
    this.svg = svg;

    el('line', { x1: LEFT, y1: 6, x2: LEFT, y2: total + 4, class: 'rail' }, svg);
    el('line', { x1: RR, y1: 6, x2: RR, y2: total + 4, class: 'rail' }, svg);

    let y = 10;
    program.rungs.forEach((rung, r) => {
      const h = heights[r];
      const g = el('g', { class: 'rung', 'data-r': r, id: `rung-${r}` }, svg);
      const bg = el('rect', { x: 0, y, width, height: h - 4, class: 'rung-bg' + (sel && sel.r === r && sel.kind === 'rung' ? ' sel' : ''), rx: 6 }, g);
      this.hit(bg, { r, kind: 'rung' });
      el('text', { x: 8, y: y + HEAD + RH / 2 + 5, class: 'rung-num' }, g, String(r).padStart(3, '0'));
      el('text', { x: LEFT + 8, y: y + 16, class: 'rung-comment' }, g, rung.comment ? `// ${rung.comment}` : '');

      const ry = y + HEAD;
      const cy = ry + RH / 2;
      const end = this.drawSeries(g, rung.logic, LEFT, ry, r, []);
      el('line', { x1: end, y1: cy, x2: J, y2: cy, class: 'wire', 'data-r': r, 'data-p': 'rung' }, g);

      const outs = rung.outputs;
      let oy = ry;
      let lastCy = cy;
      outs.forEach((o, k) => {
        lastCy = oy + RH / 2;
        this.drawOutput(g, o, J, RR, oy, r, k);
        oy += this.outRows(o) * RH;
      });
      if (outs.length > 1) el('line', { x1: J, y1: cy, x2: J, y2: lastCy, class: 'wire', 'data-r': r, 'data-p': 'rung' }, g);
      if (!outs.length) el('line', { x1: J, y1: cy, x2: RR, y2: cy, class: 'wire dim' }, g);
      y += h;
    });

    this.container.replaceChildren(svg);
  }

  hit(node, sel) {
    node.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      this.onSelect(sel);
    });
    if (selKey(sel) === selKey(this.sel)) node.classList.add('sel');
  }

  drawSeries(g, series, x, y, r, path) {
    let cx = x;
    series.forEach((it, i) => {
      const ip = [...path, i];
      if (it.type === 'BRANCH') this.drawBranch(g, it, cx, y, r, ip);
      else if (COMPARE_TYPES.includes(it.type)) this.drawCompare(g, it, cx, y, r, ip);
      else this.drawContact(g, it, cx, y, r, ip);
      cx += measureItem(it).w;
    });
    return cx;
  }

  drawContact(g, it, x, y, r, path) {
    const k = pathKey(path);
    const cy = y + RH / 2;
    const cg = el('g', { class: 'contact', 'data-r': r, 'data-k': k }, g);
    const hit = el('rect', { x: x + 4, y: y + 4, width: CW - 8, height: RH - 8, class: 'hit', rx: 4 }, cg);
    this.hit(hit, { r, kind: 'item', path });
    el('line', { x1: x, y1: cy, x2: x + 38, y2: cy, class: 'wire', 'data-r': r, 'data-k': k, 'data-p': 'in' }, cg);
    el('rect', { x: x + 40, y: cy - 13, width: 24, height: 26, class: 'cfill' }, cg);
    el('line', { x1: x + 40, y1: cy - 15, x2: x + 40, y2: cy + 15, class: 'sym' }, cg);
    el('line', { x1: x + 64, y1: cy - 15, x2: x + 64, y2: cy + 15, class: 'sym' }, cg);
    if (it.type === 'NC') el('line', { x1: x + 36, y1: cy + 14, x2: x + 68, y2: cy - 14, class: 'sym' }, cg);
    el('line', { x1: x + 66, y1: cy, x2: x + CW, y2: cy, class: 'wire', 'data-r': r, 'data-k': k, 'data-p': 'out' }, cg);
    el('text', { x: x + 52, y: cy - 20, class: 'tag' }, cg, it.tag);
    el('text', { x: x + 52, y: cy + 28, class: 'kind', 'data-ref': it.tag, 'data-label': it.type === 'NC' ? 'XIO' : 'XIC', 'data-short': '1' }, cg, it.type === 'NC' ? 'XIO' : 'XIC');
  }

  drawCompare(g, it, x, y, r, path) {
    const k = pathKey(path);
    const cy = y + RH / 2;
    const cg = el('g', { class: 'contact compare', 'data-r': r, 'data-k': k }, g);
    const hit = el('rect', { x: x + 4, y: y + 2, width: CMPW - 8, height: RH - 4, class: 'hit', rx: 4 }, cg);
    this.hit(hit, { r, kind: 'item', path });
    el('line', { x1: x, y1: cy, x2: x + 10, y2: cy, class: 'wire', 'data-r': r, 'data-k': k, 'data-p': 'in' }, cg);
    el('rect', { x: x + 10, y: cy - 27, width: CMPW - 20, height: 54, class: 'block cfillb', rx: 3 }, cg);
    el('text', { x: x + 16, y: cy - 13, class: 'block-title' }, cg, it.type);
    el('text', { x: x + 16, y: cy + 2, class: 'block-text', 'data-ref': it.a, 'data-label': 'A ' }, cg, `A ${it.a}`);
    el('text', { x: x + 16, y: cy + 17, class: 'block-text', 'data-ref': it.b, 'data-label': 'B ' }, cg, `B ${it.b}`);
    el('line', { x1: x + CMPW - 10, y1: cy, x2: x + CMPW, y2: cy, class: 'wire', 'data-r': r, 'data-k': k, 'data-p': 'out' }, cg);
  }

  drawBranch(g, it, x, y, r, path) {
    const k = pathKey(path);
    const m = measureItem(it);
    let ly = y;
    let lastCy = y + RH / 2;
    it.legs.forEach((leg, l) => {
      const lp = [...path, l];
      const lk = pathKey(lp);
      const lcy = ly + RH / 2;
      el('line', { x1: x, y1: lcy, x2: x + BP, y2: lcy, class: 'wire', 'data-r': r, 'data-k': k, 'data-p': 'in' }, g);
      const end = this.drawSeries(g, leg, x + BP, ly, r, lp);
      el('line', { x1: end, y1: lcy, x2: x + m.w, y2: lcy, class: 'wire', 'data-r': r, 'data-k': lk, 'data-p': 'out' }, g);
      const legHit = el('rect', { x: end, y: lcy - 8, width: Math.max(10, x + m.w - end), height: 16, class: 'hit' }, g);
      this.hit(legHit, { r, kind: 'leg', path: lp });
      lastCy = lcy;
      ly += measureSeries(leg).h * RH;
    });
    const top = y + RH / 2;
    el('line', { x1: x, y1: top, x2: x, y2: lastCy, class: 'wire', 'data-r': r, 'data-k': k, 'data-p': 'in' }, g);
    el('line', { x1: x + m.w, y1: top, x2: x + m.w, y2: lastCy, class: 'wire', 'data-r': r, 'data-k': k, 'data-p': 'out' }, g);
    for (const bx of [x, x + m.w]) {
      const h = el('rect', { x: bx - 6, y: top, width: 12, height: lastCy - top, class: 'hit' }, g);
      this.hit(h, { r, kind: 'branch', path });
    }
  }

  drawOutput(g, o, J, RR, y, r, k) {
    const cy = y + RH / 2;
    const rows = this.outRows(o);
    const og = el('g', { class: 'output', 'data-r': r, 'data-o': k }, g);
    const hit = el('rect', { x: J + 8, y: y + 2, width: RR - J - 16, height: rows * RH - 4, class: 'hit', rx: 4 }, og);
    this.hit(hit, { r, kind: 'out', o: k });
    const mid = (J + RR) / 2;
    const isCoil = ['OTE', 'OTL', 'OTU', 'RES'].includes(o.type);
    const half = isCoil ? (o.type === 'RES' ? 22 : 16) : 70;
    el('line', { x1: J, y1: cy, x2: mid - half, y2: cy, class: 'wire', 'data-r': r, 'data-p': 'rung' }, og);
    el('line', { x1: mid + half, y1: cy, x2: RR, y2: cy, class: 'wire', 'data-r': r, 'data-p': 'rung' }, og);
    if (isCoil) {
      el('path', { d: `M ${mid - half + 6} ${cy - 15} Q ${mid - half - 4} ${cy} ${mid - half + 6} ${cy + 15}`, class: 'sym coil' }, og);
      el('path', { d: `M ${mid + half - 6} ${cy - 15} Q ${mid + half + 4} ${cy} ${mid + half - 6} ${cy + 15}`, class: 'sym coil' }, og);
      const letter = { OTL: 'L', OTU: 'U', RES: 'RES', OTE: '' }[o.type];
      if (letter) el('text', { x: mid, y: cy + 5, class: 'coil-letter' }, og, letter);
      el('text', { x: mid, y: cy - 20, class: 'tag' }, og, o.tag);
      el('text', { x: mid, y: cy + 28, class: 'kind', 'data-ref': o.type === 'RES' ? null : o.tag, 'data-label': o.type, 'data-short': '1' }, og, o.type);
      return;
    }
    const bx = mid - half;
    const bh = rows * RH - 12;
    el('rect', { x: bx, y: cy - 27, width: half * 2, height: bh, class: 'block', rx: 3 }, og);
    const line = (i, txt, ref, label, cls = 'block-text', short = null) => el('text', { x: bx + 6, y: cy - 13 + i * 15, class: cls, 'data-ref': ref, 'data-label': label, 'data-short': short }, og, txt);
    if (o.type === 'TON' || o.type === 'CTU') {
      line(0, `${o.type} ${o.tag}`, null, null, 'block-title');
      line(1, `PRE ${o.preset}${o.type === 'TON' ? ' ms' : ''}`, null, null);
      line(2, 'ACC', `${o.tag}.ACC`, 'ACC', 'block-text', '1');
      el('text', { x: bx + half * 2 - 4, y: cy - 13, class: 'block-flags', 'data-flags': o.type, 'data-tag': o.tag }, og, '');
    } else if (o.type === 'MOV') {
      line(0, 'MOV', null, null, 'block-title');
      line(1, `Src ${o.src}`, o.src, 'Src ');
      line(2, `Dest ${o.dest}`, o.dest, 'Dest ');
    } else if (MATH_TYPES.includes(o.type)) {
      line(0, `${o.type}  Dest ${o.dest}`, o.dest, `${o.type}  Dest `, 'block-title');
      line(1, `A ${o.a}`, o.a, 'A ');
      line(2, `B ${o.b}`, o.b, 'B ');
    } else if (o.type === 'JSR') {
      line(0, 'JSR', null, null, 'block-title');
      line(1, 'Jump to subroutine', null, null);
      line(2, `→ ${o.routine}`, null, null, 'block-title link');
    } else if (o.type === 'AOI') {
      const def = this.aois[o.aoi];
      line(0, `${o.aoi} ${o.tag}`, null, null, 'block-title aoi');
      const params = def ? def.params : Object.keys(o.args || {}).map((n) => ({ name: n, usage: 'Input' }));
      if (!def) line(1, '(unknown AOI)', null, null, 'block-text warn');
      params.forEach((p, i) => {
        const a = (o.args || {})[p.name] || '';
        const arrow = p.usage === 'Output' ? '→' : '←';
        line(i + 1 + (def ? 0 : 1), `${p.name} ${arrow} ${a || '—'}`, a || null, `${p.name} ${arrow} `);
      });
    }
  }

  /**
   * Update live highlighting from a routine scan result without rebuilding the SVG.
   * read(ref) returns live values when online (or null to hide values).
   */
  highlight(result, read = null) {
    if (!this.svg) return;
    const rungs = result ? result.rungs : [];
    for (const w of this.svg.querySelectorAll('.wire[data-r]')) {
      const rr = rungs[+w.dataset.r];
      let on = false;
      if (rr) {
        if (w.dataset.p === 'rung') on = rr.power;
        else {
          const t = rr.trace[w.dataset.k];
          on = t ? (w.dataset.p === 'in' ? t.powerIn : t.powerOut) : false;
        }
      }
      w.classList.toggle('on', on);
    }
    for (const c of this.svg.querySelectorAll('.contact')) {
      const rr = rungs[+c.dataset.r];
      const t = rr && rr.trace[c.dataset.k];
      c.classList.toggle('closed', !!(t && t.closed));
    }
    for (const o of this.svg.querySelectorAll('.output')) {
      const rr = rungs[+o.dataset.r];
      o.classList.toggle('on', !!(rr && rr.power));
    }
    for (const t of this.svg.querySelectorAll('[data-ref]')) {
      const ref = t.dataset.ref;
      const label = t.dataset.label || '';
      const literal = /^-?[\d.]+$/.test(ref);
      if (t.dataset.short) t.textContent = read && !literal ? `${label}=${fmtVal(read(ref))}` : label;
      else t.textContent = read && !literal ? `${label}${ref} = ${fmtVal(read(ref))}` : `${label}${ref}`;
    }
    for (const f of this.svg.querySelectorAll('[data-flags]')) {
      if (!read) { f.textContent = ''; continue; }
      const members = f.dataset.flags === 'TON' ? ['EN', 'TT', 'DN'] : ['CU', 'DN'];
      f.textContent = members.filter((m) => read(`${f.dataset.tag}.${m}`)).join(' ');
    }
  }
}
