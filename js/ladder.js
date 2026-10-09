// Core ladder-logic engine. Pure functions, no DOM: shared by the app, controller and tests.
//
// Routine format (a legacy "program" is just a routine with a name):
// { rungs: [{ comment, logic: Series, outputs: Output[] }] }
// Series = Item[]                                   (AND, left to right)
// Item   = { type: 'NO'|'NC', tag }                 contacts (XIC / XIO)
//        | { type: 'EQU'|'NEQ'|'GRT'|'GEQ'|'LES'|'LEQ', a, b }   compares (operand = tag or number)
//        | { type: 'BRANCH', legs: Series[] }       parallel branch (OR)
// Output = { type: 'OTE'|'OTL'|'OTU'|'RES', tag }
//        | { type: 'TON', tag, preset }  ms        | { type: 'CTU', tag, preset } counts
//        | { type: 'MOV', src, dest }               | { type: 'ADD'|'SUB'|'MUL'|'DIV', a, b, dest }
//        | { type: 'JSR', routine }                 | { type: 'AOI', aoi, tag, args: { Param: operand } }
//
// Tags may use member access: Tank.Level, T1.DN, C1.ACC, Motor1.Run

export const CONTACT_TYPES = ['NO', 'NC'];
export const COMPARE_TYPES = ['EQU', 'NEQ', 'GRT', 'GEQ', 'LES', 'LEQ'];
export const INPUT_TYPES = [...CONTACT_TYPES, ...COMPARE_TYPES];
export const MATH_TYPES = ['ADD', 'SUB', 'MUL', 'DIV'];
export const OUTPUT_TYPES = ['OTE', 'OTL', 'OTU', 'TON', 'CTU', 'RES', 'MOV', ...MATH_TYPES, 'JSR', 'AOI'];
export const TIMER_MEMBERS = ['EN', 'TT', 'DN'];
export const COUNTER_MEMBERS = ['CU', 'DN'];
export const BASIC_TYPES = ['BOOL', 'INT', 'DINT', 'REAL'];
export const BUILTIN_TYPES = [...BASIC_TYPES, 'TIMER', 'COUNTER'];
export const MAX_DEPTH = 16;

export const TAG_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
export const NUM_RE = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
export const isLiteral = (s) => typeof s === 'number' || (typeof s === 'string' && NUM_RE.test(s.trim()));
export const isOperand = (s) => isLiteral(s) || (typeof s === 'string' && TAG_RE.test(s));

export function createState() {
  return { tags: {}, timers: {}, counters: {}, scanCount: 0 };
}

export function newRung(comment = '') {
  return { comment, logic: [], outputs: [] };
}

/** Convert a value to a basic data type, Logix style (INT/DINT wrap, REAL float). */
export function coerce(type, v) {
  const num = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
  switch (type) {
    case 'BOOL': return typeof v === 'boolean' ? v : !!num;
    case 'INT': {
      let n = Math.round(Number.isFinite(num) ? num : 0);
      n = ((n % 65536) + 65536) % 65536;
      return n >= 32768 ? n - 65536 : n;
    }
    case 'DINT': return Math.round(Number.isFinite(num) ? num : 0) | 0;
    case 'REAL': return Number.isFinite(num) ? num : 0;
    default: return v;
  }
}

export function newTimer(pre = 0) { return { pre, acc: 0, en: false, tt: false, dn: false }; }
export function newCounter(pre = 0) { return { pre, acc: 0, cu: false, dn: false }; }

/** Default value for a data type. `types` = { udts: {name: def}, aois: {name: def} } */
export function makeDefault(type, types = {}, value, depth = 0) {
  if (depth > 10) return undefined;
  if (BASIC_TYPES.includes(type)) return coerce(type, value ?? 0);
  const udt = types.udts && types.udts[type];
  if (udt) {
    const o = {};
    for (const m of udt.members) o[m.name] = makeDefault(m.type, types, value && value[m.name], depth + 1);
    return o;
  }
  const aoi = types.aois && types.aois[type];
  if (aoi) return makeAoiInstance(aoi, types, depth + 1);
  return false;
}

