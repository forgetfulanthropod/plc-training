import { createState, scan, collectTags, validateProgram, TIMER_MEMBERS, COUNTER_MEMBERS, OUTPUT_TYPES } from './ladder.js';
import { Factory, INPUT_TAGS, OUTPUT_TAGS, TAG_INFO, W, H } from './factory.js';
import { EXAMPLES, cloneExample } from './examples.js';
import { LadderView, ops } from './editor.js';

const SCAN_MS = 50;
const KEY_AUTOSAVE = 'plc-training:autosave';
const KEY_SAVED = 'plc-training:saved';
const $ = (s) => document.querySelector(s);

let program;
let plc = createState();
let mode = 'stop'; // 'stop' | 'run'
let sel = null;
let lastResult = null;
let scanAcc = 0;

const factory = new Factory($('#factory'));
const view = new LadderView($('#ladder'), (s) => { sel = s; refresh(); });

// ------------------------------------------------------------------ helpers
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

function autosave() {
  try { localStorage.setItem(KEY_AUTOSAVE, JSON.stringify(program)); } catch { /* ignore quota */ }
}

function setProgram(p, { keepState = false } = {}) {
  program = validateProgram(p);
  if (!keepState) { plc = createState(); lastResult = null; }
  sel = program.rungs.length ? { r: 0, kind: 'rung' } : null;
  $('#program-name').value = program.name;
  refresh();
}

/** Re-render after any edit. */
function refresh() {
  view.render(program, sel);
  view.highlight(lastResult, plc, program);
  renderInspector();
  renderTagList();
  autosave();
}

function applyFactoryOptions(opts = {}) {
  factory.autoSpawn = !!opts.autoSpawn;
  $('#auto-spawn').checked = factory.autoSpawn;
}

// ------------------------------------------------------------------ PLC execution
function doScan(dt) {
  const inputs = factory.readInputs();
  lastResult = scan(program, plc, inputs, dt);
  factory.setOutputs(plc.tags);
  view.highlight(lastResult, plc, program);
  $('#scan-count').textContent = plc.scanCount;
}

function setMode(m) {
  mode = m;
  const badge = $('#mode');
  badge.textContent = m === 'run' ? 'RUN' : 'PROGRAM';
  badge.className = 'mode ' + (m === 'run' ? 'run' : 'stop');
  $('#btn-run').disabled = m === 'run';
  $('#btn-step').disabled = m === 'run';
}

$('#btn-run').onclick = () => { setMode('run'); scanAcc = SCAN_MS; };
$('#btn-stop').onclick = () => {
  setMode('stop');
  // Going to program mode de-energizes physical outputs
  for (const t of OUTPUT_TAGS) plc.tags[t] = false;
  factory.setOutputs(plc.tags);
  lastResult = null;
  view.highlight(null, plc, program);
};
$('#btn-step').onclick = () => {
  doScan(SCAN_MS);
  $('#mode').textContent = 'STEP';
  $('#mode').className = 'mode step';
};
$('#btn-reset-plc').onclick = () => {
  plc = createState();
  lastResult = null;
  factory.setOutputs(plc.tags);
  view.highlight(null, plc, program);
  $('#scan-count').textContent = 0;
  toast('PLC memory cleared');
};
$('#scan-ms').textContent = SCAN_MS;

// ------------------------------------------------------------------ main loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (mode === 'run') {
    scanAcc += dt * 1000;
    let n = 0;
    while (scanAcc >= SCAN_MS && n < 4) { doScan(SCAN_MS); scanAcc -= SCAN_MS; n++; }
    if (n === 4) scanAcc = 0;
  }
  factory.step(dt);
  factory.draw();
  renderIO();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ toolbar / editing
const edit = (fn) => { sel = fn(); refresh(); };
for (const b of document.querySelectorAll('.toolbar [data-op]')) {
  b.addEventListener('click', () => {
    const op = b.dataset.op;
    if (op === 'rung') edit(() => ops.addRung(program, sel));
    else if (op === 'NO' || op === 'NC') edit(() => ops.insertContact(program, sel, op));
    else if (op === 'branch') {
      if (!sel) return toast('Select a contact or rung first');
      edit(() => ops.addBranch(program, sel));
    } else if (OUTPUT_TYPES.includes(op)) edit(() => ops.addOutput(program, sel, op));
    else if (op === 'up') edit(() => ops.moveRung(program, sel, -1));
    else if (op === 'down') edit(() => ops.moveRung(program, sel, 1));
    else if (op === 'delete') edit(() => ops.remove(program, sel));
    if (['NO', 'NC', 'branch', 'OTE', 'OTL', 'OTU', 'RES'].includes(op)) {
      const inp = document.querySelector('#inspector input[name=tag]');
      if (inp) { inp.focus(); inp.select(); }
    }
  });
}
$('#ladder').addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); edit(() => ops.remove(program, sel)); }
});
$('#ladder').addEventListener('pointerdown', () => $('#ladder').focus());
$('#program-name').addEventListener('input', (e) => { program.name = e.target.value; autosave(); });

