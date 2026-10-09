// Project model (version 2): controller > tasks > programs > routines, tags, UDTs, AOIs,
// I/O configuration and forces. Also migration from v1 single-routine programs,
// verification, cross reference and project compare.
import {
  validateProgram, collectTags, forEachInstruction, instructionRefs, rungText,
  BUILTIN_TYPES, BASIC_TYPES, createState, makeDefault, coerce, newTimer, newCounter, TAG_RE,
} from './ladder.js';

export const PROJECT_VERSION = 2;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const clone = (x) => JSON.parse(JSON.stringify(x));

export const INPUT_MODULE = '1756-IB16 DC Input';
export const OUTPUT_MODULE = '1756-OB16 DC Output';
export const FIELD_INPUTS = ['START_PB', 'STOP_PB', 'ESTOP', 'RESET_PB', 'PE_ENTRY', 'PE_MID', 'PE_TALL', 'PE_END'];
export const FIELD_OUTPUTS = ['MOTOR', 'DIVERTER', 'LIGHT_GREEN', 'LIGHT_AMBER', 'LIGHT_RED'];

export function ioAddress(row) {
  return `Local:${row.slot}:${row.dir === 'IN' ? 'I' : 'O'}.Data.${row.channel}`;
}

export function defaultIoConfig() {
  return [
    ...FIELD_INPUTS.map((s, i) => ({ slot: 1, module: INPUT_MODULE, channel: i, dir: 'IN', signal: s, tag: s })),
    ...FIELD_OUTPUTS.map((s, i) => ({ slot: 2, module: OUTPUT_MODULE, channel: i, dir: 'OUT', signal: s, tag: s })),
  ];
}

export function newProject(name = 'NewProject') {
  return {
    version: PROJECT_VERSION,
    name,
    controller: { name: 'PLC1' },
    dataTypes: [],
    aois: [],
    controllerTags: [...FIELD_INPUTS, ...FIELD_OUTPUTS].map((n) => ({ name: n, type: 'BOOL', description: 'Field I/O' })),
    ioConfig: defaultIoConfig(),
    tasks: [{
      name: 'MainTask', type: 'continuous', period: 100,
      programs: [{ name: 'MainProgram', mainRoutine: 'MainRoutine', tags: [], routines: [{ name: 'MainRoutine', rungs: [{ comment: '', logic: [], outputs: [] }] }] }],
    }],
    forces: {},
    forcesEnabled: false,
  };
}

export const isLegacyProgram = (o) => !!o && typeof o === 'object' && Array.isArray(o.rungs) && !Array.isArray(o.tasks);

/** Turn a v1 program ({ name, rungs }) or a v2 project into a validated v2 project. */
export function migrate(obj) {
  if (isLegacyProgram(obj)) {
    const prog = validateProgram(clone(obj));
    const p = newProject(prog.name || 'Migrated');
    p.tasks[0].programs[0].routines[0].rungs = prog.rungs;
    const declared = new Set(p.controllerTags.map((t) => t.name));
    const { bits, timers, counters } = collectTags(prog);
    const add = (name, type) => { if (!declared.has(name)) { declared.add(name); p.controllerTags.push({ name, type, description: '' }); } };
    for (const t of timers) add(t, 'TIMER');
    for (const c of counters) add(c, 'COUNTER');
    for (const b of bits) if (!b.includes('.')) add(b, 'BOOL');
    return validateProject(p);
  }
  return validateProject(clone(obj));
}

export function typesOf(project) {
  const udts = {};
  for (const d of project.dataTypes || []) udts[d.name] = d;
  const aois = {};
  for (const a of project.aois || []) aois[a.name] = a;
  return { udts, aois };
}

export const declsOf = (tags) => Object.fromEntries((tags || []).map((t) => [t.name, t.type]));

export function allTypeNames(project) {
  return [...BUILTIN_TYPES, ...(project.dataTypes || []).map((d) => d.name), ...(project.aois || []).map((a) => a.name)];
}

