import {
  COMPARE_TYPES, MATH_TYPES, OUTPUT_TYPES, INPUT_TYPES, BASIC_TYPES, BUILTIN_TYPES, TAG_RE, isOperand, rungText,
} from './ladder.js';
import {
  migrate, newProject, validateProject, clone, typesOf, allPrograms, findProgram, crossReference, compareProjects,
  verifyProject, ioAddress, defaultIoConfig, allTypeNames,
} from './project.js';
import { Controller } from './controller.js';
import { Factory, TAG_INFO, W, H } from './factory.js';
import { ALL_EXAMPLES, exampleProject } from './examples.js';
import { LadderView, ops } from './editor.js';
import { TourOverlay, Tour } from './tour.js';

const SCAN_MS = 50;
const KEY_PROJECT = 'plc-training:project';
const KEY_CONTROLLER = 'plc-training:controller';
const KEY_LEGACY = 'plc-training:autosave';
const KEY_SAVED = 'plc-training:saved';
const PEN_COLORS = ['#22c55e', '#38bdf8', '#f59e0b', '#f472b6', '#a78bfa', '#facc15'];
const $ = (s) => document.querySelector(s);

// ------------------------------------------------------------------ tiny DOM helper
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
const sel = (options, value, onchange, props = {}) => {
  const s = h('select', { ...props, onchange: (e) => onchange(e.target.value) });
  for (const o of options) {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    s.add(new Option(label, v, false, v === value));
  }
  return s;
};
const input = (value, onchange, props = {}) => h('input', { type: 'text', value: value ?? '', spellcheck: 'false', ...props, onchange: (e) => onchange(e.target.value.trim()), onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
const fmt = (v) => {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (v === undefined) return '—';
  return '{…}';
};

// ------------------------------------------------------------------ app state
let project = newProject();
const controller = new Controller();
const factory = new Factory($('#factory'));
let online = false;
let stepped = false;
let view = { kind: 'controller' };
let selection = null;
let aoiInstance = '';
const trend = { pens: [], data: {}, paused: false, window: 30 };
let xrefSelected = null;
let scanAcc = 0;

const ladder = new LadderView($('#ladder'), (s) => { selection = s; renderLadder(); renderInspector(); });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function persist() {
  try {
    localStorage.setItem(KEY_PROJECT, JSON.stringify(project));
    if (controller.project) localStorage.setItem(KEY_CONTROLLER, JSON.stringify(controller.project));
  } catch { /* quota */ }
}

function syncForces() {
  controller.forces = project.forces;
  controller.forcesEnabled = project.forcesEnabled;
}

/** Apply an edit; if the project no longer validates, roll back and explain. */
function commit(mutate, { rerender = true } = {}) {
  const before = clone(project);
  try {
    mutate();
    validateProject(clone(project));
  } catch (e) {
    project = migrate(before);
    toast(`Not applied: ${e.message}`);
  }
  syncForces();
  persist();
  if (rerender) refresh();
  else updateStatus();
}

// ------------------------------------------------------------------ resolution helpers
const types = () => typesOf(project);
function currentProgram() { return view.program ? findProgram(project, view.program) : null; }
function currentRoutineObj() {
  if (view.kind === 'routine') {
    const pr = currentProgram();
    return pr ? pr.routines.find((r) => r.name === view.routine) || null : null;
  }
  if (view.kind === 'aoi') return project.aois.find((a) => a.name === view.aoi) || null;
  return null;
}
function traceKey() {
  return view.kind === 'routine' ? `${view.program}/${view.routine}` : view.kind === 'aoi' ? `AOI:${view.aoi}` : null;
}
function controllerRoutine() {
  if (!controller.project) return null;
  if (view.kind === 'routine') {
    const pr = findProgram(controller.project, view.program);
    return pr ? pr.routines.find((r) => r.name === view.routine) : null;
  }
  if (view.kind === 'aoi') return controller.project.aois.find((a) => a.name === view.aoi);
  return null;
}
function routineInSync() {
  const a = currentRoutineObj();
  const b = controllerRoutine();
  if (!a || !b) return false;
  return a.rungs.map(rungText).join('\n') === b.rungs.map(rungText).join('\n');
}

/** Expand a declared tag into all its usable references (members, timer bits, AOI params). */
function expandRefs(name, type, t, depth = 0, out = []) {
  out.push(name);
  if (depth > 4) return out;
  if (type === 'TIMER') for (const m of ['EN', 'TT', 'DN', 'PRE', 'ACC']) out.push(`${name}.${m}`);
  else if (type === 'COUNTER') for (const m of ['CU', 'DN', 'PRE', 'ACC']) out.push(`${name}.${m}`);
  else if (t.udts[type]) for (const m of t.udts[type].members) expandRefs(`${name}.${m.name}`, m.type, t, depth + 1, out);
  else if (t.aois[type]) for (const p of ['EnableIn', 'EnableOut', ...t.aois[type].params.map((x) => x.name)]) out.push(`${name}.${p}`);
  return out;
}

function scopeDecls(programName) {
  const d = {};
  for (const tg of project.controllerTags) d[tg.name] = { type: tg.type, scope: 'Controller' };
  const pr = programName && findProgram(project, programName);
  if (pr) for (const tg of pr.tags) d[tg.name] = { type: tg.type, scope: pr.name };
  return d;
}

function renderTagList() {
  const t = types();
  const refs = new Set();
  if (view.kind === 'aoi') {
    const a = project.aois.find((x) => x.name === view.aoi);
    if (a) {
      refs.add('EnableIn');
      for (const p of a.params) refs.add(p.name);
      for (const l of a.locals) expandRefs(l.name, l.type, t).forEach((r) => refs.add(r));
    }
  } else {
    const d = scopeDecls(view.program);
    for (const [n, { type }] of Object.entries(d)) expandRefs(n, type, t).forEach((r) => refs.add(r));
  }
  $('#tag-list').replaceChildren(...[...refs].map((r) => new Option(TAG_INFO[r] || '', r)));
}

/** Live read function for the current view, or null when offline. */
function liveReader() {
  if (!online || !controller.project) return null;
  if (view.kind === 'aoi') {
    const a = project.aois.find((x) => x.name === view.aoi);
    const local = new Set(['EnableIn', 'EnableOut', ...(a ? [...a.params, ...a.locals].map((x) => x.name) : [])]);
    return (ref) => {
      const base = ref.split('.')[0];
      if (local.has(base)) return aoiInstance ? controller.read(`${aoiInstance}.${ref}`) : undefined;
      return controller.read(ref);
    };
  }
  return (ref) => controller.read(ref, view.program);
}

// ------------------------------------------------------------------ status bar
function diffs() { return controller.project ? compareProjects(project, controller.project) : null; }

function updateStatus() {
  const m = controller.mode;
  const badge = $('#mode');
  badge.textContent = controller.fault ? 'FAULTED' : m === 'run' ? 'RUN' : stepped ? 'STEP' : 'PROGRAM';
  badge.className = 'mode ' + (controller.fault ? 'fault' : m === 'run' ? 'run' : stepped ? 'step' : 'stop');
  $('#btn-run').disabled = m === 'run' || !controller.project;
  $('#btn-step').disabled = m === 'run' || !controller.project;
  $('#btn-upload').disabled = !controller.project;
  $('#btn-online').textContent = online ? 'Go Offline' : 'Go Online';
  $('#online-badge').textContent = online ? 'ONLINE' : 'OFFLINE';
  $('#online-badge').className = 'badge ' + (online ? 'online' : 'offline');

  const d = diffs();
  const sb = $('#sync-badge');
  if (!d) { sb.textContent = 'Controller empty'; sb.className = 'badge warn'; }
  else if (d.length === 0) { sb.textContent = '✓ In sync'; sb.className = 'badge ok'; }
  else { sb.textContent = `≠ ${d.length} offline change${d.length > 1 ? 's' : ''} not downloaded`; sb.className = 'badge warn'; }

  const n = Object.keys(project.forces).length;
  const fb = $('#forces-badge');
  if (project.forcesEnabled && n) { fb.textContent = `⚠ FORCES ACTIVE (${n})`; fb.className = 'badge forces-active'; }
  else if (n) { fb.textContent = `Forces installed (${n}), disabled`; fb.className = 'badge forces-installed'; }
  else { fb.textContent = project.forcesEnabled ? 'Forces enabled · none installed' : 'No forces'; fb.className = 'badge'; }
  $('#btn-forces').textContent = project.forcesEnabled ? 'Disable forces' : 'Enable forces';
  document.body.classList.toggle('forces-on', project.forcesEnabled && n > 0);

  const banner = $('#banner');
  banner.replaceChildren();
  if (controller.fault) {
    banner.append(h('b', {}, 'Controller faulted: '), controller.fault, ' ',
      h('button', { class: 'btn small', onclick: () => { controller.clearFault(); refresh(); } }, 'Clear fault'));
    banner.className = 'banner fault';
    banner.hidden = false;
  } else if (online && (!d || d.length)) {
    banner.append(!d ? 'The controller has no project. ' : `Online, but the offline project differs from the controller (${d.length} difference${d.length > 1 ? 's' : ''}). Live highlighting is shown only for routines that match. `,
      h('button', { class: 'btn small', onclick: doDownload }, '⬇ Download'), ' ',
      d ? h('button', { class: 'btn small', onclick: doUpload }, '⬆ Upload') : null, ' ',
      d ? h('button', { class: 'btn small', onclick: () => setView({ kind: 'compare' }) }, 'Compare') : null);
    banner.className = 'banner warn';
    banner.hidden = false;
  } else banner.hidden = true;
}

// ------------------------------------------------------------------ project tree
function setView(v) {
  view = v;
  selection = v.kind === 'routine' || v.kind === 'aoi' ? { r: v.rung ?? 0, kind: 'rung' } : null;
  if (v.kind === 'aoi') {
    const inst = project.controllerTags.find((t) => t.type === v.aoi);
    aoiInstance = inst ? inst.name : '';
  }
  refresh();
  if (v.rung !== undefined) {
    const node = document.getElementById(`rung-${v.rung}`);
    if (node) node.scrollIntoView({ block: 'center' });
  }
}

function renderTree() {
  const same = (v) => JSON.stringify({ ...v, rung: undefined, filter: undefined }) === JSON.stringify({ ...view, rung: undefined, filter: undefined });
  const item = (label, v, cls = '') => h('div', { class: `ti ${cls} ${v && same(v) ? 'active' : ''}`, onclick: v ? () => setView(v) : null }, label);
  const group = (label, kids, addBtn) => h('div', { class: 'tg' }, h('div', { class: 'tg-head' }, label, addBtn), h('div', { class: 'tg-kids' }, kids));
  const add = (title, fn) => h('button', { class: 'tadd', title, onclick: (e) => { e.stopPropagation(); fn(); } }, '+');

  const tasks = project.tasks.map((t) => group(
    item(h('span', {}, '⏱ ', t.name, h('small', {}, t.type === 'periodic' ? ` periodic ${t.period}ms` : ' continuous')), { kind: 'task', task: t.name }, 'task'),
    t.programs.map((pr) => group(
      item(h('span', {}, '▣ ', pr.name), { kind: 'program', program: pr.name }, 'program'),
      [
        item(h('span', {}, '🏷 Program Tags'), { kind: 'tags', scope: pr.name }, 'leaf'),
        ...pr.routines.map((r) => item(h('span', {}, '≡ ', r.name, r.name === pr.mainRoutine ? h('small', { class: 'main' }, ' main') : ''), { kind: 'routine', program: pr.name, routine: r.name }, 'leaf')),
      ],
      add('Add routine', () => addRoutine(pr.name)),
    )),
    add('Add program to this task', () => addProgram(t.name)),
  ));

  $('#tree').replaceChildren(
    group(item(h('span', {}, '🖥 Controller ', h('b', {}, project.controller.name)), { kind: 'controller' }, 'root'), [
      item('🏷 Controller Tags', { kind: 'tags', scope: 'Controller' }, 'leaf'),
      item('🔌 I/O Configuration', { kind: 'io' }, 'leaf'),
    ]),
    group(h('span', {}, 'Tasks'), tasks, add('Add task', addTask)),
    group(h('span', {}, 'Data Types (UDT)'), project.dataTypes.map((d) => item(`◇ ${d.name}`, { kind: 'udt', udt: d.name }, 'leaf')), add('Add data type', addUdt)),
    group(h('span', {}, 'Add-On Instructions'), project.aois.map((a) => item(`🧩 ${a.name}`, { kind: 'aoi', aoi: a.name }, 'leaf')), add('Add AOI', addAoi)),
    group(h('span', {}, 'Tools'), [
      item('⇄ Cross Reference', { kind: 'xref' }, 'leaf'),
      item('📈 Trend', { kind: 'trend' }, 'leaf'),
      item('≠ Compare', { kind: 'compare' }, 'leaf'),
    ]),
  );
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function askName(what, def) {
  const n = window.prompt(`${what} name`, def);
  if (n === null) return null;
  if (!NAME_RE.test(n.trim())) { toast('Names: letters, digits and _; must not start with a digit'); return null; }
  return n.trim();
}
function uniqueName(base, taken) {
  let i = 1;
  while (taken.includes(`${base}${i}`)) i++;
  return `${base}${i}`;
}
function addTask() {
  const n = askName('Task', uniqueName('Task', project.tasks.map((t) => t.name)));
  if (!n) return;
  commit(() => project.tasks.push({ name: n, type: 'periodic', period: 500, programs: [] }));
  setView({ kind: 'task', task: n });
}
function addProgram(task) {
  const n = askName('Program', uniqueName('Program', allPrograms(project).map((x) => x.program.name)));
  if (!n) return;
  commit(() => project.tasks.find((t) => t.name === task).programs.push({ name: n, mainRoutine: 'MainRoutine', tags: [], routines: [{ name: 'MainRoutine', rungs: [{ comment: '', logic: [], outputs: [] }] }] }));
  setView({ kind: 'program', program: n });
}
function addRoutine(program) {
  const pr = findProgram(project, program);
  const n = askName('Routine', uniqueName('Routine', pr.routines.map((r) => r.name)));
  if (!n) return;
  commit(() => findProgram(project, program).routines.push({ name: n, rungs: [{ comment: '', logic: [], outputs: [] }] }));
  setView({ kind: 'routine', program, routine: n });
}
function addUdt() {
  const n = askName('Data type', uniqueName('UDT', project.dataTypes.map((d) => d.name)));
  if (!n) return;
  commit(() => project.dataTypes.push({ name: n, description: '', members: [{ name: 'Value', type: 'REAL' }] }));
  setView({ kind: 'udt', udt: n });
}
function addAoi() {
  const n = askName('Add-On Instruction', uniqueName('AOI', project.aois.map((a) => a.name)));
  if (!n) return;
  commit(() => project.aois.push({ name: n, description: '', params: [{ name: 'In', usage: 'Input', type: 'BOOL' }, { name: 'Out', usage: 'Output', type: 'BOOL' }], locals: [], rungs: [{ comment: '', logic: [{ type: 'NO', tag: 'In' }], outputs: [{ type: 'OTE', tag: 'Out' }] }] }));
  setView({ kind: 'aoi', aoi: n });
}

// ------------------------------------------------------------------ center views
function refresh() {
  if (!resolveView()) view = { kind: 'controller' };
  renderTree();
  renderTagList();
  const isLadder = view.kind === 'routine' || view.kind === 'aoi';
  $('#ladder-area').hidden = !isLadder;
  $('#view-head').replaceChildren();
  $('#view-body').replaceChildren();
  ({
    controller: viewController, task: viewTask, program: viewProgram, routine: viewRoutine, aoi: viewAoi,
    tags: viewTags, udt: viewUdt, io: viewIo, xref: viewXref, trend: viewTrend, compare: viewCompare,
  }[view.kind] || viewController)();
  if (isLadder) { renderLadder(); renderInspector(); }
  updateStatus();
  updateLive(true);
}

function resolveView() {
  switch (view.kind) {
    case 'task': return project.tasks.some((t) => t.name === view.task);
    case 'program': return !!currentProgram();
    case 'routine': return !!currentProgram() && !!currentRoutineObj();
    case 'aoi': return !!currentRoutineObj();
    case 'udt': return project.dataTypes.some((d) => d.name === view.udt);
    case 'tags': return view.scope === 'Controller' || !!findProgram(project, view.scope);
    default: return true;
  }
}

const head = (...kids) => $('#view-head').append(h('div', { class: 'vh' }, ...kids));
const body = (...kids) => $('#view-body').append(...kids);
const field = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el);
const link = (text, v) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); setView(v); } }, text);

