// Ladder editor: SVG rendering, selection, editing operations and live highlighting.
import { normalizeSeries, pathKey } from './ladder.js';

const NS = 'http://www.w3.org/2000/svg';
const CW = 104;   // contact cell width
const RH = 66;    // row height
const BP = 16;    // branch padding
const LEFT = 44;  // x of left power rail
const OUTW = 190; // output column width
const HEAD = 24;  // rung comment header height

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
    if (!sel) sel = { r: program.rungs.length - 1, kind: 'rung' };
    if (!program.rungs.length) { program.rungs.push({ comment: '', logic: [], outputs: [] }); sel = { r: 0, kind: 'rung' }; }
    const rung = program.rungs[sel.r];
    const c = { type, tag };
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

  addOutput(program, sel, type) {
    if (!program.rungs.length) program.rungs.push({ comment: '', logic: [], outputs: [] });
    const r = sel ? sel.r : program.rungs.length - 1;
    const rung = program.rungs[r];
    let o;
    if (type === 'TON') o = { type, tag: nextName(program, 'T'), preset: 2000 };
    else if (type === 'CTU') o = { type, tag: nextName(program, 'C'), preset: 5 };
    else if (type === 'RES') {
      const tc = program.rungs.flatMap((x) => x.outputs).find((x) => x.type === 'TON' || x.type === 'CTU');
      o = { type, tag: tc ? tc.tag : 'C1' };
    } else o = { type, tag: 'NEW_COIL' };
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
export class LadderView {
  constructor(container, onSelect) {
    this.container = container;
    this.onSelect = onSelect;
    this.sel = null;
    this.svg = null;
  }

  render(program, sel) {
    this.sel = sel;
    const sizes = program.rungs.map((r) => measureSeries(r.logic));
    const contentW = Math.max(2 * CW, ...sizes.map((s) => s.w));
    const J = LEFT + contentW + 24;
    const RR = J + OUTW;
    let total = 10;
    const heights = program.rungs.map((r, i) => {
      const h = HEAD + Math.max(sizes[i].h, r.outputs.length, 1) * RH + 6;
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
      const g = el('g', { class: 'rung', 'data-r': r }, svg);
      const bg = el('rect', { x: 0, y, width, height: h - 4, class: 'rung-bg' + (sel && sel.r === r && sel.kind === 'rung' ? ' sel' : ''), rx: 6 }, g);
      this.hit(bg, { r, kind: 'rung' });
      el('text', { x: 8, y: y + HEAD + RH / 2 + 5, class: 'rung-num' }, g, String(r).padStart(3, '0'));
      el('text', { x: LEFT + 8, y: y + 16, class: 'rung-comment' }, g, rung.comment ? `// ${rung.comment}` : '');

      const ry = y + HEAD;
      const cy = ry + RH / 2;
      const end = this.drawSeries(g, rung.logic, LEFT, ry, r, []);
      el('line', { x1: end, y1: cy, x2: J, y2: cy, class: 'wire', 'data-r': r, 'data-p': 'rung' }, g);

      const outs = rung.outputs;
      if (outs.length > 1) el('line', { x1: J, y1: cy, x2: J, y2: cy + (outs.length - 1) * RH, class: 'wire', 'data-r': r, 'data-p': 'rung' }, g);
      if (!outs.length) el('line', { x1: J, y1: cy, x2: RR, y2: cy, class: 'wire dim' }, g);
      outs.forEach((o, k) => this.drawOutput(g, o, J, RR, ry + k * RH, r, k));
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
    el('text', { x: x + 52, y: cy + 28, class: 'kind' }, cg, it.type === 'NC' ? 'XIO' : 'XIC');
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
    const og = el('g', { class: 'output', 'data-r': r, 'data-o': k }, g);
    const hit = el('rect', { x: J + 8, y: y + 4, width: RR - J - 16, height: RH - 8, class: 'hit', rx: 4 }, og);
    this.hit(hit, { r, kind: 'out', o: k });
    const mid = (J + RR) / 2;
    const isBlock = o.type === 'TON' || o.type === 'CTU';
    const half = isBlock ? 58 : o.type === 'RES' ? 22 : 16;
    el('line', { x1: J, y1: cy, x2: mid - half, y2: cy, class: 'wire', 'data-r': r, 'data-p': 'rung' }, og);
    el('line', { x1: mid + half, y1: cy, x2: RR, y2: cy, class: 'wire', 'data-r': r, 'data-p': 'rung' }, og);
    if (isBlock) {
      el('rect', { x: mid - half, y: cy - 27, width: half * 2, height: 54, class: 'block', rx: 3 }, og);
      el('text', { x: mid - half + 6, y: cy - 13, class: 'block-title' }, og, `${o.type} ${o.tag}`);
      el('text', { x: mid - half + 6, y: cy + 2, class: 'block-text' }, og, `PRE ${o.preset}${o.type === 'TON' ? ' ms' : ''}`);
      el('text', { x: mid - half + 6, y: cy + 17, class: 'block-text', 'data-acc': `${r}:${k}` }, og, 'ACC 0');
      el('text', { x: mid + half - 4, y: cy - 13, class: 'block-flags', 'data-flags': `${r}:${k}` }, og, '');
    } else {
      el('path', { d: `M ${mid - half + 6} ${cy - 15} Q ${mid - half - 4} ${cy} ${mid - half + 6} ${cy + 15}`, class: 'sym coil' }, og);
      el('path', { d: `M ${mid + half - 6} ${cy - 15} Q ${mid + half + 4} ${cy} ${mid + half - 6} ${cy + 15}`, class: 'sym coil' }, og);
      const letter = { OTL: 'L', OTU: 'U', RES: 'RES', OTE: '' }[o.type];
      if (letter) el('text', { x: mid, y: cy + 5, class: 'coil-letter' }, og, letter);
      el('text', { x: mid, y: cy - 20, class: 'tag' }, og, o.tag);
      el('text', { x: mid, y: cy + 28, class: 'kind' }, og, o.type);
    }
  }

  /** Update live highlighting from a scan result without rebuilding the SVG. */
  highlight(result, state, program) {
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
    for (const t of this.svg.querySelectorAll('[data-acc]')) {
      const [r, k] = t.dataset.acc.split(':').map(Number);
      const o = program.rungs[r] && program.rungs[r].outputs[k];
      if (!o) continue;
      const obj = o.type === 'TON' ? state.timers[o.tag] : state.counters[o.tag];
      t.textContent = `ACC ${obj ? Math.round(obj.acc) : 0}`;
      const f = this.svg.querySelector(`[data-flags="${r}:${k}"]`);
      if (f) {
        const flags = obj ? (o.type === 'TON' ? ['en', 'tt', 'dn'] : ['cu', 'dn']).filter((m) => obj[m]).map((m) => m.toUpperCase()) : [];
        f.textContent = flags.join(' ');
      }
    }
  }
}