/** AOI backing tag: parameters and local BOOL/number tags live as members; local timers/counters hidden. */
export function makeAoiInstance(def, types = {}, depth = 0) {
  const inst = { EnableIn: false, EnableOut: false };
  Object.defineProperty(inst, '__timers', { value: {}, enumerable: false, writable: true });
  Object.defineProperty(inst, '__counters', { value: {}, enumerable: false, writable: true });
  for (const p of def.params || []) inst[p.name] = makeDefault(p.type, types, undefined, depth + 1);
  for (const l of def.locals || []) {
    if (l.type === 'TIMER') inst.__timers[l.name] = newTimer(Number(l.value && l.value.pre) || 0);
    else if (l.type === 'COUNTER') inst.__counters[l.name] = newCounter(Number(l.value && l.value.pre) || 0);
    else inst[l.name] = makeDefault(l.type, types, l.value, depth + 1);
  }
  return inst;
}

export function ensureTimer(store, name, preset) {
  let t = store.timers[name];
  if (!t) t = store.timers[name] = newTimer();
  if (preset !== undefined && preset !== '') t.pre = Math.max(0, Number(preset) || 0);
  return t;
}

export function ensureCounter(store, name, preset) {
  let c = store.counters[name];
  if (!c) c = store.counters[name] = newCounter();
  if (preset !== undefined && preset !== '') c.pre = Math.max(0, Math.floor(Number(preset) || 0));
  return c;
}

/**
 * Execution context: resolves tag references against program scope (if the name is declared
 * there) or controller scope, applies forces (controller scope) and data-type coercion.
 */
export class Ctx {
  constructor(state, opts = {}) {
    this.state = state;
    this.scope = opts.scope || null;           // { tags, timers, counters }
    this.scopeDecls = opts.scopeDecls || null; // { name: type }
    this.ctrlDecls = opts.ctrlDecls || null;
    this.types = opts.types || { udts: {}, aois: {} };
    this.forces = opts.forces || null;          // { ref: value }
    this.jsr = opts.jsr || null;                // (routineName, ctx, dt) => void
    this.traces = opts.traces || null;
    this.depth = opts.depth || 0;
  }

  where(base) {
    if (this.scope && this.scopeDecls && Object.prototype.hasOwnProperty.call(this.scopeDecls, base)) {
      return { store: this.scope, decl: this.scopeDecls[base], ctrl: false };
    }
    return { store: this.state, decl: this.ctrlDecls ? this.ctrlDecls[base] : undefined, ctrl: true };
  }

  /** Declared data type of a (possibly member) reference, or undefined. */
  typeOf(ref) {
    const parts = ref.split('.');
    let t = this.where(parts[0]).decl;
    for (let i = 1; i < parts.length && t; i++) {
      const m = parts[i];
      if (t === 'TIMER' || t === 'COUNTER') return ['PRE', 'ACC'].includes(m.toUpperCase()) ? 'DINT' : 'BOOL';
      const udt = this.types.udts && this.types.udts[t];
      const aoi = this.types.aois && this.types.aois[t];
      if (udt) t = (udt.members.find((x) => x.name === m) || {}).type;
      else if (aoi) {
        if (m === 'EnableIn' || m === 'EnableOut') return 'BOOL';
        t = ([...(aoi.params || []), ...(aoi.locals || [])].find((x) => x.name === m) || {}).type;
      } else return undefined;
    }
    return t;
  }

  forced(ref, w) {
    return w.ctrl && this.forces && Object.prototype.hasOwnProperty.call(this.forces, ref);
  }

  read(ref) {
    if (typeof ref !== 'string' || !ref) return undefined;
    const parts = ref.split('.');
    const base = parts[0];
    const w = this.where(base);
    if (this.forced(ref, w)) return this.forces[ref];
    const tc = w.store.timers[base] || w.store.counters[base];
    if (tc) return parts.length > 1 ? tc[parts[1].toLowerCase()] : tc;
    let v = w.store.tags[base];
    for (let i = 1; i < parts.length; i++) {
      if (v == null || typeof v !== 'object') return undefined;
      v = v[parts[i]];
    }
    return v;
  }