function field(label, input) {
  const l = document.createElement('label');
  l.append(label, input);
  return l;
}

function renderInspector() {
  const box = $('#inspector');
  box.replaceChildren();
  const obj = ops.getSelected(program, sel);
  const what = document.createElement('span');
  what.className = 'what';
  const help = document.createElement('div');
  help.className = 'help';
  if (!obj) {
    what.textContent = 'Nothing selected';
    help.textContent = 'Click a rung, contact, branch or output to edit it. Use the toolbar to add instructions.';
    box.append(what, help);
    return;
  }
  const tagInput = (value, onChange) => {
    const i = document.createElement('input');
    i.type = 'text'; i.name = 'tag'; i.value = value; i.setAttribute('list', 'tag-list'); i.spellcheck = false;
    i.addEventListener('change', () => {
      const v = i.value.trim().replace(/\s+/g, '_');
      if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z]+)?$/.test(v)) { toast('Tag names: letters, digits, _ (e.g. MOTOR, T1.DN)'); i.value = value; return; }
      onChange(v); refresh();
    });
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); });
    return i;
  };
  const select = (options, value, onChange) => {
    const s = document.createElement('select');
    for (const o of options) s.add(new Option(o, o, false, o === value));
    s.addEventListener('change', () => { onChange(s.value); refresh(); });
    return s;
  };

  if (sel.kind === 'rung') {
    what.textContent = `Rung ${sel.r}`;
    const c = document.createElement('input');
    c.type = 'text'; c.value = obj.comment; c.size = 50; c.placeholder = 'Rung comment';
    c.addEventListener('change', () => { obj.comment = c.value; refresh(); });
    box.append(what, field('Comment', c));
    help.textContent = 'Add contacts (they go at the end of the rung) and outputs. "Branch" with a rung selected puts the whole rung logic in parallel with a new contact.';
  } else if (sel.kind === 'item') {
    what.textContent = 'Contact';
    box.append(what,
      field('Type', select(['NO', 'NC'], obj.type, (v) => { obj.type = v; })),
      field('Tag', tagInput(obj.tag, (v) => { obj.tag = v; })));
    help.textContent = obj.type === 'NO'
      ? 'Normally-open (XIC): passes power when the tag is ON.'
      : 'Normally-closed (XIO): passes power when the tag is OFF.';
    if (TAG_INFO[obj.tag]) help.textContent += ` ${obj.tag}: ${TAG_INFO[obj.tag]}.`;
    help.textContent += ' New contacts are inserted after the selected one. Use "Branch" to put a contact in parallel.';
  } else if (sel.kind === 'branch' || sel.kind === 'leg') {
    what.textContent = sel.kind === 'branch' ? 'Parallel branch' : 'Branch leg';
    help.textContent = sel.kind === 'branch'
      ? 'Branch selected: "Branch" adds another parallel leg, "NO/NC" inserts after the branch. Delete removes the whole branch.'
      : 'Leg selected: "NO/NC" appends to this leg, "Branch" adds another leg. Delete removes this leg.';
    box.append(what);
  } else if (sel.kind === 'out') {
    what.textContent = 'Output';
    box.append(what,
      field('Type', select(OUTPUT_TYPES, obj.type, (v) => {
        obj.type = v;
        if ((v === 'TON' || v === 'CTU') && obj.preset === undefined) obj.preset = v === 'TON' ? 2000 : 5;
        if (v !== 'TON' && v !== 'CTU') delete obj.preset;
      })),
      field(obj.type === 'TON' ? 'Timer' : obj.type === 'CTU' ? 'Counter' : 'Tag', tagInput(obj.tag, (v) => { obj.tag = v.split('.')[0]; })));
    if (obj.type === 'TON' || obj.type === 'CTU') {
      const p = document.createElement('input');
      p.type = 'number'; p.min = 0; p.step = obj.type === 'TON' ? 100 : 1; p.value = obj.preset; p.style.width = '90px';
      p.addEventListener('change', () => { obj.preset = Math.max(0, Number(p.value) || 0); refresh(); });
      box.append(field(obj.type === 'TON' ? 'Preset (ms)' : 'Preset (counts)', p));
    }
    help.textContent = {
      OTE: 'Output energize: tag follows rung power.',
      OTL: 'Latch: sets the tag ON when the rung is true; it stays ON until unlatched.',
      OTU: 'Unlatch: sets the tag OFF when the rung is true.',
      TON: 'On-delay timer: ACC counts while the rung is true. Bits: .EN enabled, .TT timing, .DN done (ACC ≥ PRE). Resets when the rung goes false.',
      CTU: 'Count-up: ACC +1 on each false→true transition. .DN when ACC ≥ PRE. Use RES to clear.',
      RES: 'Reset: clears the named timer or counter when the rung is true.',
    }[obj.type];
    if (TAG_INFO[obj.tag]) help.textContent += ` ${obj.tag}: ${TAG_INFO[obj.tag]}.`;
  }
  box.append(help);
}