function viewController() {
  head(h('h2', {}, '🖥 Controller'));
  const warnings = verifyProject(project);
  body(
    h('div', { class: 'form' },
      field('Controller name', input(project.controller.name, (v) => commit(() => { if (!NAME_RE.test(v)) throw new Error('bad name'); project.controller.name = v; }))),
      field('Project name', input(project.name, (v) => commit(() => { project.name = v || 'Untitled'; })))),
    h('p', { class: 'muted' }, 'A simulated Logix-style controller. Continuous tasks run every 50 ms scan; periodic tasks run at their period. Each program runs its main routine, which can call other routines with JSR. ',
      'Edit offline, then Download to the controller. Go Online to watch live values.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: addTask }, '+ Task'),
      h('button', { class: 'btn', onclick: addUdt }, '+ Data type'),
      h('button', { class: 'btn', onclick: addAoi }, '+ Add-On Instruction')),
    h('h3', {}, 'Tasks'),
    h('table', { class: 'grid' }, h('tr', {}, h('th', {}, 'Task'), h('th', {}, 'Type'), h('th', {}, 'Programs')),
      project.tasks.map((t) => h('tr', {}, h('td', {}, link(t.name, { kind: 'task', task: t.name })),
        h('td', {}, t.type === 'periodic' ? `periodic, ${t.period} ms` : 'continuous'), h('td', {}, t.programs.map((p) => p.name).join(', '))))),
    h('h3', {}, 'Verify'),
    warnings.length ? h('ul', { class: 'warnings' }, warnings.map((w) => h('li', {}, '⚠ ', w))) : h('p', { class: 'ok' }, '✓ No errors or warnings.'),
  );
}