export function validateProject(p) {
  if (!p || typeof p !== 'object') throw new Error('Project must be an object');
  if (!Array.isArray(p.tasks)) throw new Error('Project needs a "tasks" array');
  p.version = PROJECT_VERSION;
  p.name = typeof p.name === 'string' && p.name ? p.name : 'Untitled';
  p.controller = p.controller && typeof p.controller === 'object' ? p.controller : { name: 'PLC1' };
  p.dataTypes = Array.isArray(p.dataTypes) ? p.dataTypes : [];
  p.aois = Array.isArray(p.aois) ? p.aois : [];
  p.controllerTags = Array.isArray(p.controllerTags) ? p.controllerTags : [];
  p.ioConfig = Array.isArray(p.ioConfig) ? p.ioConfig : defaultIoConfig();
  p.forces = p.forces && typeof p.forces === 'object' ? p.forces : {};
  p.forcesEnabled = !!p.forcesEnabled;
  const names = new Set();
  const uniq = (kind, n) => {
    if (typeof n !== 'string' || !NAME_RE.test(n)) throw new Error(`${kind}: bad name "${n}"`);
    if (names.has(`${kind}:${n}`)) throw new Error(`${kind}: duplicate name "${n}"`);
    names.add(`${kind}:${n}`);
  };
  const typeNames = new Set(allTypeNames(p));
  const checkTags = (tags, where) => {
    const seen = new Set();
    for (const t of tags) {
      if (!t || !NAME_RE.test(t.name || '')) throw new Error(`${where}: bad tag name "${t && t.name}"`);
      if (seen.has(t.name)) throw new Error(`${where}: duplicate tag "${t.name}"`);
      seen.add(t.name);
      if (!typeNames.has(t.type)) throw new Error(`${where}: tag "${t.name}" has unknown type "${t.type}"`);
      t.description = typeof t.description === 'string' ? t.description : '';
    }
  };
  for (const d of p.dataTypes) {
    uniq('Data type', d.name);
    if (BUILTIN_TYPES.includes(d.name)) throw new Error(`Data type: "${d.name}" is reserved`);
    d.members = Array.isArray(d.members) ? d.members : [];
    for (const m of d.members) {
      if (!NAME_RE.test(m.name || '')) throw new Error(`Data type ${d.name}: bad member "${m.name}"`);
      if (!BASIC_TYPES.includes(m.type) && !p.dataTypes.some((x) => x.name === m.type && x.name !== d.name)) {
        throw new Error(`Data type ${d.name}.${m.name}: members must be BOOL/INT/DINT/REAL or another UDT`);
      }
    }
  }
  for (const a of p.aois) {
    uniq('AOI', a.name);
    a.params = Array.isArray(a.params) ? a.params : [];
    a.locals = Array.isArray(a.locals) ? a.locals : [];
    a.description = typeof a.description === 'string' ? a.description : '';
    for (const x of a.params) {
      if (!NAME_RE.test(x.name || '')) throw new Error(`AOI ${a.name}: bad parameter "${x.name}"`);
      if (!['Input', 'Output'].includes(x.usage)) x.usage = 'Input';
      if (!BASIC_TYPES.includes(x.type)) throw new Error(`AOI ${a.name}.${x.name}: parameters must be BOOL/INT/DINT/REAL`);
    }
    for (const x of a.locals) {
      if (!NAME_RE.test(x.name || '')) throw new Error(`AOI ${a.name}: bad local "${x.name}"`);
      if (!BUILTIN_TYPES.includes(x.type) && !p.dataTypes.some((d) => d.name === x.type)) throw new Error(`AOI ${a.name}.${x.name}: unknown type`);
    }
    validateProgram(a); // a.rungs
  }
  checkTags(p.controllerTags, 'Controller tags');
  for (const row of p.ioConfig) {
    if (!['IN', 'OUT'].includes(row.dir)) throw new Error('I/O config: dir must be IN or OUT');
    row.slot = Number(row.slot) || 0;
    row.channel = Number(row.channel) || 0;
    row.tag = typeof row.tag === 'string' ? row.tag : '';
    if (row.tag && !TAG_RE.test(row.tag)) throw new Error(`I/O config: bad tag "${row.tag}"`);
  }
  for (const t of p.tasks) {
    uniq('Task', t.name);
    t.type = t.type === 'periodic' ? 'periodic' : 'continuous';
    t.period = Math.max(10, Number(t.period) || 100);
    t.programs = Array.isArray(t.programs) ? t.programs : [];
    for (const pr of t.programs) {
      uniq('Program', pr.name);
      pr.tags = Array.isArray(pr.tags) ? pr.tags : [];
      pr.routines = Array.isArray(pr.routines) ? pr.routines : [];
      checkTags(pr.tags, `Program ${pr.name} tags`);
      const rn = new Set();
      for (const r of pr.routines) {
        if (!NAME_RE.test(r.name || '')) throw new Error(`Program ${pr.name}: bad routine name "${r.name}"`);
        if (rn.has(r.name)) throw new Error(`Program ${pr.name}: duplicate routine "${r.name}"`);
        rn.add(r.name);
        validateProgram(r);
        delete r.version;
      }
      if (pr.mainRoutine && !rn.has(pr.mainRoutine)) pr.mainRoutine = pr.routines[0] ? pr.routines[0].name : '';
      if (!pr.mainRoutine && pr.routines[0]) pr.mainRoutine = pr.routines[0].name;
    }
  }
  for (const a of p.aois) delete a.version;
  return p;
}

