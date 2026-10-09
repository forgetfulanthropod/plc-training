// Core ladder-logic engine. Pure functions, no DOM: shared by the app and the unit tests.
//
// Program format (JSON):
// {
//   name: string,
//   version: 1,
//   rungs: [{
//     comment: string,
//     logic: Series,              // conditions, evaluated left -> right
//     outputs: Output[]           // all outputs receive the rung's power (parallel)
//   }]
// }
// Series  = Item[]                          (AND)
// Item    = { type: 'NO'|'NC', tag }        contact
//         | { type: 'BRANCH', legs: Series[] }  parallel branch (OR of legs)
// Output  = { type: 'OTE'|'OTL'|'OTU'|'RES', tag }
//         | { type: 'TON', tag, preset }    preset in milliseconds
//         | { type: 'CTU', tag, preset }    preset in counts
//
// Timer members:   T1.EN  T1.TT  T1.DN   (and T1.ACC / T1.PRE as numbers)
// Counter members: C1.CU  C1.DN          (and C1.ACC / C1.PRE as numbers)

export const CONTACT_TYPES = ['NO', 'NC'];
export const OUTPUT_TYPES = ['OTE', 'OTL', 'OTU', 'TON', 'CTU', 'RES'];
export const TIMER_MEMBERS = ['EN', 'TT', 'DN'];
export const COUNTER_MEMBERS = ['CU', 'DN'];

export function createState() {
  return { tags: {}, timers: {}, counters: {}, scanCount: 0 };
}

export function newRung(comment = '') {
  return { comment, logic: [], outputs: [] };
}

/** Read a boolean bit. Supports plain tags and TIMER.MEMBER / COUNTER.MEMBER. */
export function getBit(state, ref) {
  if (!ref) return false;
  const dot = ref.indexOf('.');
  if (dot >= 0) {
    const name = ref.slice(0, dot);
    const member = ref.slice(dot + 1).toLowerCase();
    const obj = state.timers[name] || state.counters[name];
    return obj ? !!obj[member] : false;
  }
  return !!state.tags[ref];
}

export function ensureTimer(state, name, preset) {
  let t = state.timers[name];
  if (!t) t = state.timers[name] = { pre: 0, acc: 0, en: false, tt: false, dn: false };
  if (preset !== undefined) t.pre = Math.max(0, Number(preset) || 0);
  return t;
}

export function ensureCounter(state, name, preset) {
  let c = state.counters[name];
  if (!c) c = state.counters[name] = { pre: 0, acc: 0, cu: false, dn: false };
  if (preset !== undefined) c.pre = Math.max(0, Math.floor(Number(preset) || 0));
  return c;
}

export const pathKey = (path) => path.join('.');

/**
 * Evaluate a series of items with the given incoming power.
 * Records power flow for every item / branch leg into `trace` keyed by path.
 */
export function evalSeries(series, powerIn, state, path = [], trace = {}) {
  let p = powerIn;
  series.forEach((item, i) => {
    const ip = [...path, i];
    if (item.type === 'BRANCH') {
      const pin = p;
      let out = false;
      item.legs.forEach((leg, l) => {
        const lp = [...ip, l];
        const lo = evalSeries(leg, pin, state, lp, trace);
        trace[pathKey(lp)] = { powerIn: pin, powerOut: lo };
        if (lo) out = true;
      });
      p = out;
      trace[pathKey(ip)] = { powerIn: pin, powerOut: out };
    } else {
      const v = getBit(state, item.tag);
      const closed = item.type === 'NC' ? !v : v;
      const pin = p;
      p = pin && closed;
      trace[pathKey(ip)] = { powerIn: pin, powerOut: p, closed };
    }
  });
  return p;
}

/** Execute one output instruction with the rung's power. dt = scan time in ms. */
export function execOutput(out, power, state, dt) {
  const tag = out.tag;
  switch (out.type) {
    case 'OTE':
      state.tags[tag] = power;
      break;
    case 'OTL':
      if (power) state.tags[tag] = true;
      break;
    case 'OTU':
      if (power) state.tags[tag] = false;
      break;
    case 'TON': {
      const t = ensureTimer(state, tag, out.preset);
      if (power) {
        t.en = true;
        if (t.acc < t.pre) t.acc = Math.min(t.pre, t.acc + dt);
        t.dn = t.acc >= t.pre;
        t.tt = !t.dn;
      } else {
        t.en = t.tt = t.dn = false;
        t.acc = 0;
      }
      break;
    }
    case 'CTU': {
      const c = ensureCounter(state, tag, out.preset);
      if (power && !c.cu) c.acc += 1; // count on rising edge only
      c.cu = power;
      c.dn = c.acc >= c.pre;
      break;
    }
    case 'RES':
      if (power) {
        const t = state.timers[tag];
        if (t) { t.acc = 0; t.en = t.tt = t.dn = false; }
        const c = state.counters[tag];
        if (c) { c.acc = 0; c.dn = false; }
      }
      break;
    default:
      throw new Error(`Unknown output type ${out.type}`);
  }
  return power;
}

