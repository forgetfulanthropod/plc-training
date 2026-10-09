import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState, scan, evaluateRung, getBit, validateProgram, normalizeSeries, collectTags,
} from '../js/ladder.js';
import { EXAMPLES, cloneExample } from '../js/examples.js';
import { ops } from '../js/editor.js';
import { Factory } from '../js/factory.js';

const NO = (tag) => ({ type: 'NO', tag });
const NC = (tag) => ({ type: 'NC', tag });
const BR = (...legs) => ({ type: 'BRANCH', legs });
const prog = (...rungs) => ({ name: 't', rungs: rungs.map(([logic, outputs]) => ({ comment: '', logic, outputs })) });

test('NO contact passes power only when tag is ON', () => {
  const p = prog([[NO('A')], [{ type: 'OTE', tag: 'Y' }]]);
  const s = createState();
  scan(p, s, { A: false });
  assert.equal(s.tags.Y, false);
  scan(p, s, { A: true });
  assert.equal(s.tags.Y, true);
});

test('NC contact passes power only when tag is OFF', () => {
  const p = prog([[NC('A')], [{ type: 'OTE', tag: 'Y' }]]);
  const s = createState();
  scan(p, s, { A: false });
  assert.equal(s.tags.Y, true);
  scan(p, s, { A: true });
  assert.equal(s.tags.Y, false);
});

test('series contacts are AND, branches are OR', () => {
  const p = prog([[NO('A'), BR([NO('B')], [NO('C')])], [{ type: 'OTE', tag: 'Y' }]]);
  const truth = [
    [0, 0, 0, 0], [0, 1, 1, 0], [1, 0, 0, 0], [1, 1, 0, 1], [1, 0, 1, 1], [1, 1, 1, 1],
  ];
  for (const [a, b, c, y] of truth) {
    const s = createState();
    scan(p, s, { A: !!a, B: !!b, C: !!c });
    assert.equal(s.tags.Y, !!y, `A=${a} B=${b} C=${c}`);
  }
});

test('empty rung logic is always true', () => {
  const s = createState();
  scan(prog([[], [{ type: 'OTE', tag: 'Y' }]]), s, {});
  assert.equal(s.tags.Y, true);
});

test('multiple outputs on one rung all follow rung power', () => {
  const s = createState();
  scan(prog([[NO('A')], [{ type: 'OTE', tag: 'Y1' }, { type: 'OTE', tag: 'Y2' }]]), s, { A: true });
  assert.equal(s.tags.Y1, true);
  assert.equal(s.tags.Y2, true);
});

test('start/stop seal-in circuit latches and drops out', () => {
  const p = prog([[BR([NO('START')], [NO('M')]), NC('STOP')], [{ type: 'OTE', tag: 'M' }]]);
  const s = createState();
  scan(p, s, { START: false, STOP: false });
  assert.equal(s.tags.M, false);
  scan(p, s, { START: true, STOP: false });
  assert.equal(s.tags.M, true, 'starts');
  scan(p, s, { START: false, STOP: false });
  assert.equal(s.tags.M, true, 'seals in after START released');
  scan(p, s, { START: false, STOP: true });
  assert.equal(s.tags.M, false, 'stop drops out');
  scan(p, s, { START: false, STOP: false });
  assert.equal(s.tags.M, false, 'stays off');
  scan(p, s, { START: true, STOP: true });
  assert.equal(s.tags.M, false, 'stop wins over start');
});

test('rungs are solved top to bottom within one scan', () => {
  const p = prog(
    [[NO('A')], [{ type: 'OTE', tag: 'B' }]],
    [[NO('B')], [{ type: 'OTE', tag: 'C' }]],
  );
  const s = createState();
  scan(p, s, { A: true });
  assert.equal(s.tags.C, true, 'second rung sees first rung result in the same scan');
  // reverse order: needs one extra scan to propagate
  const q = prog(
    [[NO('B')], [{ type: 'OTE', tag: 'C' }]],
    [[NO('A')], [{ type: 'OTE', tag: 'B' }]],
  );
  const s2 = createState();
  scan(q, s2, { A: true });
  assert.equal(s2.tags.C, false);
  scan(q, s2, { A: true });
  assert.equal(s2.tags.C, true);
});

test('OTL / OTU latch and unlatch', () => {
  const p = prog(
    [[NO('SET')], [{ type: 'OTL', tag: 'L' }]],
    [[NO('CLR')], [{ type: 'OTU', tag: 'L' }]],
  );
  const s = createState();
  scan(p, s, { SET: true, CLR: false });
  assert.equal(s.tags.L, true);
  scan(p, s, { SET: false, CLR: false });
  assert.equal(s.tags.L, true, 'remains latched');
  scan(p, s, { SET: false, CLR: true });
  assert.equal(s.tags.L, false);
});