function viewTask() {
  const t = project.tasks.find((x) => x.name === view.task);
  const name = t.name;
  const T = () => project.tasks.find((x) => x.name === name);
  head(h('h2', {}, '⏱ Task ', t.name));
  body(
    h('div', { class: 'form' },
      field('Name', input(t.name, (v) => commit(() => { T().name = v; view.task = v; }))),
      field('Type', sel([['continuous', 'Continuous'], ['periodic', 'Periodic']], t.type, (v) => commit(() => { T().type = v; }))),
      t.type === 'periodic' ? field('Period (ms)', h('input', { type: 'number', min: 10, step: 10, value: t.period, onchange: (e) => commit(() => { T().period = Math.max(10, Number(e.target.value) || 100); }) })) : null),
    h('p', { class: 'muted' }, t.type === 'periodic' ? `Programs in this task run every ${t.period} ms; timers inside advance by the period.` : 'Programs in this task run every controller scan.'),
    h('h3', {}, 'Programs'),
    h('ul', {}, t.programs.map((p) => h('li', {}, link(p.name, { kind: 'program', program: p.name })))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => addProgram(t.name) }, '+ Program'),
      h('button', { class: 'btn danger', onclick: () => { if (project.tasks.length < 2) return toast('A project needs at least one task'); if (confirm(`Delete task ${name} and its programs?`)) { commit(() => { project.tasks = project.tasks.filter((x) => x.name !== name); }); setView({ kind: 'controller' }); } } }, 'Delete task')),
  );
}

function viewProgram() {
  const pr = currentProgram();
  const name = pr.name;
  const P = () => findProgram(project, name);
  const taskOf = () => project.tasks.find((t) => t.programs.some((x) => x.name === name));
  head(h('h2', {}, '▣ Program ', pr.name));
  body(
    h('div', { class: 'form' },
      field('Name', input(pr.name, (v) => commit(() => { if (findProgram(project, v) && v !== name) throw new Error('duplicate program'); P().name = v; view.program = v; }))),
      field('Main routine', sel(pr.routines.map((r) => r.name), pr.mainRoutine, (v) => commit(() => { P().mainRoutine = v; }))),
      field('Task', sel(project.tasks.map((t) => t.name), taskOf().name, (v) => commit(() => { const tk = taskOf(); const p = P(); tk.programs = tk.programs.filter((x) => x !== p); project.tasks.find((t) => t.name === v).programs.push(p); })))),
    h('h3', {}, 'Routines'),
    h('ul', {}, pr.routines.map((r) => h('li', {}, link(r.name, { kind: 'routine', program: pr.name, routine: r.name }), r.name === pr.mainRoutine ? ' (main)' : '', ` · ${r.rungs.length} rungs`))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => addRoutine(name) }, '+ Routine'),
      h('button', { class: 'btn', onclick: () => setView({ kind: 'tags', scope: name }) }, 'Program tags'),
      h('button', { class: 'btn danger', onclick: () => { if (confirm(`Delete program ${name}?`)) { commit(() => { const tk = taskOf(); tk.programs = tk.programs.filter((x) => x.name !== name); }); setView({ kind: 'controller' }); } } }, 'Delete program')),
  );
}

function renameRoutine(oldName, v) {
  commit(() => {
    const pr = currentProgram();
    const r = pr.routines.find((x) => x.name === oldName);
    if (!NAME_RE.test(v)) throw new Error('bad routine name');
    if (pr.routines.some((x) => x.name === v && x !== r)) throw new Error('duplicate routine');
    for (const rr of pr.routines) for (const rung of rr.rungs) for (const o of rung.outputs) if (o.type === 'JSR' && o.routine === oldName) o.routine = v;
    if (pr.mainRoutine === oldName) pr.mainRoutine = v;
    r.name = v;
    view.routine = v;
  });
}

function viewRoutine() {
  const pr = currentProgram();
  const r = currentRoutineObj();
  const isMain = pr.mainRoutine === r.name;
  const pname = pr.name, rname = r.name;
  head(h('h2', {}, '≡ ', pr.name, ' / ', r.name, isMain ? h('span', { class: 'pill' }, 'MAIN') : h('span', { class: 'pill dim' }, 'subroutine (runs via JSR)')),
    h('div', { class: 'row' },
      field('Name', input(r.name, (v) => renameRoutine(rname, v), { size: 14 })),
      !isMain ? h('button', { class: 'btn small', onclick: () => commit(() => { findProgram(project, pname).mainRoutine = rname; }) }, 'Make main') : null,
      h('button', { class: 'btn small danger', onclick: () => { if (pr.routines.length < 2) return toast('A program needs at least one routine'); if (confirm(`Delete routine ${rname}?`)) { commit(() => { const p = findProgram(project, pname); p.routines = p.routines.filter((x) => x.name !== rname); }); setView({ kind: 'program', program: pname }); } } }, 'Delete routine'),
      h('span', { id: 'sync-note', class: 'muted small' })));
}

function walkInstr(rung, cb) {
  const walk = (s) => { for (const it of s) { if (it.type === 'BRANCH') it.legs.forEach(walk); else cb(it); } };
  walk(rung.logic);
  rung.outputs.forEach(cb);
}

function renameAoiMember(a, m, v) {
  if (!NAME_RE.test(v)) throw new Error('bad name');
  const old = m.name;
  m.name = v;
  const fix = (s) => (s === old ? v : s && s.startsWith(`${old}.`) ? v + s.slice(old.length) : s);
  for (const rung of a.rungs) walkInstr(rung, (ins) => { for (const k of ['tag', 'a', 'b', 'src', 'dest']) if (typeof ins[k] === 'string') ins[k] = fix(ins[k]); });
  for (const { program } of allPrograms(project)) for (const r of program.routines) for (const rung of r.rungs) for (const o of rung.outputs) {
    if (o.type === 'AOI' && o.aoi === a.name && o.args && old in o.args) { o.args[v] = o.args[old]; delete o.args[old]; }
  }
}

function renameAoi(a, v) {
  commit(() => {
    if (!NAME_RE.test(v)) throw new Error('bad name');
    const old = a.name;
    a.name = v;
    for (const tg of [...project.controllerTags, ...allPrograms(project).flatMap((x) => x.program.tags)]) if (tg.type === old) tg.type = v;
    for (const { program } of allPrograms(project)) for (const r of program.routines) for (const rung of r.rungs) for (const o of rung.outputs) if (o.type === 'AOI' && o.aoi === old) o.aoi = v;
    view.aoi = v;
  });
}

function viewAoi() {
  const a = currentRoutineObj();
  const udtNames = project.dataTypes.map((d) => d.name);
  const instances = project.controllerTags.filter((x) => x.type === a.name).map((x) => x.name);
  for (const { program } of allPrograms(project)) for (const x of program.tags) if (x.type === a.name) instances.push(`${program.name}:${x.name}`);
  const paramRows = a.params.map((p, i) => h('tr', {},
    h('td', {}, input(p.name, (v) => commit(() => renameAoiMember(a, p, v)), { size: 12 })),
    h('td', {}, sel(['Input', 'Output'], p.usage, (v) => commit(() => { p.usage = v; }))),
    h('td', {}, sel(BASIC_TYPES, p.type, (v) => commit(() => { p.type = v; }))),
    h('td', {}, h('button', { class: 'btn small ghost', onclick: () => commit(() => a.params.splice(i, 1)) }, '✕'))));
  const localRows = a.locals.map((l, i) => h('tr', {},
    h('td', {}, input(l.name, (v) => commit(() => renameAoiMember(a, l, v)), { size: 12 })),
    h('td', {}, sel([...BUILTIN_TYPES, ...udtNames], l.type, (v) => commit(() => { l.type = v; }))),
    h('td', {}, h('button', { class: 'btn small ghost', onclick: () => commit(() => a.locals.splice(i, 1)) }, '✕'))));
  head(h('h2', {}, '🧩 Add-On Instruction ', a.name),
    h('div', { class: 'aoi-def' },
      h('div', { class: 'form' },
        field('Name', input(a.name, (v) => renameAoi(a, v), { size: 14 })),
        field('Description', input(a.description, (v) => commit(() => { a.description = v; }), { size: 50 }))),
      h('div', { class: 'aoi-tables' },
        h('div', {}, h('h3', {}, 'Parameters'), h('table', { class: 'grid' }, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Usage'), h('th', {}, 'Type'), h('th', {})), paramRows),
          h('button', { class: 'btn small', onclick: () => commit(() => a.params.push({ name: uniqueName('Param', a.params.map((x) => x.name)), usage: 'Input', type: 'BOOL' })) }, '+ Parameter')),
        h('div', {}, h('h3', {}, 'Local tags'), h('table', { class: 'grid' }, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {})), localRows),
          h('button', { class: 'btn small', onclick: () => commit(() => a.locals.push({ name: uniqueName('Local', a.locals.map((x) => x.name)), type: 'BOOL' })) }, '+ Local tag'))),
      h('div', { class: 'row' },
        h('span', { class: 'muted' }, `Instances: ${instances.join(', ') || 'none'}.`),
        online ? field('Live values from', sel(['', ...project.controllerTags.filter((x) => x.type === a.name).map((x) => x.name)], aoiInstance, (v) => { aoiInstance = v; highlightLadder(); })) : null,
        h('button', { class: 'btn small', onclick: () => { const n = askName('Instance tag', uniqueName(`${a.name}_`, project.controllerTags.map((x) => x.name))); if (n) commit(() => project.controllerTags.push({ name: n, type: a.name, description: `${a.name} instance` })); } }, '+ Instance tag'),
        h('button', { class: 'btn small danger', onclick: () => { if (confirm(`Delete AOI ${a.name}?`)) { const nm = a.name; commit(() => { project.aois = project.aois.filter((x) => x.name !== nm); }); setView({ kind: 'controller' }); } } }, 'Delete AOI'),
        h('span', { id: 'sync-note', class: 'muted small' })),
      h('p', { class: 'muted small' }, 'The logic below runs when the calling rung is true (EnableIn). Input parameters are copied in first and Output parameters are copied out after. Local tags are private to each instance. Highlighting shows the most recently executed instance.')));
}