export function evaluateRung(rung, state, dt, trace = {}) {
  const power = evalSeries(rung.logic || [], true, state, [], trace);
  const outputs = (rung.outputs || []).map((o) => execOutput(o, power, state, dt));
  return { power, trace, outputs };
}

/**
 * One PLC scan: copy the input image into the tag table, solve every rung top to
 * bottom (later rungs see results of earlier rungs in the same scan), return trace.
 */
export function scan(program, state, inputs = {}, dt = 50) {
  for (const [k, v] of Object.entries(inputs)) state.tags[k] = !!v;
  const rungs = program.rungs.map((r) => evaluateRung(r, state, dt, {}));
  state.scanCount += 1;
  return { rungs };
}

/** Collect every tag referenced by a program. */
export function collectTags(program) {
  const bits = new Set();
  const timers = new Set();
  const counters = new Set();
  const walk = (series) => {
    for (const it of series) {
      if (it.type === 'BRANCH') it.legs.forEach(walk);
      else if (it.tag) bits.add(it.tag);
    }
  };
  for (const r of program.rungs) {
    walk(r.logic || []);
    for (const o of r.outputs || []) {
      if (o.type === 'TON') timers.add(o.tag);
      else if (o.type === 'CTU') counters.add(o.tag);
      else if (o.type !== 'RES' && o.tag) bits.add(o.tag);
    }
  }
  return { bits, timers, counters };
}

/** Remove empty legs and flatten single-leg branches, recursively. Mutates and returns series. */
export function normalizeSeries(series) {
  for (let i = 0; i < series.length; i++) {
    const it = series[i];
    if (it.type !== 'BRANCH') continue;
    it.legs = it.legs.map(normalizeSeries).filter((l) => l.length > 0);
    if (it.legs.length === 0) { series.splice(i, 1); i--; }
    else if (it.legs.length === 1) { series.splice(i, 1, ...it.legs[0]); i--; }
  }
  return series;
}

const TAG_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z]+)?$/;

/** Validate (and lightly normalise) an untrusted program object. Throws on error. */
export function validateProgram(p) {
  if (!p || typeof p !== 'object') throw new Error('Program must be an object');
  if (!Array.isArray(p.rungs)) throw new Error('Program needs a "rungs" array');
  const checkSeries = (s, where) => {
    if (!Array.isArray(s)) throw new Error(`${where}: logic must be an array`);
    s.forEach((it, i) => {
      const w = `${where} item ${i}`;
      if (!it || typeof it !== 'object') throw new Error(`${w}: invalid item`);
      if (it.type === 'BRANCH') {
        if (!Array.isArray(it.legs) || it.legs.length === 0) throw new Error(`${w}: branch needs legs`);
        it.legs.forEach((l, j) => checkSeries(l, `${w} leg ${j}`));
      } else if (CONTACT_TYPES.includes(it.type)) {
        if (typeof it.tag !== 'string' || !TAG_RE.test(it.tag)) throw new Error(`${w}: bad tag "${it.tag}"`);
      } else throw new Error(`${w}: unknown type "${it.type}"`);
    });
  };
  p.rungs.forEach((r, i) => {
    const w = `Rung ${i}`;
    if (!r || typeof r !== 'object') throw new Error(`${w}: invalid rung`);
    r.comment = typeof r.comment === 'string' ? r.comment : '';
    r.logic = r.logic || [];
    r.outputs = r.outputs || [];
    checkSeries(r.logic, w);
    if (!Array.isArray(r.outputs)) throw new Error(`${w}: outputs must be an array`);
    r.outputs.forEach((o, j) => {
      if (!o || !OUTPUT_TYPES.includes(o.type)) throw new Error(`${w} output ${j}: unknown type "${o && o.type}"`);
      if (typeof o.tag !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.tag)) throw new Error(`${w} output ${j}: bad tag "${o.tag}"`);
      if ((o.type === 'TON' || o.type === 'CTU')) {
        const n = Number(o.preset);
        if (!Number.isFinite(n) || n < 0) throw new Error(`${w} output ${j}: preset must be a number >= 0`);
        o.preset = n;
      }
    });
    normalizeSeries(r.logic);
  });
  p.name = typeof p.name === 'string' ? p.name : 'Untitled';
  p.version = 1;
  return p;
}
