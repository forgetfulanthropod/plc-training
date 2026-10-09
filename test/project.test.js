import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerce, Ctx, createState, scan, rungText, instructionRefs, validateProgram } from '../js/ladder.js';
import {
  migrate, newProject, validateProject, crossReference, compareProjects, verifyProject, initState, clone, ioAddress,
} from '../js/project.js';
import { Controller } from '../js/controller.js';
import { Factory } from '../js/factory.js';
import { exampleProject, ALL_EXAMPLES, cloneExample } from '../js/examples.js';
import { ops } from '../js/editor.js';

const NO = (tag) => ({ type: 'NO', tag });
const NC = (tag) => ({ type: 'NC', tag });
const OTE = (tag) => ({ type: 'OTE', tag });
const rung = (logic, outputs, comment = '') => ({ comment, logic, outputs });

function project(mainRungs, extra = {}) {
  const p = newProject('t');
  p.tasks[0].programs[0].routines[0].rungs = mainRungs;
  Object.assign(p, extra);
  return validateProject(p);
}
const mainProg = (p) => p.tasks[0].programs[0];

// ---------------------------------------------------------------- data types
test('coerce: BOOL, INT wraps at 16 bits, DINT at 32 bits, REAL keeps fractions', () => {
  assert.equal(coerce('BOOL', 1), true);
  assert.equal(coerce('BOOL', 0), false);
  assert.equal(coerce('INT', 32767 + 1), -32768);
  assert.equal(coerce('INT', 2.6), 3);
  assert.equal(coerce('DINT', 2 ** 31), -(2 ** 31));
  assert.equal(coerce('DINT', true), 1);
  assert.equal(coerce('REAL', '2.5'), 2.5);
  assert.equal(coerce('REAL', 'abc'), 0);
});

test('UDT member access: compare and MOV on Tank.Level', () => {
  const p = project([
    rung([], [{ type: 'MOV', src: '42.5', dest: 'Tank.Level' }]),
    rung([{ type: 'GRT', a: 'Tank.Level', b: '40' }], [OTE('Tank.High')]),
    rung([{ type: 'LES', a: 'Tank.Level', b: '10' }], [OTE('Tank.Low')]),
  ], {
    dataTypes: [{ name: 'TankT', members: [{ name: 'Level', type: 'REAL' }, { name: 'High', type: 'BOOL' }, { name: 'Low', type: 'BOOL' }] }],
  });
  p.controllerTags.push({ name: 'Tank', type: 'TankT' });
  const c = new Controller();
  c.download(p);
  assert.deepEqual(c.state.tags.Tank, { Level: 0, High: false, Low: false }, 'UDT initialised from definition');
  c.scan({}, 50);
  assert.equal(c.read('Tank.Level'), 42.5);
  assert.equal(c.read('Tank.High'), true);
  assert.equal(c.read('Tank.Low'), false);
});

test('compare instructions', () => {
  const s = createState();
  s.tags = { A: 5, B: 5, C: 7 };
  const cases = [['EQU', 'A', 'B', true], ['NEQ', 'A', 'B', false], ['GRT', 'C', 'A', true], ['GEQ', 'A', 'B', true], ['LES', 'C', 'A', false], ['LEQ', 'A', '5', true]];
  for (const [type, a, b, want] of cases) {
    scan({ rungs: [rung([{ type, a, b }], [OTE('Y')])] }, s, {});
    assert.equal(s.tags.Y, want, type);
  }
});

test('math instructions respect destination data type; DIV by zero gives 0', () => {
  const p = project([
    rung([], [{ type: 'ADD', a: 'I', b: '1', dest: 'I' }]),
    rung([], [{ type: 'DIV', a: '7', b: '2', dest: 'D' }]),
    rung([], [{ type: 'DIV', a: '7', b: '2', dest: 'R' }]),
    rung([], [{ type: 'MUL', a: '1000', b: '1000', dest: 'I2' }]),
    rung([], [{ type: 'SUB', a: '1', b: '3', dest: 'D2' }]),
    rung([], [{ type: 'DIV', a: '1', b: '0', dest: 'R2' }]),
  ]);
  p.controllerTags.push(
    { name: 'I', type: 'INT' }, { name: 'D', type: 'DINT' }, { name: 'R', type: 'REAL' },
    { name: 'I2', type: 'INT' }, { name: 'D2', type: 'DINT' }, { name: 'R2', type: 'REAL', value: 5 },
  );
  const c = new Controller();
  c.download(p);
  c.scan(); c.scan(); c.scan();
  assert.equal(c.read('I'), 3);
  assert.equal(c.read('D'), 3, 'integer divide truncates');
  assert.equal(c.read('R'), 3.5);
  assert.equal(c.read('I2'), coerce('INT', 1e6), 'INT overflow wraps');
  assert.equal(c.read('D2'), -2);
  assert.equal(c.read('R2'), 0);
  assert.equal(c.state.mathFault, true);
});