// ---------------- tags
function renameTag(list, tg, v, pr) {
  if (!NAME_RE.test(v)) throw new Error('bad tag name');
  if (list.some((x) => x.name === v && x !== tg)) throw new Error('duplicate tag');
  const old = tg.name;
  tg.name = v;
  const fix = (s) => (s === old ? v : s && s.startsWith(`${old}.`) ? v + s.slice(old.length) : s);
  const programs = pr ? [pr] : allPrograms(project).map((x) => x.program).filter((p) => !p.tags.some((x) => x.name === old));
  for (const p of programs) for (const r of p.routines) for (const rung of r.rungs) walkInstr(rung, (ins) => {
    for (const k of ['tag', 'a', 'b', 'src', 'dest']) if (typeof ins[k] === 'string') ins[k] = fix(ins[k]);
    if (ins.args) for (const k of Object.keys(ins.args)) ins.args[k] = fix(ins.args[k]);
  });
  if (!pr) {
    for (const row of project.ioConfig) row.tag = fix(row.tag);
    for (const k of Object.keys(project.forces)) { const nk = fix(k); if (nk !== k) { project.forces[nk] = project.forces[k]; delete project.forces[k]; } }
  }
}

function liveCell(ref, type, pr) {
  const td = h('td', { class: 'live nowrap' }, h('span', { dataset: { live: ref, scope: pr ? pr.name : '' } }, '—'));
  if (type === 'BOOL') {
    td.append(' ', h('button', { class: 'btn small ghost', title: 'Toggle the bit in the running controller', disabled: !online || !controller.project, onclick: () => { controller.toggle(ref, pr ? pr.name : null); updateLive(true); } }, 'Toggle'));
  }
  return td;
}

function forceCell(ref, type, isCtrl) {
  if (!isCtrl || !BASIC_TYPES.includes(type)) return h('td', { class: 'muted' }, '');
  const has = Object.prototype.hasOwnProperty.call(project.forces, ref);
  const cur = has ? project.forces[ref] : undefined;
  const setForce = (v) => commit(() => {
    if (v === '' || v === undefined) delete project.forces[ref];
    else project.forces[ref] = v;
  });
  if (type === 'BOOL') {
    return h('td', { class: has ? 'forced' : '' }, sel([['', '—'], ['1', 'Force ON'], ['0', 'Force OFF']], has ? (cur ? '1' : '0') : '', (v) => setForce(v === '' ? '' : v === '1'), { 'aria-label': `Force ${ref}` }));
  }
  return h('td', { class: has ? 'forced' : '' }, input(has ? cur : '', (v) => { if (v !== '' && !isFinite(Number(v))) return toast('Force value must be a number'); setForce(v === '' ? '' : Number(v)); }, { size: 6, placeholder: 'no force' }));
}

function viewTags() {
  const scope = view.scope;
  const pr = scope === 'Controller' ? null : findProgram(project, scope);
  const list = pr ? pr.tags : project.controllerTags;
  const t = types();
  const typeNames = allTypeNames(project);
  const isCtrl = !pr;
  const n = Object.keys(project.forces).length;
  const xmap = crossReference(project);
  head(h('h2', {}, '🏷 ', isCtrl ? 'Controller Tags' : `Program Tags: ${pr.name}`),
    h('div', { class: 'row' },
      field('Scope', sel(['Controller', ...allPrograms(project).map((x) => x.program.name)], scope, (v) => setView({ kind: 'tags', scope: v }))),
      h('button', { class: 'btn small', onclick: () => { const nm = askName('Tag', uniqueName('Tag', list.map((x) => x.name))); if (nm) commit(() => list.push({ name: nm, type: 'BOOL', description: '' })); } }, '+ New tag'),
      h('button', { class: 'btn small', onclick: () => commit(() => { project.forcesEnabled = !project.forcesEnabled; }) }, project.forcesEnabled ? 'Disable forces' : 'Enable forces'),
      n ? h('button', { class: 'btn small danger', onclick: () => commit(() => { project.forces = {}; }) }, `Remove all forces (${n})`) : null,
      h('span', { class: 'muted small' }, online ? 'Live values update while online. Toggle writes the running controller.' : 'Go online to see live values and toggle bits.')));

  const rows = [];
  const memberRows = (ref, type, depth) => {
    const out = [];
    const sub = [];
    if (type === 'TIMER') for (const m of ['PRE', 'ACC', 'EN', 'TT', 'DN']) sub.push([m, ['PRE', 'ACC'].includes(m) ? 'DINT' : 'BOOL']);
    else if (type === 'COUNTER') for (const m of ['PRE', 'ACC', 'CU', 'DN']) sub.push([m, ['PRE', 'ACC'].includes(m) ? 'DINT' : 'BOOL']);
    else if (t.udts[type]) for (const m of t.udts[type].members) sub.push([m.name, m.type]);
    else if (t.aois[type]) for (const p of [{ name: 'EnableIn', type: 'BOOL' }, { name: 'EnableOut', type: 'BOOL' }, ...t.aois[type].params]) sub.push([p.name, p.type]);
    for (const [m, mt] of sub) {
      const r = `${ref}.${m}`;
      out.push(h('tr', { class: 'member' },
        h('td', { style: `padding-left:${12 + depth * 14}px` }, `.${m}`), h('td', { class: 'muted' }, mt), h('td', {}), h('td', {}),
        liveCell(r, mt, pr), forceCell(r, mt, isCtrl), h('td', {})));
      if (!BASIC_TYPES.includes(mt)) out.push(...memberRows(r, mt, depth + 1));
    }
    return out;
  };
  list.forEach((tg, i) => {
    const basic = BASIC_TYPES.includes(tg.type);
    const timerLike = tg.type === 'TIMER' || tg.type === 'COUNTER';
    const key = `${isCtrl ? 'Controller' : pr.name}::${tg.name}`;
    const xr = xmap.get(key);
    rows.push(h('tr', {},
      h('td', {}, input(tg.name, (v) => commit(() => renameTag(list, tg, v, pr)), { size: 14 })),
      h('td', {}, sel(typeNames, tg.type, (v) => commit(() => { tg.type = v; delete tg.value; }))),
      h('td', {}, basic ? (tg.type === 'BOOL'
        ? sel([['0', '0'], ['1', '1']], tg.value ? '1' : '0', (v) => commit(() => { if (v === '1') tg.value = true; else delete tg.value; }))
        : input(tg.value ?? 0, (v) => commit(() => { if (!isFinite(Number(v))) throw new Error('not a number'); tg.value = Number(v); }), { size: 6 }))
        : timerLike ? input(tg.value && tg.value.pre ? tg.value.pre : '', (v) => commit(() => { tg.value = { pre: Number(v) || 0 }; }), { size: 6, placeholder: 'PRE' }) : h('span', { class: 'muted' }, 'struct')),
      h('td', {}, input(tg.description, (v) => commit(() => { tg.description = v; }), { size: 22 })),
      liveCell(tg.name, tg.type, pr),
      forceCell(tg.name, tg.type, isCtrl),
      h('td', { class: 'nowrap' },
        h('button', { class: 'btn small ghost', title: 'Cross reference', onclick: () => { xrefSelected = key; setView({ kind: 'xref' }); } }, `⇄ ${xr ? xr.usages.length : 0}`),
        basic || timerLike ? h('button', { class: 'btn small ghost', title: 'Add to trend', onclick: () => addPen(timerLike ? `${tg.name}.ACC` : tg.name, pr ? pr.name : null) }, '📈') : null,
        h('button', { class: 'btn small ghost', title: 'Delete tag', onclick: () => commit(() => list.splice(i, 1)) }, '✕'))));
    if (!basic) rows.push(...memberRows(tg.name, tg.type, 1));
  });
  body(h('table', { class: 'grid tags' },
    h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Data type'), h('th', {}, 'Initial'), h('th', {}, 'Description'), h('th', {}, 'Live value'), h('th', { id: 'force-col' }, isCtrl ? 'Force' : 'Force (controller scope only)'), h('th', {})),
    rows));
}