test('TON accumulates while true, sets DN at preset, resets when false', () => {
  const p = prog(
    [[NO('IN')], [{ type: 'TON', tag: 'T1', preset: 200 }]],
    [[NO('T1.DN')], [{ type: 'OTE', tag: 'Y' }]],
  );
  const s = createState();
  scan(p, s, { IN: true }, 50);
  assert.equal(s.timers.T1.acc, 50);
  assert.equal(getBit(s, 'T1.EN'), true);
  assert.equal(getBit(s, 'T1.TT'), true);
  assert.equal(getBit(s, 'T1.DN'), false);
  scan(p, s, { IN: true }, 50);
  scan(p, s, { IN: true }, 50);
  assert.equal(s.tags.Y, false);
  scan(p, s, { IN: true }, 50);
  assert.equal(s.timers.T1.acc, 200);
  assert.equal(getBit(s, 'T1.DN'), true);
  assert.equal(getBit(s, 'T1.TT'), false);
  assert.equal(s.tags.Y, true, 'later rung sees DN in same scan');
  scan(p, s, { IN: true }, 50);
  assert.equal(s.timers.T1.acc, 200, 'ACC is clamped at PRE');
  scan(p, s, { IN: false }, 50);
  assert.equal(s.timers.T1.acc, 0);
  assert.equal(getBit(s, 'T1.DN'), false);
  assert.equal(getBit(s, 'T1.EN'), false);
});

test('CTU counts rising edges only and RES clears it', () => {
  const p = prog(
    [[NO('PE')], [{ type: 'CTU', tag: 'C1', preset: 3 }]],
    [[NO('RST')], [{ type: 'RES', tag: 'C1' }]],
  );
  const s = createState();
  const pulse = () => { scan(p, s, { PE: true, RST: false }); scan(p, s, { PE: true, RST: false }); scan(p, s, { PE: false, RST: false }); };
  pulse();
  assert.equal(s.counters.C1.acc, 1, 'holding input true does not keep counting');
  pulse(); pulse();
  assert.equal(s.counters.C1.acc, 3);
  assert.equal(getBit(s, 'C1.DN'), true);
  pulse();
  assert.equal(s.counters.C1.acc, 4, 'keeps counting past preset');
  scan(p, s, { PE: false, RST: true });
  assert.equal(s.counters.C1.acc, 0);
  assert.equal(getBit(s, 'C1.DN'), false);
});

test('trace records power flow and contact state for highlighting', () => {
  const rung = { logic: [NO('A'), BR([NO('B')], [NC('C')])], outputs: [{ type: 'OTE', tag: 'Y' }] };
  const s = createState();
  s.tags = { A: true, B: false, C: false };
  const r = evaluateRung(rung, s, 50);
  assert.equal(r.power, true);
  assert.deepEqual(r.trace['0'], { powerIn: true, powerOut: true, closed: true });
  assert.deepEqual(r.trace['1.0.0'], { powerIn: true, powerOut: false, closed: false });
  assert.deepEqual(r.trace['1.1.0'], { powerIn: true, powerOut: true, closed: true });
  assert.equal(r.trace['1'].powerOut, true);
  assert.equal(r.trace['1.0'].powerOut, false);
});

test('unknown timer/counter members read as false', () => {
  const s = createState();
  assert.equal(getBit(s, 'T9.DN'), false);
  assert.equal(getBit(s, ''), false);
});

test('normalizeSeries removes empty legs and flattens single-leg branches', () => {
  const s = [NO('A'), BR([NO('B')], []), BR([], [])];
  normalizeSeries(s);
  assert.deepEqual(s, [NO('A'), NO('B')]);
});

test('validateProgram accepts good programs and rejects bad ones', () => {
  assert.doesNotThrow(() => validateProgram(prog([[NO('A')], [{ type: 'TON', tag: 'T1', preset: '100' }]])));
  assert.throws(() => validateProgram({}), /rungs/);
  assert.throws(() => validateProgram(prog([[{ type: 'XX', tag: 'A' }], []])), /unknown type/);
  assert.throws(() => validateProgram(prog([[NO('bad tag')], []])), /bad tag/);
  assert.throws(() => validateProgram(prog([[], [{ type: 'TON', tag: 'T1', preset: -1 }]])), /preset/);
});