test('MOV into timer preset and read of timer ACC', () => {
  const s = createState();
  s.timers.T1 = { pre: 0, acc: 0, en: false, tt: false, dn: false }; // declared TIMER
  const prog = { rungs: [rung([], [{ type: 'MOV', src: '100', dest: 'T1.PRE' }]), rung([NO('GO')], [{ type: 'TON', tag: 'T1' }]), rung([], [{ type: 'MOV', src: 'T1.ACC', dest: 'X' }])] };
  scan(prog, s, { GO: true }, 60);
  scan(prog, s, { GO: true }, 60);
  assert.equal(s.timers.T1.pre, 100);
  assert.equal(s.timers.T1.dn, true);
  assert.equal(s.tags.X, 100);
});

// ---------------------------------------------------------------- scopes
test('program-scoped tags shadow controller tags of the same name', () => {
  const p = newProject('scopes');
  p.controllerTags.push({ name: 'X', type: 'BOOL' }, { name: 'Shared', type: 'DINT' });
  p.tasks[0].programs[0].tags.push({ name: 'X', type: 'BOOL' });
  p.tasks[0].programs[0].routines[0].rungs = [rung([], [OTE('X'), { type: 'ADD', a: 'Shared', b: '1', dest: 'Shared' }])];
  p.tasks[0].programs.push({ name: 'Other', mainRoutine: 'Main', tags: [], routines: [{ name: 'Main', rungs: [rung([NO('X')], [{ type: 'ADD', a: 'Shared', b: '100', dest: 'Shared' }])] }] });
  const c = new Controller();
  c.download(validateProject(p));
  c.scan();
  assert.equal(c.read('X', 'MainProgram'), true, 'program X set');
  assert.equal(c.read('X'), false, 'controller X untouched');
  assert.equal(c.read('Shared'), 1, 'Other program sees controller X (false) so did not add 100');
});

// ---------------------------------------------------------------- tasks, JSR
test('JSR runs a subroutine only when its rung is true', () => {
  const p = project([rung([NO('CALL')], [{ type: 'JSR', routine: 'Sub' }])]);
  mainProg(p).routines.push({ name: 'Sub', rungs: [rung([], [{ type: 'ADD', a: 'N', b: '1', dest: 'N' }])] });
  p.controllerTags.push({ name: 'CALL', type: 'BOOL' }, { name: 'N', type: 'DINT' });
  const c = new Controller();
  c.download(p);
  c.scan(); c.scan();
  assert.equal(c.read('N'), 0);
  c.write('CALL', true);
  c.scan(); c.scan(); c.scan();
  assert.equal(c.read('N'), 3);
  assert.ok(c.traces['MainProgram/Sub'], 'subroutine trace recorded');
});

test('recursive JSR faults the controller instead of hanging', () => {
  const p = project([rung([], [{ type: 'JSR', routine: 'MainRoutine' }])]);
  const c = new Controller();
  c.download(p);
  c.mode = 'run';
  c.scan();
  assert.match(c.fault, /too deep/);
  assert.equal(c.mode, 'program');
});

test('periodic task runs once per period with dt = period', () => {
  const p = project([rung([], [{ type: 'ADD', a: 'Fast', b: '1', dest: 'Fast' }])]);
  p.controllerTags.push({ name: 'Fast', type: 'DINT' }, { name: 'Slow', type: 'DINT' });
  p.tasks.push({ name: 'P', type: 'periodic', period: 200, programs: [{ name: 'Per', mainRoutine: 'M', tags: [], routines: [{ name: 'M', rungs: [rung([], [{ type: 'ADD', a: 'Slow', b: '1', dest: 'Slow' }, { type: 'TON', tag: 'PT', preset: 1000 }])] }] }] });
  const c = new Controller();
  c.download(validateProject(p));
  for (let i = 0; i < 20; i++) c.scan({}, 50); // 1000 ms
  assert.equal(c.read('Fast'), 20);
  assert.equal(c.read('Slow'), 5);
  assert.equal(c.read('PT.ACC'), 1000, 'timer in periodic task advances by the period');
});