// ---------------- UDTs
function viewUdt() {
  const d = project.dataTypes.find((x) => x.name === view.udt);
  const others = project.dataTypes.filter((x) => x !== d).map((x) => x.name);
  head(h('h2', {}, '◇ Data Type ', d.name));
  body(
    h('div', { class: 'form' },
      field('Name', input(d.name, (v) => commit(() => {
        if (!NAME_RE.test(v)) throw new Error('bad name');
        const old = d.name;
        d.name = v;
        for (const tg of [...project.controllerTags, ...allPrograms(project).flatMap((x) => x.program.tags)]) if (tg.type === old) tg.type = v;
        for (const o of project.dataTypes) for (const m of o.members) if (m.type === old) m.type = v;
        for (const a of project.aois) for (const l of a.locals) if (l.type === old) l.type = v;
        view.udt = v;
      }), { size: 16 })),
      field('Description', input(d.description || '', (v) => commit(() => { d.description = v; }), { size: 40 }))),
    h('table', { class: 'grid' }, h('tr', {}, h('th', {}, 'Member'), h('th', {}, 'Data type'), h('th', {})),
      d.members.map((m, i) => h('tr', {},
        h('td', {}, input(m.name, (v) => commit(() => { if (!NAME_RE.test(v)) throw new Error('bad member name'); m.name = v; }), { size: 16 })),
        h('td', {}, sel([...BASIC_TYPES, ...others], m.type, (v) => commit(() => { m.type = v; }))),
        h('td', {}, h('button', { class: 'btn small ghost', onclick: () => commit(() => d.members.splice(i, 1)) }, '✕'))))),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: () => commit(() => d.members.push({ name: uniqueName('Member', d.members.map((x) => x.name)), type: 'BOOL' })) }, '+ Member'),
      h('button', { class: 'btn small danger', onclick: () => { if (confirm(`Delete data type ${d.name}?`)) { const nm = d.name; commit(() => { project.dataTypes = project.dataTypes.filter((x) => x.name !== nm); }); setView({ kind: 'controller' }); } } }, 'Delete data type')),
    h('p', { class: 'muted' }, `Use members with dot syntax: a tag "Tank" of type ${d.name} gives ${d.members[0] ? `Tank.${d.members[0].name}` : 'Tank.Member'}. Changes take effect after Download.`),
  );
}

// ---------------- I/O configuration
function viewIo() {
  head(h('h2', {}, '🔌 I/O Configuration'),
    h('p', { class: 'muted' }, 'Each field device is wired to a module channel, and each channel is mapped to a tag. Input channels are copied to their tags at the start of every scan; output tags are copied to the field at the end. Changes take effect after Download.'));
  const rows = project.ioConfig.map((row, i) => h('tr', {},
    h('td', {}, row.slot), h('td', {}, row.module), h('td', {}, row.channel), h('td', { class: 'mono' }, ioAddress(row)),
    h('td', {}, h('span', { class: `pill ${row.dir === 'IN' ? 'in' : 'out'}` }, row.dir)),
    h('td', { class: 'mono', title: TAG_INFO[row.signal] || '' }, row.signal),
    h('td', {}, input(row.tag, (v) => commit(() => { if (v && !TAG_RE.test(v)) throw new Error('bad tag'); project.ioConfig[i].tag = v; }), { list: 'tag-list', size: 18, placeholder: '(unmapped)' })),
    h('td', { class: 'live' }, h('span', { dataset: { field: row.signal, dir: row.dir } }, '—')),
    h('td', { class: 'live' }, row.tag ? h('span', { dataset: { live: row.tag, scope: '' } }, '—') : '')));
  body(h('table', { class: 'grid' },
    h('tr', {}, h('th', {}, 'Slot'), h('th', {}, 'Module'), h('th', {}, 'Ch'), h('th', {}, 'Address'), h('th', {}, 'Dir'), h('th', {}, 'Field device'), h('th', {}, 'Tag'), h('th', {}, 'Field'), h('th', {}, 'Tag value')),
    rows),
  h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => commit(() => { project.ioConfig = defaultIoConfig(); }) }, 'Reset to default mapping')));
}

// ---------------- cross reference
function viewXref() {
  const map = crossReference(project);
  const filter = (view.filter || '').toLowerCase();
  const entries = [...map.entries()].filter(([k]) => k.toLowerCase().includes(filter)).sort((a, b) => a[0].localeCompare(b[0]));
  if (!xrefSelected || !map.has(xrefSelected)) xrefSelected = entries[0] ? entries[0][0] : null;
  head(h('h2', {}, '⇄ Cross Reference'),
    h('div', { class: 'row' }, field('Filter', input(view.filter || '', (v) => { view.filter = v; refresh(); }, { placeholder: 'tag name' })),
      h('span', { class: 'muted small' }, 'Every place a tag is read or written, including I/O module mappings.')));
  const list = h('div', { class: 'xref-list' }, entries.map(([k, e]) => {
    const w = e.usages.filter((u) => u.access === 'write').length;
    const r = e.usages.length - w;
    return h('div', { class: `ti ${k === xrefSelected ? 'active' : ''}`, onclick: () => { xrefSelected = k; refresh(); } },
      h('span', { class: 'mono' }, e.base), ' ', h('small', { class: 'muted' }, e.scope), ' ',
      h('small', { class: e.usages.length ? '' : 'warn' }, e.usages.length ? `R${r} W${w}` : 'unused'));
  }));
  const s = xrefSelected && map.get(xrefSelected);
  const detail = h('div', { class: 'xref-detail' },
    s ? [
      h('h3', {}, `${s.base} `, h('small', {}, `(${s.scope} scope)`)),
      s.usages.length ? h('table', { class: 'grid' },
        h('tr', {}, h('th', {}, 'Location'), h('th', {}, 'Rung'), h('th', {}, 'Instruction'), h('th', {}, 'Reference'), h('th', {}, 'Access')),
        s.usages.map((u) => h('tr', {},
          h('td', {}, u.rung !== null ? link(u.location, u.aoi ? { kind: 'aoi', aoi: u.aoi, rung: u.rung } : { kind: 'routine', program: u.program, routine: u.routine, rung: u.rung }) : u.location),
          h('td', {}, u.rung ?? ''), h('td', { class: 'mono' }, u.instruction === 'NO' ? 'XIC' : u.instruction === 'NC' ? 'XIO' : u.instruction),
          h('td', { class: 'mono' }, u.ref), h('td', {}, h('span', { class: `pill ${u.access === 'write' ? 'out' : 'in'}` }, u.access === 'write' ? 'Write' : 'Read')))))
        : h('p', { class: 'muted' }, 'Not used anywhere.'),
    ] : h('p', { class: 'muted' }, 'No tags.'));
  body(h('div', { class: 'xref' }, list, detail));
}

// ---------------- trend
function addPen(ref, program = null) {
  const key = program ? `${program}:${ref}` : ref;
  if (!trend.pens.some((p) => p.key === key)) {
    if (trend.pens.length >= PEN_COLORS.length) { toast(`Up to ${PEN_COLORS.length} pens`); return; }
    const used = new Set(trend.pens.map((p) => p.color));
    trend.pens.push({ key, ref, program, color: PEN_COLORS.find((c) => !used.has(c)) });
    trend.data[key] = [];
  }
  setView({ kind: 'trend' });
}

function sampleTrend() {
  if (trend.paused || !controller.project) return;
  const t = controller.time;
  for (const p of trend.pens) {
    const v = controller.read(p.ref, p.program);
    const n = typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : NaN;
    const arr = trend.data[p.key];
    arr.push({ t, v: n });
    if (arr.length > 2400) arr.shift();
  }
}

function viewTrend() {
  const inp = input('', () => {}, { list: 'tag-list', placeholder: 'Tag, e.g. MOTOR or Line.BoxCount', size: 26, id: 'pen-input' });
  head(h('h2', {}, '📈 Trend'),
    h('div', { class: 'row' },
      inp,
      h('button', { class: 'btn small', onclick: () => { const v = inp.value.trim(); if (!TAG_RE.test(v)) return toast('Enter a tag reference'); addPen(v, null); } }, '+ Add pen'),
      h('button', { class: 'btn small', onclick: () => { trend.paused = !trend.paused; refresh(); } }, trend.paused ? '▶ Resume' : '⏸ Pause'),
      h('button', { class: 'btn small', onclick: () => { for (const k of Object.keys(trend.data)) trend.data[k] = []; } }, 'Clear'),
      field('Window', sel([['10', '10 s'], ['30', '30 s'], ['60', '60 s']], String(trend.window), (v) => { trend.window = Number(v); }))),
    h('div', { class: 'pens' }, trend.pens.length ? trend.pens.map((p, i) => h('span', { class: 'pen', style: `border-color:${p.color}` },
      h('i', { style: `background:${p.color}` }), p.key, ' ', h('b', { dataset: { pen: p.key } }, ''),
      h('button', { class: 'btn small ghost', onclick: () => { trend.pens.splice(i, 1); delete trend.data[p.key]; refresh(); } }, '✕')))
      : h('span', { class: 'muted' }, 'No pens yet. Add tags here or with 📈 in the tag editor. A sample is taken every controller scan.')));
  body(h('canvas', { id: 'trend-canvas', width: 900, height: 360, class: 'trend' }));
}