function renderTagList() {
  const { bits, timers, counters } = collectTags(program);
  const all = new Set([...INPUT_TAGS, ...OUTPUT_TAGS, ...bits]);
  for (const t of timers) for (const m of TIMER_MEMBERS) all.add(`${t}.${m}`);
  for (const c of counters) for (const m of COUNTER_MEMBERS) all.add(`${c}.${m}`);
  const dl = $('#tag-list');
  dl.replaceChildren(...[...all].map((t) => new Option(TAG_INFO[t] || '', t)));
}

// ------------------------------------------------------------------ I/O table
let ioSig = '';
function renderIO() {
  const { bits, timers, counters } = collectTags(program);
  const internals = [...bits].filter((b) => !INPUT_TAGS.includes(b) && !OUTPUT_TAGS.includes(b) && !b.includes('.'));
  const rows = [
    ...INPUT_TAGS.map((t) => [t, 'IN', mode === 'run' ? !!plc.tags[t] : !!factory.readInputs()[t]]),
    ...OUTPUT_TAGS.map((t) => [t, 'OUT', !!plc.tags[t]]),
    ...internals.map((t) => [t, 'BIT', !!plc.tags[t]]),
    ...[...timers].map((t) => { const o = plc.timers[t]; return [`${t} ${o ? Math.round(o.acc) : 0}/${o ? o.pre : '-'}ms`, 'TON', !!(o && o.dn)]; }),
    ...[...counters].map((t) => { const o = plc.counters[t]; return [`${t} ${o ? o.acc : 0}/${o ? o.pre : '-'}`, 'CTU', !!(o && o.dn)]; }),
  ];
  const sig = JSON.stringify(rows);
  if (sig === ioSig) return;
  ioSig = sig;
  $('#io-table').replaceChildren(...rows.map(([name, dir, on]) => {
    const d = document.createElement('div');
    d.className = 'io-item' + (on ? ' on' : '');
    d.title = TAG_INFO[name] || '';
    const led = document.createElement('span'); led.className = 'led';
    const n = document.createElement('span'); n.textContent = name;
    const k = document.createElement('span'); k.className = 'dir'; k.textContent = dir;
    d.append(led, n, k);
    return d;
  }));
}

// ------------------------------------------------------------------ operator panel
for (const b of document.querySelectorAll('[data-pb]')) {
  const tag = b.dataset.pb;
  const press = (v) => (e) => { e.preventDefault(); factory.buttons[tag] = v; b.classList.toggle('pressed', v); };
  b.addEventListener('pointerdown', press(true));
  b.addEventListener('pointerup', press(false));
  b.addEventListener('pointerleave', press(false));
  b.addEventListener('pointercancel', press(false));
  b.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') press(true)(e); });
  b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') press(false)(e); });
}
$('#estop').addEventListener('click', () => {
  factory.buttons.ESTOP = !factory.buttons.ESTOP;
  $('#estop').setAttribute('aria-pressed', String(factory.buttons.ESTOP));
  toast(factory.buttons.ESTOP ? 'E-STOP engaged: click again to release' : 'E-STOP released');
});
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
for (const ex of EXAMPLES) exSel.add(new Option(ex.name, ex.id));
function loadExample(id) {
  const ex = cloneExample(id);
  setProgram(ex.program);
  applyFactoryOptions(ex.factory);
  factory.boxes = []; factory.delivered = 0; factory.rejected = 0;
  $('#example-desc').textContent = `${ex.name}: ${ex.description}`;
  exSel.value = id;
  toast(`Loaded "${ex.name}". Press Run, then START.`);
}
$('#btn-load-example').onclick = () => loadExample(exSel.value);
exSel.addEventListener('change', () => loadExample(exSel.value));

$('#btn-save').onclick = () => {
  try { localStorage.setItem(KEY_SAVED, JSON.stringify(program)); toast(`Saved "${program.name}" in this browser`); }
  catch (e) { toast('Save failed: ' + e.message); }
};
$('#btn-load').onclick = () => {
  const raw = localStorage.getItem(KEY_SAVED);
  if (!raw) return toast('Nothing saved yet');
  try { setProgram(JSON.parse(raw)); $('#example-desc').textContent = ''; toast(`Opened "${program.name}"`); }
  catch (e) { toast('Saved program is invalid: ' + e.message); }
};
$('#btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify(program, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (program.name || 'program').replace(/[^\w-]+/g, '_') + '.plc.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#btn-import').onclick = () => $('#file-import').click();
$('#file-import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { setProgram(JSON.parse(await f.text())); $('#example-desc').textContent = ''; toast(`Imported "${program.name}"`); }
  catch (err) { toast('Import failed: ' + err.message); }
});

// ------------------------------------------------------------------ boot
(function boot() {
  let restored = false;
  try {
    const raw = localStorage.getItem(KEY_AUTOSAVE);
    if (raw) { setProgram(JSON.parse(raw)); restored = true; }
  } catch { restored = false; }
  if (!restored) loadExample('seal-in');
  else applyFactoryOptions({ autoSpawn: true });
  setMode('stop');
  requestAnimationFrame(frame);
  window.__plc = { get program() { return program; }, get state() { return plc; }, factory, loadExample, doScan };
})();