// ---------------------------------------------------------------- AOIs
const counterAoi = {
  name: 'EdgeCount',
  params: [{ name: 'In', usage: 'Input', type: 'BOOL' }, { name: 'Count', usage: 'Output', type: 'DINT' }, { name: 'Done', usage: 'Output', type: 'BOOL' }],
  locals: [{ name: 'C', type: 'COUNTER' }, { name: 'Hold', type: 'TIMER' }],
  rungs: [
    rung([NO('In')], [{ type: 'CTU', tag: 'C', preset: 3 }]),
    rung([], [{ type: 'MOV', src: 'C.ACC', dest: 'Count' }]),
    rung([NO('C.DN')], [{ type: 'TON', tag: 'Hold', preset: 200 }]),
    rung([NO('Hold.DN')], [OTE('Done')]),
  ],
};

test('AOI: parameters in/out, local counter and timer, independent instances', () => {
  const p = project([
    rung([], [{ type: 'AOI', aoi: 'EdgeCount', tag: 'EC1', args: { In: 'A', Count: 'N1', Done: 'D1' } }]),
    rung([], [{ type: 'AOI', aoi: 'EdgeCount', tag: 'EC2', args: { In: 'B', Count: 'N2', Done: 'D2' } }]),
  ], { aois: [counterAoi] });
  p.controllerTags.push(
    { name: 'A', type: 'BOOL' }, { name: 'B', type: 'BOOL' }, { name: 'N1', type: 'DINT' }, { name: 'N2', type: 'DINT' },
    { name: 'D1', type: 'BOOL' }, { name: 'D2', type: 'BOOL' }, { name: 'EC1', type: 'EdgeCount' }, { name: 'EC2', type: 'EdgeCount' },
  );
  const c = new Controller();
  c.download(validateProject(p));
  const pulse = (tag) => { c.write(tag, true); c.scan(); c.write(tag, false); c.scan(); };
  pulse('A'); pulse('A'); pulse('B');
  assert.equal(c.read('N1'), 2);
  assert.equal(c.read('N2'), 1, 'second instance has its own local counter');
  assert.equal(c.read('EC1.Count'), 2, 'parameter visible as instance member');
  pulse('A');
  assert.equal(c.read('N1'), 3);
  assert.equal(c.read('D1'), false, 'local timer still timing');
  c.scan(); c.scan(); c.scan();
  assert.equal(c.read('D1'), true, 'local TIMER inside AOI completed');
  assert.equal(c.read('D2'), false);
  assert.equal(c.read('EC1.EnableOut'), true);
});

test('AOI is not scanned when its rung is false', () => {
  const p = project([rung([NO('EN')], [{ type: 'AOI', aoi: 'EdgeCount', tag: 'EC1', args: { In: 'A', Count: 'N1' } }])], { aois: [counterAoi] });
  p.controllerTags.push({ name: 'EN', type: 'BOOL' }, { name: 'A', type: 'BOOL' }, { name: 'N1', type: 'DINT' }, { name: 'EC1', type: 'EdgeCount' });
  const c = new Controller();
  c.download(validateProject(p));
  c.write('A', true); c.scan(); c.write('A', false); c.scan();
  assert.equal(c.read('N1'), 0);
  assert.equal(c.read('EC1.EnableIn'), false);
});

// ---------------------------------------------------------------- I/O configuration
test('I/O table maps field signals to (remapped) tags and output tags to field devices', () => {
  const p = project([rung([NO('GoButton')], [OTE('Conveyor.Run')])], {
    dataTypes: [{ name: 'Conv', members: [{ name: 'Run', type: 'BOOL' }] }],
  });
  p.controllerTags.push({ name: 'GoButton', type: 'BOOL' }, { name: 'Conveyor', type: 'Conv' });
  p.ioConfig.find((r) => r.signal === 'START_PB').tag = 'GoButton';
  p.ioConfig.find((r) => r.signal === 'MOTOR').tag = 'Conveyor.Run';
  const c = new Controller();
  c.download(p);
  let out = c.scan({ START_PB: true });
  assert.equal(out.MOTOR, true);
  assert.equal(c.read('START_PB'), false, 'old tag no longer driven');
  out = c.scan({ START_PB: false });
  assert.equal(out.MOTOR, false);
  assert.equal(ioAddress(p.ioConfig[0]), 'Local:1:I.Data.0');
});