test('JSON export/import round-trip preserves behaviour', () => {
  const p = cloneExample('dwell-timer').program;
  const q = validateProgram(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(q, validateProgram(p));
});

test('collectTags finds bits, timers and counters', () => {
  const t = collectTags(cloneExample('batch-counter').program);
  assert.ok(t.bits.has('RUN') && t.bits.has('MOTOR') && t.bits.has('C1.DN'));
  assert.ok(t.counters.has('C1'));
});

test('all examples validate and scan without errors', () => {
  for (const ex of EXAMPLES) {
    const p = validateProgram(cloneExample(ex.id).program);
    const s = createState();
    for (let i = 0; i < 5; i++) scan(p, s, { START_PB: i === 1 });
  }
});

test('editor ops: insert, branch, outputs and delete keep a valid program', () => {
  const p = { name: 'x', rungs: [{ comment: '', logic: [], outputs: [] }] };
  let sel = { r: 0, kind: 'rung' };
  sel = ops.insertContact(p, sel, 'NO', 'START_PB');
  const startSel = sel;
  sel = ops.addBranch(p, sel, 'MOTOR');           // START_PB || MOTOR
  sel = ops.insertContact(p, { r: 0, kind: 'branch', path: [0] }, 'NC', 'STOP_PB');
  sel = ops.addOutput(p, sel, 'OTE');
  p.rungs[0].outputs[0].tag = 'MOTOR';
  assert.deepEqual(p.rungs[0].logic, [BR([NO('START_PB')], [NO('MOTOR')]), NC('STOP_PB')]);
  validateProgram(p);
  const s = createState();
  scan(p, s, { START_PB: true });
  scan(p, s, { START_PB: false });
  assert.equal(s.tags.MOTOR, true);
  // deleting a leg collapses the branch
  ops.remove(p, { r: 0, kind: 'item', path: [0, 1, 0] });
  assert.deepEqual(p.rungs[0].logic, [NO('START_PB'), NC('STOP_PB')]);
  assert.ok(startSel);
});

// ---------------------------------------------------------------- integration with the factory
function runSim(exampleId, seconds, setup) {
  const ex = cloneExample(exampleId);
  const p = validateProgram(ex.program);
  const s = createState();
  const f = new Factory(null);
  f.autoSpawn = false;
  const dt = 0.05;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    if (setup) setup(f, i * dt);
    scan(p, s, f.readInputs(), dt * 1000);
    f.setOutputs(s.tags);
    f.step(dt);
  }
  return { f, s };
}

test('sim: seal-in example runs the conveyor after a START pulse and stops on E-STOP', () => {
  const { f, s } = runSim('seal-in', 2, (f, t) => {
    if (t === 0) f.spawnBox(false);
    f.buttons.START_PB = t > 0.1 && t < 0.3;
  });
  assert.equal(s.tags.MOTOR, true);
  assert.ok(f.boxes[0].x > 150, 'box moved');
  const res = runSim('seal-in', 2, (f, t) => {
    f.buttons.START_PB = t > 0.1 && t < 0.3;
    f.buttons.ESTOP = t > 1;
  });
  assert.equal(res.s.tags.MOTOR, false);
  assert.equal(res.s.tags.LIGHT_RED, true);
});

test('sim: conveyor stops with the box at the end sensor', () => {
  const { f, s } = runSim('stop-at-sensor', 12, (f, t) => {
    if (t === 0) f.spawnBox(false);
    f.buttons.START_PB = t > 0.1 && t < 0.3;
  });
  assert.equal(f.boxes.length, 1, 'box not delivered');
  assert.equal(f.sensorBlocked('PE_END'), true);
  assert.equal(s.tags.MOTOR, false);
  assert.equal(s.tags.RUN, true);
  assert.equal(f.delivered, 0);
});

test('sim: sorter rejects tall boxes and delivers short ones', () => {
  const { f } = runSim('sorter', 25, (f, t) => {
    f.buttons.START_PB = t > 0.1 && t < 0.3;
    const k = Math.round(t / 0.05);
    if (k === 10) f.spawnBox(true);
    if (k === 60) f.spawnBox(false);
    if (k === 110) f.spawnBox(true);
    if (k === 160) f.spawnBox(false);
  });
  assert.equal(f.rejected, 2);
  assert.equal(f.delivered, 2);
});

test('sim: batch counter stops after 5 boxes until RESET', () => {
  let spawned = 0;
  const { f, s } = runSim('batch-counter', 40, (f, t) => {
    f.buttons.START_PB = t > 0.1 && t < 0.3;
    if (Math.round(t / 0.05) % 30 === 0 && spawned < 8 && f.spawnBox(false)) spawned++;
  });
  assert.equal(s.counters.C1.acc, 5);
  assert.equal(s.tags.MOTOR, false);
  assert.equal(s.tags.LIGHT_AMBER, true);
  assert.ok(f.delivered <= 4);
});

test('sim: RESET clears the batch and the conveyor restarts', () => {
  let spawned = 0;
  const { s } = runSim('batch-counter', 45, (f, t) => {
    f.buttons.START_PB = t > 0.1 && t < 0.3;
    if (Math.round(t / 0.05) % 30 === 0 && spawned < 8 && f.spawnBox(false)) spawned++;
    f.buttons.RESET_PB = t > 40 && t < 40.3;
  });
  assert.equal(s.tags.MOTOR, true);
  assert.ok(s.counters.C1.acc < 5);
});

test('sim: dwell timer holds each box at PE_MID for ~3 s', () => {
  let stoppedFor = 0;
  const { f } = runSim('dwell-timer', 15, (f, t) => {
    if (t === 0) f.spawnBox(false);
    f.buttons.START_PB = t > 0.1 && t < 0.3;
    if (f.sensorBlocked('PE_MID') && !f.motorRunning) stoppedFor += 0.05;
  });
  assert.ok(stoppedFor > 2.8 && stoppedFor < 3.3, `stopped ${stoppedFor}s`);
  assert.equal(f.delivered, 1);
});