function drawTrend() {
  const cv = document.getElementById('trend-canvas');
  if (!cv) return;
  const c = cv.getContext('2d');
  const Wt = cv.width, Ht = cv.height, L = 78, R = 10;
  c.fillStyle = '#0c111a'; c.fillRect(0, 0, Wt, Ht);
  const tEnd = controller.time;
  const tStart = tEnd - trend.window * 1000;
  const x = (t) => L + ((t - tStart) / (trend.window * 1000)) * (Wt - L - R);
  c.strokeStyle = '#1f2937'; c.fillStyle = '#64748b'; c.font = '10px ui-monospace, monospace'; c.textAlign = 'center';
  const step = trend.window <= 10 ? 1000 : 5000;
  for (let t = Math.ceil(tStart / step) * step; t <= tEnd; t += step) {
    c.beginPath(); c.moveTo(x(t), 0); c.lineTo(x(t), Ht - 14); c.stroke();
    c.fillText(`${((t - tEnd) / 1000).toFixed(0)}s`, x(t), Ht - 3);
  }
  const pens = trend.pens;
  if (!pens.length) return;
  const laneH = (Ht - 16) / pens.length;
  pens.forEach((p, i) => {
    const pts = trend.data[p.key].filter((s) => s.t >= tStart && Number.isFinite(s.v));
    const top = i * laneH + 6, bot = (i + 1) * laneH - 6;
    let lo = 0, hi = 1;
    for (const s of pts) { if (s.v < lo) lo = s.v; if (s.v > hi) hi = s.v; }
    const y = (v) => bot - ((v - lo) / (hi - lo)) * (bot - top);
    c.strokeStyle = '#1f2937'; c.beginPath(); c.moveTo(L, bot + 5); c.lineTo(Wt - R, bot + 5); c.stroke();
    c.fillStyle = p.color; c.textAlign = 'left'; c.font = '11px ui-monospace, monospace';
    c.fillText(p.key.length > 11 ? p.key.slice(0, 11) + '…' : p.key, 4, top + 10);
    c.fillStyle = '#64748b'; c.font = '10px ui-monospace, monospace';
    c.fillText(fmt(hi), 4, top + 24); c.fillText(fmt(lo), 4, bot);
    c.strokeStyle = p.color; c.lineWidth = 2; c.beginPath();
    pts.forEach((s, k) => {
      if (k === 0) c.moveTo(x(s.t), y(s.v));
      else { c.lineTo(x(s.t), y(pts[k - 1].v)); c.lineTo(x(s.t), y(s.v)); }
    });
    c.stroke(); c.lineWidth = 1;
    const last = pts[pts.length - 1];
    const lbl = document.querySelector(`[data-pen="${CSS.escape(p.key)}"]`);
    if (lbl) lbl.textContent = last ? `= ${fmt(last.v)}` : '';
  });
}

// ---------------- compare
function viewCompare() {
  const d = diffs();
  head(h('h2', {}, '≠ Compare: offline project vs controller'),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: doDownload }, '⬇ Download offline → controller'),
      h('button', { class: 'btn small', onclick: doUpload, disabled: !controller.project }, '⬆ Upload controller → offline'),
      h('button', { class: 'btn small ghost', onclick: refresh }, 'Refresh')));
  if (!d) { body(h('p', { class: 'muted' }, 'The controller has no project yet. Download to send one.')); return; }
  if (!d.length) { body(h('p', { class: 'ok' }, '✓ No differences. The offline project matches the running controller copy.')); return; }
  const label = { added: 'Offline only', removed: 'Controller only', changed: 'Changed' };
  body(h('p', {}, `${d.length} difference${d.length > 1 ? 's' : ''}:`),
    h('table', { class: 'grid diff' },
      h('tr', {}, h('th', {}, ''), h('th', {}, 'Item'), h('th', {}, 'Offline'), h('th', {}, 'Controller')),
      d.map((x) => h('tr', { class: x.kind }, h('td', {}, h('span', { class: `pill ${x.kind}` }, label[x.kind])), h('td', { class: 'mono' }, x.path), h('td', { class: 'mono' }, x.offline), h('td', { class: 'mono' }, x.online)))));
}

// ------------------------------------------------------------------ ladder area
function renderLadder() {
  const r = currentRoutineObj();
  if (!r) return;
  ladder.render(r, selection, { aois: types().aois });
  highlightLadder();
  const note = document.getElementById('sync-note');
  if (note) note.textContent = online ? (routineInSync() ? '● live' : '○ not live: this routine differs from the controller (Download to apply)') : '';
}

function highlightLadder() {
  if (view.kind !== 'routine' && view.kind !== 'aoi') return;
  const live = online && controller.project && routineInSync();
  ladder.highlight(live ? controller.traces[traceKey()] : null, live ? liveReader() : null);
}

function editRoutine(fn) {
  const before = selection;
  commit(() => { selection = fn(currentRoutineObj()); });
  if (!selection) selection = before;
}

function addInstruction(op) {
  const pr = currentProgram();
  if (op === 'rung') editRoutine((rt) => ops.addRung(rt, selection));
  else if (op === 'NO' || op === 'NC') editRoutine((rt) => ops.insertContact(rt, selection, op));
  else if (op === 'CMP') editRoutine((rt) => ops.insertItem(rt, selection, { type: 'GRT', a: 'NEW_DINT', b: '0' }));
  else if (op === 'branch') { if (!selection) return toast('Select a contact or rung first'); editRoutine((rt) => ops.addBranch(rt, selection)); }
  else if (op === 'MATH') editRoutine((rt) => ops.addOutput(rt, selection, 'ADD'));
  else if (op === 'JSR') {
    if (!pr || view.kind !== 'routine') return toast('JSR is only available in program routines');
    const other = pr.routines.find((x) => x.name !== view.routine);
    editRoutine((rt) => ops.addOutput(rt, selection, 'JSR', { routine: other ? other.name : 'Subroutine' }));
  } else if (op === 'AOI') {
    const def = project.aois.find((a) => a.name !== view.aoi);
    if (!def) return toast('Create an Add-On Instruction first (tree → Add-On Instructions → +)');
    const inst = project.controllerTags.find((t) => t.type === def.name);
    editRoutine((rt) => ops.addOutput(rt, selection, 'AOI', { aoi: def.name, tag: inst ? inst.name : uniqueName(`${def.name}_`, project.controllerTags.map((t) => t.name)) }));
  } else if (OUTPUT_TYPES.includes(op)) editRoutine((rt) => ops.addOutput(rt, selection, op));
  else if (op === 'up') editRoutine((rt) => ops.moveRung(rt, selection, -1));
  else if (op === 'down') editRoutine((rt) => ops.moveRung(rt, selection, 1));
  else if (op === 'delete') editRoutine((rt) => ops.remove(rt, selection));
  const first = document.querySelector('#inspector input.operand');
  if (first && !['up', 'down', 'delete', 'rung'].includes(op)) { first.focus(); first.select(); }
}

for (const b of document.querySelectorAll('.toolbar [data-op]')) b.addEventListener('click', () => addInstruction(b.dataset.op));
$('#ladder').addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selection) { e.preventDefault(); addInstruction('delete'); }
});
$('#ladder').addEventListener('pointerdown', () => $('#ladder').focus());

const HELP = {
  NO: 'XIC (examine if closed): passes power when the bit is ON.',
  NC: 'XIO (examine if open): passes power when the bit is OFF.',
  EQU: 'Compare: true when A = B.', NEQ: 'Compare: true when A ≠ B.', GRT: 'Compare: true when A > B.',
  GEQ: 'Compare: true when A ≥ B.', LES: 'Compare: true when A < B.', LEQ: 'Compare: true when A ≤ B.',
  OTE: 'Output energize: the bit follows rung power.',
  OTL: 'Latch: sets the bit ON when the rung is true; it stays ON until unlatched.',
  OTU: 'Unlatch: sets the bit OFF when the rung is true.',
  TON: 'On-delay timer: ACC counts ms while the rung is true. .EN enabled, .TT timing, .DN done (ACC ≥ PRE). Resets when the rung goes false.',
  CTU: 'Count up: ACC +1 on each false→true transition. .DN when ACC ≥ PRE. Use RES to clear.',
  RES: 'RES instruction: clears the named TIMER or COUNTER when the rung is true. (This is not "Reset Controller".)',
  MOV: 'Move: copies Source to Dest when the rung is true, converted to Dest\'s data type.',
  ADD: 'Dest := A + B', SUB: 'Dest := A − B', MUL: 'Dest := A × B', DIV: 'Dest := A ÷ B (integer destinations truncate; ÷0 gives 0).',
  JSR: 'Jump to subroutine: runs another routine of this program when the rung is true.',
  AOI: 'Add-On Instruction call: Input parameters are copied in, the logic runs, then Output parameters are copied out. The instance tag holds its parameters and local tags.',
};