// ---------------------------------------------------------------- forces
test('forces override inputs and outputs only while enabled, and survive save/load', () => {
  const p = project([rung([NO('START_PB')], [OTE('MOTOR')])]);
  p.forces = { START_PB: true, LIGHT_RED: true };
  p.forcesEnabled = false;
  const reloaded = migrate(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(reloaded.forces, { START_PB: true, LIGHT_RED: true });
  const c = new Controller();
  c.download(reloaded);
  c.forces = reloaded.forces;
  let out = c.scan({ START_PB: false });
  assert.equal(out.MOTOR, false, 'forces installed but disabled');
  c.forcesEnabled = true;
  out = c.scan({ START_PB: false });
  assert.equal(out.MOTOR, true, 'forced input drives logic');
  assert.equal(out.LIGHT_RED, true, 'forced output');
  c.forces = { MOTOR: false, START_PB: true };
  out = c.scan({});
  assert.equal(out.MOTOR, false, 'forced OFF output wins over logic');
});

test('toggle flips a BOOL in the running controller', () => {
  const p = project([]);
  p.controllerTags.push({ name: 'B', type: 'BOOL' });
  const c = new Controller();
  c.download(p);
  c.toggle('B');
  assert.equal(c.read('B'), true);
  c.toggle('B');
  assert.equal(c.read('B'), false);
});

// ---------------------------------------------------------------- download / upload / compare
test('download copies the project; offline edits show up in compare; upload brings values back', () => {
  const p = project([rung([], [{ type: 'ADD', a: 'N', b: '1', dest: 'N' }])]);
  p.controllerTags.push({ name: 'N', type: 'DINT' });
  const c = new Controller();
  c.download(p);
  assert.deepEqual(compareProjects(p, c.project), []);
  mainProg(p).routines[0].rungs.push(rung([NO('A')], [OTE('B')]));
  mainProg(p).routines[0].rungs[0].outputs[0].b = '2';
  p.controllerTags.push({ name: 'Extra', type: 'BOOL' });
  const d = compareProjects(p, c.project);
  const paths = d.map((x) => `${x.kind}:${x.path}`);
  assert.ok(paths.includes('changed:MainProgram/MainRoutine rung 0'), paths.join('\n'));
  assert.ok(paths.includes('added:MainProgram/MainRoutine rung 1'));
  assert.ok(paths.includes('added:Controller tag Extra'));
  assert.equal(c.project.tasks[0].programs[0].routines[0].rungs.length, 1, 'controller copy unaffected by offline edits');
  c.scan(); c.scan(); c.scan();
  const up = c.upload();
  assert.equal(up.controllerTags.find((t) => t.name === 'N').value, 3, 'upload captures live values');
  assert.deepEqual(compareProjects(up, c.project), [], 'captured tag values are data, not logic, so compare is clean');
});

test('compare reports no project in controller', () => {
  assert.equal(compareProjects(newProject(), null)[0].online, '(no project downloaded)');
});

// ---------------------------------------------------------------- cross reference
test('cross reference classifies reads and writes per scope', () => {
  const ex = exampleProject('ide-demo').project;
  const x = crossReference(ex);
  const line = x.get('Controller::Line');
  assert.ok(line.usages.some((u) => u.ref === 'Line.Running' && u.access === 'write' && u.instruction === 'AOI'));
  assert.ok(line.usages.some((u) => u.ref === 'Line.Running' && u.access === 'read' && u.instruction === 'NO'));
  assert.ok(line.usages.some((u) => u.ref === 'Line.BoxesPerMin' && u.access === 'write' && u.location === 'Stats/MainRoutine'));
  const ctr = x.get('Conveyor::BoxCtr');
  assert.deepEqual(ctr.usages.map((u) => u.access).sort(), ['read', 'write', 'write']);
  assert.ok(x.get('Controller::START_PB').usages.some((u) => u.instruction === 'Input module' && u.access === 'write'));
  assert.ok(x.get('AOI:MotorCtl::Sealed').usages.length >= 2);
  assert.deepEqual(instructionRefs({ type: 'MOV', src: '5', dest: 'X' }), [{ ref: 'X', access: 'write' }]);
});

test('verify flags undeclared tags and missing JSR targets', () => {
  const p = project([rung([NO('Mystery')], [{ type: 'JSR', routine: 'Nope' }])]);
  const w = verifyProject(p);
  assert.ok(w.some((m) => m.includes('Mystery')));
  assert.ok(w.some((m) => m.includes('Nope')));
  assert.deepEqual(verifyProject(exampleProject('ide-demo').project), []);
});

test('rungText produces Logix-style mnemonics', () => {
  const r = cloneExample('seal-in').program.rungs[0];
  assert.equal(rungText(r), '[XIC(START_PB),XIC(MOTOR)] XIO(STOP_PB) XIO(ESTOP) OTE(MOTOR);');
});

// ---------------------------------------------------------------- migration / backward compatibility
test('v1 programs migrate into Controller > MainTask > MainProgram > MainRoutine with declared tags', () => {
  const v1 = cloneExample('batch-counter').program;
  const p = migrate(v1);
  assert.equal(p.version, 2);
  assert.equal(p.tasks[0].name, 'MainTask');
  assert.equal(p.tasks[0].programs[0].mainRoutine, 'MainRoutine');
  assert.equal(p.tasks[0].programs[0].routines[0].rungs.length, v1.rungs.length);
  const t = Object.fromEntries(p.controllerTags.map((x) => [x.name, x.type]));
  assert.equal(t.C1, 'COUNTER');
  assert.equal(t.RUN, 'BOOL');
  assert.equal(t.MOTOR, 'BOOL');
  assert.deepEqual(verifyProject(p), []);
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(p))), p, 'v2 round-trips unchanged');
});