export function allPrograms(project) {
  return project.tasks.flatMap((t) => t.programs.map((pr) => ({ task: t, program: pr })));
}

export function findProgram(project, name) {
  for (const t of project.tasks) for (const pr of t.programs) if (pr.name === name) return pr;
  return null;
}

function initTags(store, tags, types) {
  for (const t of tags) {
    if (t.type === 'TIMER') store.timers[t.name] = newTimer(Number(t.value && t.value.pre) || 0);
    else if (t.type === 'COUNTER') store.counters[t.name] = newCounter(Number(t.value && t.value.pre) || 0);
    else store.tags[t.name] = makeDefault(t.type, types, t.value);
  }
}

/** Fresh controller memory for a project: controller scope + one scope per program. */
export function initState(project) {
  const types = typesOf(project);
  const st = createState();
  st.programs = {};
  initTags(st, project.controllerTags, types);
  for (const { program } of allPrograms(project)) {
    const s = { tags: {}, timers: {}, counters: {} };
    initTags(s, program.tags, types);
    st.programs[program.name] = s;
  }
  return st;
}

/** Iterate every routine with its location (programs and AOI logic). */
export function forEachRoutine(project, cb) {
  for (const t of project.tasks) for (const pr of t.programs) for (const r of pr.routines) cb(r, { task: t, program: pr, label: `${pr.name}/${r.name}` });
  for (const a of project.aois) cb(a, { aoi: a, label: `AOI:${a.name}` });
}

/**
 * Cross reference: Map key "scope::Base" -> { base, scope, usages: [{ location, rung, text, ref, access }] }
 * scope is 'Controller', a program name, or 'AOI:Name'.
 */