function renderInspector() {
  const box = $('#inspector');
  box.replaceChildren();
  const rt = currentRoutineObj();
  const obj = rt && ops.getSelected(rt, selection);
  if (!obj) {
    box.append(h('span', { class: 'what' }, 'Nothing selected'), h('div', { class: 'help' }, 'Click a rung, instruction or branch to edit it. Use the toolbar to add instructions.'));
    return;
  }
  const change = (fn) => commit(fn);
  const operand = (label, key, allowLiteral = true) => field(label, input(obj[key], (v) => change(() => {
    if (!(allowLiteral ? isOperand(v) : TAG_RE.test(v))) throw new Error(`${label}: enter a tag${allowLiteral ? ' or number' : ''}`);
    obj[key] = v;
  }), { list: 'tag-list', class: 'operand', size: 16 }));
  if (selection.kind === 'rung') {
    box.append(h('span', { class: 'what' }, `Rung ${selection.r}`),
      field('Comment', input(obj.comment, (v) => change(() => { obj.comment = v; }), { size: 50 })),
      h('code', { class: 'mono small' }, rungText(obj)),
      h('div', { class: 'help' }, 'Add instructions with the toolbar. "Branch" with a rung selected puts the whole rung logic in parallel with a new contact.'));
    return;
  }
  if (selection.kind === 'branch' || selection.kind === 'leg') {
    box.append(h('span', { class: 'what' }, selection.kind === 'branch' ? 'Parallel branch' : 'Branch leg'),
      h('div', { class: 'help' }, selection.kind === 'branch' ? '"Branch" adds another parallel leg; NO/NC inserts after the branch. Delete removes the whole branch.' : 'NO/NC append to this leg, "Branch" adds another leg. Delete removes this leg.'));
    return;
  }
  const isInput = selection.kind === 'item';
  const family = isInput ? INPUT_TYPES : OUTPUT_TYPES;
  const typeSel = sel(family, obj.type, (v) => change(() => {
    const old = obj.type;
    obj.type = v;
    const wasCmp = COMPARE_TYPES.includes(old), isCmp = COMPARE_TYPES.includes(v);
    if (isInput && isCmp && !wasCmp) { obj.a = obj.tag || 'NEW_DINT'; obj.b = '0'; delete obj.tag; }
    if (isInput && !isCmp && wasCmp) { obj.tag = TAG_RE.test(obj.a) ? obj.a : 'NEW_BIT'; delete obj.a; delete obj.b; }
    if (!isInput) {
      const keep = obj.tag || obj.dest || 'NEW_TAG';
      for (const k of ['tag', 'preset', 'src', 'dest', 'a', 'b', 'routine', 'aoi', 'args']) delete obj[k];
      if (['OTE', 'OTL', 'OTU', 'RES'].includes(v)) obj.tag = keep;
      else if (v === 'TON') Object.assign(obj, { tag: 'T1', preset: 1000 });
      else if (v === 'CTU') Object.assign(obj, { tag: 'C1', preset: 5 });
      else if (v === 'MOV') Object.assign(obj, { src: '0', dest: keep });
      else if (MATH_TYPES.includes(v)) Object.assign(obj, { a: '0', b: '1', dest: keep });
      else if (v === 'JSR') obj.routine = (currentProgram() && currentProgram().routines[0].name) || 'MainRoutine';
      else if (v === 'AOI') Object.assign(obj, { aoi: project.aois[0] ? project.aois[0].name : 'MyAOI', tag: 'AOI_1', args: {} });
    }
  }));
  box.append(h('span', { class: 'what' }, isInput ? 'Input instruction' : 'Output instruction'), field('Type', typeSel));
  const t = obj.type;
  if (t === 'NO' || t === 'NC' || ['OTE', 'OTL', 'OTU', 'RES'].includes(t)) box.append(operand(t === 'RES' ? 'Timer/counter' : 'Tag', 'tag', false));
  else if (COMPARE_TYPES.includes(t)) box.append(operand('Source A', 'a'), operand('Source B', 'b'));
  else if (t === 'TON' || t === 'CTU') {
    box.append(operand(t === 'TON' ? 'Timer' : 'Counter', 'tag', false),
      field(t === 'TON' ? 'Preset (ms)' : 'Preset', h('input', { type: 'number', min: 0, value: obj.preset, style: 'width:90px', onchange: (e) => change(() => { obj.preset = Math.max(0, Number(e.target.value) || 0); }) })));
  } else if (t === 'MOV') box.append(operand('Source', 'src'), operand('Dest', 'dest', false));
  else if (MATH_TYPES.includes(t)) box.append(operand('Source A', 'a'), operand('Source B', 'b'), operand('Dest', 'dest', false));
  else if (t === 'JSR') {
    const pr = currentProgram();
    const names = pr ? pr.routines.map((x) => x.name).filter((n) => n !== view.routine) : [];
    box.append(field('Routine', sel(names.includes(obj.routine) ? names : [obj.routine, ...names], obj.routine, (v) => change(() => { obj.routine = v; }))));
  } else if (t === 'AOI') {
    const def = project.aois.find((a) => a.name === obj.aoi);
    const defs = project.aois.filter((a) => a.name !== view.aoi).map((a) => a.name);
    box.append(field('AOI', sel(defs.includes(obj.aoi) ? defs : [obj.aoi, ...defs], obj.aoi, (v) => change(() => { obj.aoi = v; obj.args = {}; }))),
      operand('Instance tag', 'tag', false));
    if (def) for (const p of def.params) {
      box.append(field(`${p.name} (${p.usage === 'Output' ? 'out' : 'in'}, ${p.type})`, input((obj.args || {})[p.name] || '', (v) => change(() => {
        obj.args = obj.args || {};
        if (!v) { delete obj.args[p.name]; return; }
        if (!(p.usage === 'Output' ? TAG_RE.test(v) : isOperand(v))) throw new Error(`${p.name}: enter a tag${p.usage === 'Output' ? '' : ' or number'}`);
        obj.args[p.name] = v;
      }), { list: 'tag-list', class: 'operand', size: 14 })));
    }
  }
  box.append(h('div', { class: 'help' }, HELP[t] || '', TAG_INFO[obj.tag] ? ` ${obj.tag}: ${TAG_INFO[obj.tag]}.` : ''));
  if (view.kind === 'routine') {
    const decls = scopeDecls(view.program);
    const refs = [obj.tag, obj.a, obj.b, obj.src, obj.dest, ...Object.values(obj.args || {})].filter((x) => typeof x === 'string' && TAG_RE.test(x));
    const missing = [...new Set(refs.map((r) => r.split('.')[0]))].filter((b) => !decls[b]);
    for (const m of missing) {
      const guess = t === 'TON' ? 'TIMER' : t === 'CTU' ? 'COUNTER' : t === 'AOI' && m === obj.tag ? obj.aoi : (['NO', 'NC', 'OTE', 'OTL', 'OTU'].includes(t) ? 'BOOL' : 'DINT');
      let typ = guess, scope = 'Controller';
      box.append(h('div', { class: 'declare' }, '⚠ ', h('b', {}, m), ' is not declared. Declare as ',
        sel(allTypeNames(project), guess, (v) => { typ = v; }), ' in ',
        sel(['Controller', view.program], 'Controller', (v) => { scope = v; }), ' ',
        h('button', { class: 'btn small', onclick: () => commit(() => { (scope === 'Controller' ? project.controllerTags : findProgram(project, scope).tags).push({ name: m, type: typ, description: '' }); }) }, 'Declare')));
    }
  }
}

// ------------------------------------------------------------------ controller actions
function doDownload() {
  try {
    controller.download(project);
    syncForces();
    stepped = false;
    factory.setOutputs({});
    persist();
    toast(`Downloaded "${project.name}" to ${project.controller.name}. The controller is in PROGRAM mode; press Run.`);
  } catch (e) { toast(`Download failed: ${e.message}`); }
  refresh();
}

function doUpload() {
  if (!controller.project) return toast('The controller has no project');
  const forces = project.forces, enabled = project.forcesEnabled;
  project = migrate(controller.upload());
  project.forces = forces;
  project.forcesEnabled = enabled;
  syncForces();
  persist();
  toast('Uploaded the controller project (with current tag values) into the offline project');
  refresh();
}

function doScan() {
  if (!controller.project) return;
  const outputs = controller.scan(factory.readInputs(), SCAN_MS);
  factory.consumeInputs();
  factory.setOutputs(outputs);
  sampleTrend();
  if (controller.fault) refresh();
}