test('validateProject rejects broken projects', () => {
  assert.throws(() => validateProject({}), /tasks/);
  const p = newProject();
  p.controllerTags.push({ name: 'X', type: 'NOPE' });
  assert.throws(() => validateProject(p), /unknown type/);
  const q = newProject();
  q.tasks.push(clone(q.tasks[0]));
  assert.throws(() => validateProject(q), /duplicate/);
  assert.throws(() => validateProgram({ rungs: [rung([{ type: 'GRT', a: 'bad tag', b: '1' }], [])] }), /operand/);
});

test('initState builds controller and program scopes', () => {
  const s = initState(exampleProject('ide-demo').project);
  assert.equal(s.counters.BoxCtr, undefined);
  assert.ok(s.programs.Conveyor.counters.BoxCtr);
  assert.equal(s.programs.Stats.tags.BatchSize, 10);
  assert.equal(s.tags.Motor1.Run, false);
});

// ---------------------------------------------------------------- operator panel fixes
test('quick button taps are latched until a scan has seen them', () => {
  const f = new Factory(null);
  f.press('START_PB');
  f.release('START_PB'); // released before any scan
  assert.equal(f.readInputs().START_PB, true, 'still seen by the next scan');
  f.consumeInputs();
  assert.equal(f.readInputs().START_PB, false, 'cleared after one scan');
  f.press('STOP_PB');
  f.consumeInputs();
  assert.equal(f.readInputs().STOP_PB, true, 'held button stays on');
  f.release('STOP_PB');
  assert.equal(f.readInputs().STOP_PB, false);
});

test('RESET releases the E-stop latch, and so does releaseEstop()', () => {
  const f = new Factory(null);
  f.press('ESTOP');
  assert.equal(f.readInputs().ESTOP, true);
  f.press('RESET_PB'); f.release('RESET_PB');
  assert.equal(f.readInputs().ESTOP, false);
  f.press('ESTOP');
  f.releaseEstop();
  assert.equal(f.readInputs().ESTOP, false);
});

test('a single tap of START through the controller starts the seal-in', () => {
  const p = exampleProject('seal-in').project;
  const c = new Controller();
  c.download(p);
  c.mode = 'run';
  const f = new Factory(null);
  f.press('START_PB'); f.release('START_PB');
  for (let i = 0; i < 3; i++) { f.setOutputs(c.scan(f.readInputs(), 50)); f.consumeInputs(); }
  assert.equal(f.outputs.MOTOR, true);
});