export function crossReference(project) {
  const { aois } = typesOf(project);
  const ctrl = new Set(project.controllerTags.map((t) => t.name));
  const map = new Map();
  const add = (scope, ref, usage) => {
    const base = ref.split('.')[0];
    const key = `${scope}::${base}`;
    if (!map.has(key)) map.set(key, { base, scope, usages: [] });
    map.get(key).usages.push({ ...usage, ref });
  };
  for (const t of project.controllerTags) if (!map.has(`Controller::${t.name}`)) map.set(`Controller::${t.name}`, { base: t.name, scope: 'Controller', usages: [] });
  for (const { program } of allPrograms(project)) for (const t of program.tags) map.set(`${program.name}::${t.name}`, { base: t.name, scope: program.name, usages: [] });
  forEachRoutine(project, (routine, loc) => {
    const local = loc.aoi
      ? new Set(['EnableIn', 'EnableOut', ...loc.aoi.params.map((x) => x.name), ...loc.aoi.locals.map((x) => x.name)])
      : new Set(loc.program.tags.map((t) => t.name));
    const localScope = loc.aoi ? `AOI:${loc.aoi.name}` : loc.program.name;
    forEachInstruction(routine.rungs, (ins, rung) => {
      for (const { ref, access } of instructionRefs(ins, aois)) {
        const base = ref.split('.')[0];
        const scope = local.has(base) ? localScope : 'Controller';
        add(scope, ref, { location: loc.label, program: loc.program ? loc.program.name : null, routine: routine.name, aoi: loc.aoi ? loc.aoi.name : null, rung, instruction: ins.type, access });
      }
    });
  });
  for (const row of project.ioConfig) {
    if (!row.tag) continue;
    add('Controller', row.tag, { location: `I/O ${ioAddress(row)}`, rung: null, instruction: row.dir === 'IN' ? 'Input module' : 'Output module', access: row.dir === 'IN' ? 'write' : 'read' });
  }
  void ctrl;
  return map;
}

/** Warnings for references that are not declared anywhere (they are auto-created as BOOL at runtime). */
export function verifyProject(project) {
  const warnings = [];
  const types = typesOf(project);
  const ctrl = declsOf(project.controllerTags);
  for (const [, entry] of crossReference(project)) {
    if (entry.scope !== 'Controller' || ctrl[entry.base] !== undefined) continue;
    if (entry.usages.length) warnings.push(`Tag "${entry.base}" is not declared (used in ${entry.usages[0].location}); it will be created as a BOOL.`);
  }
  for (const { program } of allPrograms(project)) {
    for (const r of program.routines) {
      forEachInstruction(r.rungs, (ins, rung) => {
        if (ins.type === 'JSR' && !program.routines.some((x) => x.name === ins.routine)) warnings.push(`${program.name}/${r.name} rung ${rung}: JSR to missing routine "${ins.routine}".`);
        if (ins.type === 'AOI' && !types.aois[ins.aoi]) warnings.push(`${program.name}/${r.name} rung ${rung}: unknown AOI "${ins.aoi}".`);
      });
    }
  }
  return warnings;
}

// ------------------------------------------------------------------ compare

/**
 * Differences between two projects (offline vs controller). Returns
 * [{ kind: 'added'|'removed'|'changed', path, offline, online }]
 * "added" = present offline only, "removed" = present in the controller only.
 */