  write(ref, val) {
    const parts = ref.split('.');
    const base = parts[0];
    const w = this.where(base);
    const type = this.typeOf(ref);
    if (BASIC_TYPES.includes(type)) val = coerce(type, val);
    if (this.forced(ref, w)) val = this.forces[ref];
    const tc = w.store.timers[base] || w.store.counters[base];
    if (tc) {
      if (parts.length > 1) {
        const m = parts[1].toLowerCase();
        tc[m] = m === 'pre' || m === 'acc' ? Number(val) || 0 : !!val;
      }
      return;
    }
    if (parts.length === 1) { w.store.tags[base] = val; return; }
    let o = w.store.tags[base];
    if (o == null || typeof o !== 'object') o = w.store.tags[base] = {};
    for (let i = 1; i < parts.length - 1; i++) {
      if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = val;
  }

  bit(ref) {
    if (isLiteral(ref)) return Number(ref) !== 0;
    const v = this.read(ref);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return false;
  }

  num(operand) {
    if (isLiteral(operand)) return Number(operand);
    const v = this.read(operand);
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  timer(name, preset) { return ensureTimer(this.where(name).store, name, preset); }
  counter(name, preset) { return ensureCounter(this.where(name).store, name, preset); }
}

const asCtx = (s) => (s instanceof Ctx ? s : new Ctx(s));

/** Read a boolean bit from a plain state (legacy API). */
export function getBit(state, ref) {
  if (!ref) return false;
  return asCtx(state).bit(ref);
}

export const pathKey = (path) => path.join('.');

export function compare(type, a, b) {
  switch (type) {
    case 'EQU': return a === b;
    case 'NEQ': return a !== b;
    case 'GRT': return a > b;
    case 'GEQ': return a >= b;
    case 'LES': return a < b;
    case 'LEQ': return a <= b;
    default: throw new Error(`Unknown compare ${type}`);
  }
}

/** Evaluate a series; records power flow for every item / leg into `trace` keyed by path. */
export function evalSeries(series, powerIn, ctxOrState, path = [], trace = {}) {
  const ctx = asCtx(ctxOrState);
  let p = powerIn;
  series.forEach((item, i) => {
    const ip = [...path, i];
    if (item.type === 'BRANCH') {
      const pin = p;
      let out = false;
      item.legs.forEach((leg, l) => {
        const lp = [...ip, l];
        const lo = evalSeries(leg, pin, ctx, lp, trace);
        trace[pathKey(lp)] = { powerIn: pin, powerOut: lo };
        if (lo) out = true;
      });
      p = out;
      trace[pathKey(ip)] = { powerIn: pin, powerOut: out };
    } else {
      let closed;
      if (COMPARE_TYPES.includes(item.type)) closed = compare(item.type, ctx.num(item.a), ctx.num(item.b));
      else {
        const v = ctx.bit(item.tag);
        closed = item.type === 'NC' ? !v : v;
      }
      const pin = p;
      p = pin && closed;
      trace[pathKey(ip)] = { powerIn: pin, powerOut: p, closed };
    }
  });
  return p;
}

function execAoi(out, power, ctx, dt) {
  const def = ctx.types.aois && ctx.types.aois[out.aoi];
  if (!def) throw new Error(`Unknown Add-On Instruction "${out.aoi}"`);
  if (ctx.depth >= MAX_DEPTH) throw new Error('AOI/JSR nesting too deep');
  const w = ctx.where(out.tag);
  let inst = w.store.tags[out.tag];
  if (!inst || typeof inst !== 'object' || !inst.__timers) inst = w.store.tags[out.tag] = makeAoiInstance(def, ctx.types);
  const args = out.args || {};
  const decls = { EnableIn: 'BOOL', EnableOut: 'BOOL' };
  for (const p of def.params || []) decls[p.name] = p.type;
  for (const l of def.locals || []) decls[l.name] = l.type;
  for (const p of def.params || []) {
    const a = args[p.name];
    if (p.usage !== 'Output' && a !== undefined && a !== '') {
      inst[p.name] = coerce(p.type, p.type === 'BOOL' ? ctx.bit(a) : ctx.num(a));
    }
  }
  inst.EnableIn = power;
  if (power) {
    const actx = new Ctx(ctx.state, {
      scope: { tags: inst, timers: inst.__timers, counters: inst.__counters },
      scopeDecls: decls, ctrlDecls: ctx.ctrlDecls, types: ctx.types, forces: ctx.forces,
      traces: ctx.traces, depth: ctx.depth + 1, jsr: null,
    });
    const res = runRungs(def.rungs || [], actx, dt);
    if (ctx.traces) ctx.traces[`AOI:${def.name}`] = res;
    for (const p of def.params || []) {
      const a = args[p.name];
      if (p.usage === 'Output' && a && !isLiteral(a)) ctx.write(a, inst[p.name]);
    }
  }
  inst.EnableOut = power;
  return power;
}

/** Execute one output instruction with the rung's power. dt = scan time in ms. */
export function execOutput(out, power, ctxOrState, dt) {
  const ctx = asCtx(ctxOrState);
  const tag = out.tag;
  switch (out.type) {
    case 'OTE': ctx.write(tag, power); break;
    case 'OTL': if (power) ctx.write(tag, true); break;
    case 'OTU': if (power) ctx.write(tag, false); break;
    case 'TON': {
      const t = ctx.timer(tag, out.preset);
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
      const c = ctx.counter(tag, out.preset);
      if (power && !c.cu) c.acc += 1; // count on rising edge only
      c.cu = power;
      c.dn = c.acc >= c.pre;
      break;
    }
    case 'RES':
      if (power) {
        const st = ctx.where(tag).store;
        const t = st.timers[tag];
        if (t) { t.acc = 0; t.en = t.tt = t.dn = false; }
        const c = st.counters[tag];
        if (c) { c.acc = 0; c.dn = false; }
      }
      break;
    case 'MOV':
      if (power) ctx.write(out.dest, ctx.typeOf(out.dest) === 'BOOL' ? ctx.bit(out.src) : ctx.num(out.src));
      break;
    case 'ADD': case 'SUB': case 'MUL': case 'DIV':
      if (power) {
        const a = ctx.num(out.a), b = ctx.num(out.b);
        let r;
        if (out.type === 'ADD') r = a + b;
        else if (out.type === 'SUB') r = a - b;
        else if (out.type === 'MUL') r = a * b;
        else if (b === 0) { r = 0; ctx.state.mathFault = true; } // divide by zero: minor fault, result 0
        else {
          r = a / b;
          const dt2 = ctx.typeOf(out.dest);
          if (dt2 === 'INT' || dt2 === 'DINT') r = Math.trunc(r);
        }
        ctx.write(out.dest, r);
      }
      break;
    case 'JSR':
      if (power) {
        if (ctx.depth >= MAX_DEPTH) throw new Error('JSR nesting too deep');
        if (ctx.jsr) ctx.jsr(out.routine, ctx, dt);
      }
      break;
    case 'AOI':
      return execAoi(out, power, ctx, dt);
    default:
      throw new Error(`Unknown output type ${out.type}`);
  }
  return power;
}

export function evaluateRung(rung, ctxOrState, dt, trace = {}) {
  const ctx = asCtx(ctxOrState);
  const power = evalSeries(rung.logic || [], true, ctx, [], trace);
  const outputs = (rung.outputs || []).map((o) => execOutput(o, power, ctx, dt));
  return { power, trace, outputs };
}

export function runRungs(rungs, ctx, dt) {
  return { rungs: rungs.map((r) => evaluateRung(r, ctx, dt, {})) };
}

/**
 * One scan of a single routine (legacy API): copy inputs into tags, solve every rung
 * top to bottom (later rungs see results of earlier rungs in the same scan).
 */
export function scan(program, state, inputs = {}, dt = 50, opts = {}) {
  const ctx = new Ctx(state, opts);
  for (const [k, v] of Object.entries(inputs)) ctx.write(k, !!v);
  const res = runRungs(program.rungs, ctx, dt);
  state.scanCount = (state.scanCount || 0) + 1;
  return res;
}

// ------------------------------------------------------------------ static analysis

/** Every tag reference an instruction makes: [{ ref, access: 'read'|'write' }]. */
export function instructionRefs(ins, aois = {}) {
  const r = [];
  const rd = (x) => { if (x && !isLiteral(x)) r.push({ ref: String(x), access: 'read' }); };
  const wr = (x) => { if (x && !isLiteral(x)) r.push({ ref: String(x), access: 'write' }); };
  switch (ins.type) {
    case 'NO': case 'NC': rd(ins.tag); break;
    case 'EQU': case 'NEQ': case 'GRT': case 'GEQ': case 'LES': case 'LEQ': rd(ins.a); rd(ins.b); break;
    case 'OTE': case 'OTL': case 'OTU': case 'TON': case 'CTU': case 'RES': wr(ins.tag); break;
    case 'MOV': rd(ins.src); wr(ins.dest); break;
    case 'ADD': case 'SUB': case 'MUL': case 'DIV': rd(ins.a); rd(ins.b); wr(ins.dest); break;
    case 'AOI': {
      wr(ins.tag);
      const def = aois[ins.aoi];
      for (const [p, a] of Object.entries(ins.args || {})) {
        const pd = def && (def.params || []).find((x) => x.name === p);
        if (pd && pd.usage === 'Output') wr(a); else rd(a);
      }
      break;
    }
    default: break;
  }
  return r;
}

export function forEachInstruction(rungs, cb) {
  const walk = (series, rung) => {
    for (const it of series) {
      if (it.type === 'BRANCH') it.legs.forEach((l) => walk(l, rung));
      else cb(it, rung, 'input');
    }
  };
  rungs.forEach((rung, i) => {
    walk(rung.logic || [], i);
    for (const o of rung.outputs || []) cb(o, i, 'output');
  });
}

/** Collect every tag referenced by a routine. */
export function collectTags(program) {
  const bits = new Set();
  const timers = new Set();
  const counters = new Set();
  const numbers = new Set();
  forEachInstruction(program.rungs, (ins) => {
    if (ins.type === 'TON') timers.add(ins.tag);
    else if (ins.type === 'CTU') counters.add(ins.tag);
    else if (CONTACT_TYPES.includes(ins.type) || ['OTE', 'OTL', 'OTU'].includes(ins.type)) { if (ins.tag) bits.add(ins.tag); }
    else if (ins.type !== 'RES' && ins.type !== 'JSR' && ins.type !== 'AOI') for (const x of instructionRefs(ins)) numbers.add(x.ref);
  });
  return { bits, timers, counters, numbers };
}

/** Mnemonic text for a rung, e.g. "[XIC(START_PB) ,XIC(MOTOR) ]XIO(STOP_PB)OTE(MOTOR)". */
export function rungText(rung) {
  const it = (x) => {
    switch (x.type) {
      case 'BRANCH': return `[${x.legs.map(series).join(',')}]`;
      case 'NO': return `XIC(${x.tag})`;
      case 'NC': return `XIO(${x.tag})`;
      default:
        if (COMPARE_TYPES.includes(x.type)) return `${x.type}(${x.a},${x.b})`;
        return '';
    }
  };
  const series = (s) => s.map(it).join(' ');
  const out = (o) => {
    switch (o.type) {
      case 'TON': case 'CTU': return `${o.type}(${o.tag},${o.preset})`;
      case 'MOV': return `MOV(${o.src},${o.dest})`;
      case 'ADD': case 'SUB': case 'MUL': case 'DIV': return `${o.type}(${o.a},${o.b},${o.dest})`;
      case 'JSR': return `JSR(${o.routine})`;
      case 'AOI': return `${o.aoi}(${o.tag}${Object.entries(o.args || {}).map(([k, v]) => `,${k}:=${v}`).join('')})`;
      default: return `${o.type}(${o.tag})`;
    }
  };
  return [series(rung.logic || []), ...(rung.outputs || []).map(out)].filter(Boolean).join(' ') + ';';
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

/** Validate (and lightly normalise) an untrusted routine/program object. Throws on error. */
export function validateProgram(p) {
  if (!p || typeof p !== 'object') throw new Error('Program must be an object');
  if (!Array.isArray(p.rungs)) throw new Error('Program needs a "rungs" array');
  const tagOk = (t) => typeof t === 'string' && TAG_RE.test(t);
  const checkSeries = (s, where) => {
    if (!Array.isArray(s)) throw new Error(`${where}: logic must be an array`);
    s.forEach((it, i) => {
      const w = `${where} item ${i}`;
      if (!it || typeof it !== 'object') throw new Error(`${w}: invalid item`);
      if (it.type === 'BRANCH') {
        if (!Array.isArray(it.legs) || it.legs.length === 0) throw new Error(`${w}: branch needs legs`);
        it.legs.forEach((l, j) => checkSeries(l, `${w} leg ${j}`));
      } else if (CONTACT_TYPES.includes(it.type)) {
        if (!tagOk(it.tag)) throw new Error(`${w}: bad tag "${it.tag}"`);
      } else if (COMPARE_TYPES.includes(it.type)) {
        for (const k of ['a', 'b']) {
          if (typeof it[k] === 'number') it[k] = String(it[k]);
          if (!isOperand(it[k])) throw new Error(`${w}: bad operand ${k.toUpperCase()} "${it[k]}"`);
        }
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
      const ow = `${w} output ${j}`;
      if (!o || !OUTPUT_TYPES.includes(o.type)) throw new Error(`${ow}: unknown type "${o && o.type}"`);
      const operand = (k) => {
        if (typeof o[k] === 'number') o[k] = String(o[k]);
        if (!isOperand(o[k])) throw new Error(`${ow}: bad operand ${k} "${o[k]}"`);
      };
      const dest = (k) => { if (!tagOk(o[k])) throw new Error(`${ow}: bad destination "${o[k]}"`); };
      switch (o.type) {
        case 'MOV': operand('src'); dest('dest'); break;
        case 'ADD': case 'SUB': case 'MUL': case 'DIV': operand('a'); operand('b'); dest('dest'); break;
        case 'JSR': if (typeof o.routine !== 'string' || !o.routine) throw new Error(`${ow}: JSR needs a routine`); break;
        case 'AOI':
          if (typeof o.aoi !== 'string' || !o.aoi) throw new Error(`${ow}: AOI needs a definition name`);
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.tag || '')) throw new Error(`${ow}: bad tag "${o.tag}"`);
          o.args = o.args && typeof o.args === 'object' ? o.args : {};
          for (const [k, v] of Object.entries(o.args)) {
            if (v === '' || v == null) { delete o.args[k]; continue; }
            if (typeof v === 'number') o.args[k] = String(v);
            if (!isOperand(o.args[k])) throw new Error(`${ow}: bad argument ${k} "${v}"`);
          }
          break;
        default:
          if (!tagOk(o.tag)) throw new Error(`${ow}: bad tag "${o.tag}"`);
          if (o.type === 'TON' || o.type === 'CTU') {
            const n = Number(o.preset);
            if (!Number.isFinite(n) || n < 0) throw new Error(`${ow}: preset must be a number >= 0`);
            o.preset = n;
          }
      }
    });
    normalizeSeries(r.logic);
  });
  p.name = typeof p.name === 'string' ? p.name : 'Untitled';
  if (p.version === undefined) p.version = 1;
  return p;
}