// ---------------------------------------------------------------- editor ops for new instructions
test('editor ops add compare, math, JSR and AOI instructions that validate', () => {
  const r = { rungs: [{ comment: '', logic: [], outputs: [] }] };
  let sel = { r: 0, kind: 'rung' };
  sel = ops.insertItem(r, sel, { type: 'GRT', a: 'Tank.Level', b: '50' });
  ops.addOutput(r, sel, 'MOV');
  ops.addOutput(r, sel, 'ADD');
  ops.addOutput(r, sel, 'JSR', { routine: 'Sub' });
  ops.addOutput(r, sel, 'AOI', { aoi: 'MotorCtl', tag: 'M1' });
  validateProgram(r);
  assert.equal(r.rungs[0].outputs.map((o) => o.type).join(), 'MOV,ADD,JSR,AOI');
});

// ---------------------------------------------------------------- whole-project simulations
function simProject(p, seconds, setup) {
  const c = new Controller();
  c.download(p);
  c.mode = 'run';
  const f = new Factory(null);
  const dt = 0.05;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const t = i * dt;
    if (setup) setup(f, t, i);
    f.setOutputs(c.scan(f.readInputs(), 50));
    f.consumeInputs();
    f.step(dt);
  }
  return { c, f };
}

test('every example (migrated v1 and v2) downloads and runs without faults', () => {
  for (const ex of ALL_EXAMPLES) {
    const { c } = simProject(exampleProject(ex.id).project, 3, (f, t) => { if (t === 0.1) f.press('START_PB'); if (t > 0.2) f.release('START_PB'); });
    assert.equal(c.fault, null, ex.id);
  }
});

test('IDE demo: AOI motor control, UDT count, periodic stats, batch done, RESET', () => {
  let spawned = 0;
  const { c, f } = simProject(exampleProject('ide-demo').project, 70, (f, t, i) => {
    if (i === 2) f.press('START_PB');
    if (i === 3) f.release('START_PB');
    if (i % 40 === 0 && spawned < 14 && f.spawnBox(false)) spawned++;
  });
  assert.equal(c.fault, null);
  assert.equal(c.read('Line.BoxCount'), 10, 'stopped at batch size');
  assert.equal(c.read('Line.BatchDone'), true);
  assert.equal(c.read('Line.Running'), false, 'MotorCtl dropped out on lost permit');
  assert.equal(f.outputs.MOTOR, false);
  assert.ok(c.traces['Conveyor/Lights'], 'JSR routine executed');
  assert.ok(c.traces['AOI:Blink'], 'Blink AOI executed');
  // RESET then START begins a new batch
  c.write('Line.BoxesPerMin', 0);
  const f2 = f;
  for (let i = 0; i < 60; i++) {
    if (i === 0) f2.press('RESET_PB');
    if (i === 1) f2.release('RESET_PB');
    if (i === 30) f2.press('START_PB');
    if (i === 31) f2.release('START_PB');
    f2.setOutputs(c.scan(f2.readInputs(), 50));
    f2.consumeInputs();
    f2.step(0.05);
  }
  assert.ok(c.read('Line.BoxCount') < 10);
  assert.equal(c.read('Line.BatchDone'), false);
  assert.equal(c.read('Line.Running'), true);
});

test('IDE demo: periodic task computes boxes per minute into the REAL member', () => {
  const p = exampleProject('ide-demo').project;
  const c = new Controller();
  c.download(p);
  c.write('BoxCtr', 0, 'Conveyor');
  c.state.programs.Conveyor.counters.BoxCtr.acc = 3;
  for (let i = 0; i < 20; i++) c.scan({}, 50);
  assert.equal(c.read('Line.BoxCount'), 3);
  assert.equal(c.read('Line.BoxesPerMin'), 180, '3 boxes in the first second');
  c.state.programs.Conveyor.counters.BoxCtr.acc = 5;
  for (let i = 0; i < 20; i++) c.scan({}, 50);
  assert.equal(c.read('Line.BoxesPerMin'), 120);
  assert.equal(c.read('Delta', 'Stats'), 2);
});