$('#btn-download').onclick = doDownload;
$('#btn-upload').onclick = doUpload;
$('#btn-online').onclick = () => { online = !online; refresh(); };
$('#btn-run').onclick = () => {
  if (!controller.project) return toast('Download a project first');
  controller.clearFault();
  controller.mode = 'run';
  stepped = false;
  scanAcc = SCAN_MS;
  updateStatus();
};
$('#btn-stop').onclick = () => {
  controller.mode = 'program';
  stepped = false;
  factory.setOutputs({});
  updateStatus();
};
$('#btn-step').onclick = () => { stepped = true; doScan(); highlightLadder(); updateStatus(); };
$('#btn-reset-ctrl').onclick = () => {
  controller.reset();
  if (controller.mode !== 'run') factory.setOutputs({});
  toast('Reset Controller: memory restored to initial values');
  refresh();
};
$('#btn-forces').onclick = () => commit(() => { project.forcesEnabled = !project.forcesEnabled; });

// ------------------------------------------------------------------ live values
let lastLive = 0;
let ioSig = '';
function updateLive(force = false) {
  const now = performance.now();
  if (!force && now - lastLive < 150) return;
  lastLive = now;
  $('#scan-count').textContent = controller.state ? controller.state.scanCount : 0;
  for (const s of document.querySelectorAll('[data-live]')) {
    if (!online || !controller.project) { s.textContent = '—'; s.parentElement.classList.remove('on'); continue; }
    const v = controller.read(s.dataset.live, s.dataset.scope || null);
    s.textContent = fmt(v);
    s.parentElement.classList.toggle('on', v === true);
  }
  const inputs = factory.readInputs();
  for (const s of document.querySelectorAll('[data-field]')) {
    const v = s.dataset.dir === 'IN' ? inputs[s.dataset.field] : factory.outputs[s.dataset.field];
    s.textContent = v ? '1' : '0';
    s.parentElement.classList.toggle('on', !!v);
  }
  const rows = project.ioConfig.map((r) => [r.signal, r.dir, r.tag, r.dir === 'IN' ? !!inputs[r.signal] : !!factory.outputs[r.signal]]);
  const sig = JSON.stringify(rows) + project.forcesEnabled + JSON.stringify(project.forces);
  if (sig !== ioSig) {
    ioSig = sig;
    $('#io-table').replaceChildren(...rows.map(([signal, dir, tag, on]) => h('div', {
      class: `io-item ${on ? 'on' : ''} ${project.forcesEnabled && Object.prototype.hasOwnProperty.call(project.forces, tag) ? 'forced' : ''}`,
      title: `${TAG_INFO[signal] || ''} → tag ${tag || '(unmapped)'}`,
    }, h('span', { class: 'led' }), h('span', {}, signal), h('span', { class: 'dir' }, `${dir}${tag && tag !== signal ? ` → ${tag}` : ''}`))));
  }
}

// ------------------------------------------------------------------ main loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (controller.mode === 'run' && controller.project) {
    scanAcc += dt * 1000;
    let n = 0;
    while (scanAcc >= SCAN_MS && n < 4) { doScan(); scanAcc -= SCAN_MS; n++; }
    if (n === 4) scanAcc = 0;
    if (n) highlightLadder();
  } else if (!stepped) factory.setOutputs({});
  factory.step(dt);
  factory.draw();
  updateLive();
  if (view.kind === 'trend') drawTrend();
  const es = factory.buttons.ESTOP;
  $('#estop').setAttribute('aria-pressed', String(es));
  $('#estop-release').disabled = !es;
  $('#estop-state').textContent = es ? 'E-stop ENGAGED' : 'E-stop released';
  $('#estop-state').classList.toggle('warn', es);
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ operator panel
for (const b of document.querySelectorAll('[data-pb]')) {
  const tag = b.dataset.pb;
  const down = (e) => { e.preventDefault(); factory.press(tag); b.classList.add('pressed'); };
  const up = (e) => { e.preventDefault(); if (factory.held[tag]) factory.release(tag); b.classList.remove('pressed'); };
  b.addEventListener('pointerdown', down);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointerleave', up);
  b.addEventListener('pointercancel', up);
  b.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) down(e); });
  b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') up(e); });
}
$('#estop').addEventListener('click', () => {
  if (factory.buttons.ESTOP) { factory.releaseEstop(); toast('E-STOP released'); }
  else { factory.press('ESTOP'); toast('E-STOP engaged: press RESET or "Release E-STOP" to release it'); }
});
$('#estop-release').addEventListener('click', () => { factory.releaseEstop(); toast('E-STOP released'); });
$('#btn-spawn').onclick = () => factory.spawnBox(false) || toast('Infeed is blocked');
$('#btn-spawn-tall').onclick = () => factory.spawnBox(true) || toast('Infeed is blocked');
$('#auto-spawn').onchange = (e) => { factory.autoSpawn = e.target.checked; factory.spawnTimer = factory.spawnInterval; };
$('#btn-clear').onclick = () => { factory.boxes = []; factory.delivered = 0; factory.rejected = 0; };
$('#factory').addEventListener('pointerdown', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  factory.removeBoxAt((e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height));
});

// ------------------------------------------------------------------ examples & files
const exSel = $('#examples');
for (const ex of ALL_EXAMPLES) exSel.add(new Option(ex.name, ex.id));

function openProject(p, { download = false, desc = '' } = {}) {
  project = migrate(p);
  syncForces();
  trend.pens = []; trend.data = {};
  const firstProg = project.tasks[0] && project.tasks[0].programs[0];
  view = firstProg ? { kind: 'routine', program: firstProg.name, routine: firstProg.mainRoutine } : { kind: 'controller' };
  selection = { r: 0, kind: 'rung' };
  if (download) { controller.download(project); syncForces(); stepped = false; }
  $('#example-desc').textContent = desc;
  persist();
  refresh();
}

function loadExample(id) {
  const ex = exampleProject(id);
  openProject(ex.project, { download: true, desc: `${ex.name}: ${ex.description}` });
  factory.autoSpawn = !!(ex.factory && ex.factory.autoSpawn);
  $('#auto-spawn').checked = factory.autoSpawn;
  factory.boxes = []; factory.delivered = 0; factory.rejected = 0;
  online = true;
  exSel.value = id;
  refresh();
  toast(`Loaded and downloaded "${ex.name}". Press Run, then START.`);
}
$('#btn-load-example').onclick = () => loadExample(exSel.value);
$('#btn-new').onclick = () => { if (confirm('Start a new empty project? The controller keeps its current program until you Download.')) openProject(newProject('NewProject')); };
$('#btn-save').onclick = () => {
  try { localStorage.setItem(KEY_SAVED, JSON.stringify(project)); toast(`Saved "${project.name}" (including forces) in this browser`); }
  catch (e) { toast('Save failed: ' + e.message); }
};
$('#btn-load').onclick = () => {
  const raw = localStorage.getItem(KEY_SAVED);
  if (!raw) return toast('Nothing saved yet');
  try { openProject(JSON.parse(raw)); toast(`Opened "${project.name}". Download to run it.`); }
  catch (e) { toast('Saved project is invalid: ' + e.message); }
};
$('#btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (project.name || 'project').replace(/[^\w-]+/g, '_') + '.plc.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#btn-import').onclick = () => $('#file-import').click();
$('#file-import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { openProject(JSON.parse(await f.text())); toast(`Imported "${project.name}". Download to run it.`); }
  catch (err) { toast('Import failed: ' + err.message); }
});

// ------------------------------------------------------------------ guided tour
function storageOrNull() { try { return window.localStorage; } catch { return null; } }
let viewBeforeTour = null;
const tour = new TourOverlay({
  storage: storageOrNull(),
  prepare: (step) => {
    if (step.view === 'main') {
      if (view.kind !== 'routine') {
        const first = project.tasks.flatMap((t) => t.programs)[0];
        if (first) setView({ kind: 'routine', program: first.name, routine: first.mainRoutine });
      }
    } else if (step.view && (view.kind !== step.view.kind || view.scope !== step.view.scope)) setView(step.view);
  },
  onEnd: (reason) => {
    if (viewBeforeTour) setView(viewBeforeTour);
    viewBeforeTour = null;
    toast(reason === 'finished' ? 'Tour finished. Replay it any time with "? Tour".' : 'Tour skipped. Replay it any time with "? Tour".');
  },
});
function startTour() {
  if (tour.active) return;
  viewBeforeTour = { ...view };
  tour.start();
}
$('#btn-tour').onclick = startTour;

// ------------------------------------------------------------------ boot
(function boot() {
  let restored = false;
  try {
    const raw = localStorage.getItem(KEY_PROJECT) || localStorage.getItem(KEY_LEGACY);
    if (raw) {
      openProject(JSON.parse(raw));
      const craw = localStorage.getItem(KEY_CONTROLLER);
      controller.download(craw ? migrate(JSON.parse(craw)) : project);
      syncForces();
      online = true;
      restored = true;
      factory.autoSpawn = true;
      $('#auto-spawn').checked = true;
    }
  } catch (e) { console.warn('Could not restore the saved project', e); restored = false; }
  if (!restored) loadExample('seal-in');
  refresh();
  requestAnimationFrame(frame);
  if (Tour.shouldAutoStart(storageOrNull())) setTimeout(startTour, 300);
  window.__plc = {
    get project() { return project; }, controller, factory, loadExample, doDownload, doUpload, setView, refresh, addPen, commit,
    get state() { return controller.state; }, get online() { return online; }, tour,
  };
})();