export function compareProjects(offline, online) {
  const diffs = [];
  if (!online) return [{ kind: 'removed', path: 'Controller', offline: 'project', online: '(no project downloaded)' }];
  const cmpList = (path, a, b, keyFn, textFn) => {
    const ma = new Map(a.map((x) => [keyFn(x), x]));
    const mb = new Map(b.map((x) => [keyFn(x), x]));
    for (const [k, x] of ma) {
      if (!mb.has(k)) diffs.push({ kind: 'added', path: `${path} ${k}`, offline: textFn(x), online: '' });
      else if (textFn(x) !== textFn(mb.get(k))) diffs.push({ kind: 'changed', path: `${path} ${k}`, offline: textFn(x), online: textFn(mb.get(k)) });
    }
    for (const [k, x] of mb) if (!ma.has(k)) diffs.push({ kind: 'removed', path: `${path} ${k}`, offline: '', online: textFn(x) });
  };
  // Tag data (initial values, presets) is not logic, so it is not compared: an Upload brings
  // live values back as initial values and should still compare clean.
  const tagText = (t) => `${t.type}${t.description ? ` // ${t.description}` : ''}`;
  const cmpRungs = (path, a, b) => {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const ta = a[i] ? rungText(a[i]) : null;
      const tb = b[i] ? rungText(b[i]) : null;
      if (ta === null) diffs.push({ kind: 'removed', path: `${path} rung ${i}`, offline: '', online: tb });
      else if (tb === null) diffs.push({ kind: 'added', path: `${path} rung ${i}`, offline: ta, online: '' });
      else if (ta !== tb) diffs.push({ kind: 'changed', path: `${path} rung ${i}`, offline: ta, online: tb });
      else if ((a[i].comment || '') !== (b[i].comment || '')) diffs.push({ kind: 'changed', path: `${path} rung ${i} comment`, offline: a[i].comment, online: b[i].comment });
    }
  };
  if (offline.controller.name !== online.controller.name) diffs.push({ kind: 'changed', path: 'Controller name', offline: offline.controller.name, online: online.controller.name });
  cmpList('Controller tag', offline.controllerTags, online.controllerTags, (t) => t.name, tagText);
  cmpList('Data type', offline.dataTypes, online.dataTypes, (d) => d.name, (d) => d.members.map((m) => `${m.name}:${m.type}`).join(', '));
  cmpList('AOI', offline.aois, online.aois, (a) => a.name,
    (a) => `params(${a.params.map((x) => `${x.usage[0]}:${x.name}:${x.type}`).join(',')}) locals(${a.locals.map((x) => `${x.name}:${x.type}`).join(',')})`);
  for (const a of offline.aois) {
    const b = online.aois.find((x) => x.name === a.name);
    if (b) cmpRungs(`AOI ${a.name}`, a.rungs, b.rungs);
  }
  cmpList('I/O', offline.ioConfig, online.ioConfig, (r) => ioAddress(r), (r) => `${r.signal} -> ${r.tag || '(unmapped)'}`);
  const progs = (p) => allPrograms(p).map(({ task, program }) => ({ task, program }));
  cmpList('Task', offline.tasks, online.tasks, (t) => t.name, (t) => `${t.type}${t.type === 'periodic' ? ` ${t.period}ms` : ''}`);
  cmpList('Program', progs(offline), progs(online), (x) => x.program.name, (x) => `task ${x.task.name}, main ${x.program.mainRoutine}`);
  for (const { program: pa } of allPrograms(offline)) {
    const pb = findProgram(online, pa.name);
    if (!pb) continue;
    cmpList(`Program tag ${pa.name}:`, pa.tags, pb.tags, (t) => t.name, tagText);
    cmpList(`Routine ${pa.name}/`, pa.routines, pb.routines, (r) => r.name, (r) => `${r.rungs.length} rungs`);
    for (const ra of pa.routines) {
      const rb = pb.routines.find((x) => x.name === ra.name);
      if (rb) cmpRungs(`${pa.name}/${ra.name}`, ra.rungs, rb.rungs);
    }
  }
  // collapse the "N rungs" summary when rung-level diffs already explain it
  return diffs.filter((d) => !(d.kind === 'changed' && d.path.startsWith('Routine ')));
}

/** Snapshot live values back into tag declarations (used by Upload). */
export function captureValues(project, state) {
  const snap = (t, store) => {
    if (t.type === 'TIMER') { const v = store.timers[t.name]; if (v) t.value = { pre: v.pre }; return; }
    if (t.type === 'COUNTER') { const v = store.counters[t.name]; if (v) t.value = { pre: v.pre }; return; }
    const v = store.tags[t.name];
    if (v === undefined) return;
    if (BASIC_TYPES.includes(t.type)) {
      const def = coerce(t.type, 0);
      if (v !== def) t.value = v; else delete t.value;
    } else if (project.dataTypes.some((d) => d.name === t.type)) t.value = clone(v);
  };
  for (const t of project.controllerTags) snap(t, state);
  for (const { program } of allPrograms(project)) for (const t of program.tags) snap(t, state.programs[program.name] || { tags: {}, timers: {}, counters: {} });
  return project;
}
