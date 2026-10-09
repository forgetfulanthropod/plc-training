// One-click example programs (v1 single-routine programs are migrated into projects on load)
// plus full v2 projects that use tasks, JSR, program tags, UDTs and AOIs.
import { newProject, migrate, clone } from './project.js';

const NO = (tag) => ({ type: 'NO', tag });
const NC = (tag) => ({ type: 'NC', tag });
const BR = (...legs) => ({ type: 'BRANCH', legs });
const OTE = (tag) => ({ type: 'OTE', tag });
const RES = (tag) => ({ type: 'RES', tag });
const TON = (tag, preset) => ({ type: 'TON', tag, preset });
const CTU = (tag, preset) => ({ type: 'CTU', tag, preset });
const rung = (comment, logic, outputs) => ({ comment, logic, outputs });

const runSealIn = (comment = 'RUN seal-in: START latches RUN; STOP or E-STOP drops it') =>
  rung(comment, [BR([NO('START_PB')], [NO('RUN')]), NC('STOP_PB'), NC('ESTOP')], [OTE('RUN')]);

export const EXAMPLES = [
  {
    id: 'seal-in',
    name: 'Start/Stop seal-in motor',
    description: 'Classic 3-wire motor control. Press START to run, STOP or E-STOP to stop. The MOTOR contact in parallel with START "seals in" the coil.',
    factory: { autoSpawn: true },
    program: {
      name: 'Start/Stop seal-in motor',
      rungs: [
        rung('Seal-in: START or MOTOR (holding contact), and not STOP, and not E-STOP', [BR([NO('START_PB')], [NO('MOTOR')]), NC('STOP_PB'), NC('ESTOP')], [OTE('MOTOR')]),
        rung('Green light while running', [NO('MOTOR')], [OTE('LIGHT_GREEN')]),
        rung('Amber light while stopped (and not in E-stop)', [NC('MOTOR'), NC('ESTOP')], [OTE('LIGHT_AMBER')]),
        rung('Red light while E-stop is engaged', [NO('ESTOP')], [OTE('LIGHT_RED')]),
      ],
    },
  },
  {
    id: 'stop-at-sensor',
    name: 'Conveyor stops at end sensor',
    description: 'RUN is a seal-in. The conveyor runs until a box blocks PE_END, then waits. Click the box to pick it off and the conveyor restarts.',
    factory: { autoSpawn: true },
    program: {
      name: 'Conveyor stops at end sensor',
      rungs: [
        runSealIn(),
        rung('Motor runs while RUN and nothing at the end photo-eye', [NO('RUN'), NC('PE_END')], [OTE('MOTOR')]),
        rung('Amber: box waiting to be picked (click it)', [NO('RUN'), NO('PE_END')], [OTE('LIGHT_AMBER')]),
        rung('Green while the conveyor is moving', [NO('MOTOR')], [OTE('LIGHT_GREEN')]),
        rung('Red while E-stop is engaged', [NO('ESTOP')], [OTE('LIGHT_RED')]),
      ],
    },
  },
  {
    id: 'dwell-timer',
    name: 'Timed dwell (TON)',
    description: 'Each box stops at PE_MID for 3 seconds (e.g. a labelling station), then continues. Uses a TON timer and its .DN bit.',
    factory: { autoSpawn: true },
    program: {
      name: 'Timed dwell (TON)',
      rungs: [
        runSealIn(),
        rung('Time how long a box has been at the mid station', [NO('PE_MID')], [TON('T1', 3000)]),
        rung('Run unless a box is at the station and the dwell is not done', [NO('RUN'), BR([NC('PE_MID')], [NO('T1.DN')])], [OTE('MOTOR')]),
        rung('Amber while dwelling', [NO('T1.TT')], [OTE('LIGHT_AMBER')]),
        rung('Green while moving', [NO('MOTOR')], [OTE('LIGHT_GREEN')]),
        rung('Red while E-stop is engaged', [NO('ESTOP')], [OTE('LIGHT_RED')]),
      ],
    },
  },
  {
    id: 'batch-counter',
    name: 'Batch of 5 (CTU)',
    description: 'Counts boxes at PE_END with a CTU. After 5 the conveyor stops and the amber light turns on. Press RESET to start the next batch.',
    factory: { autoSpawn: true },
    program: {
      name: 'Batch of 5 (CTU)',
      rungs: [
        runSealIn(),
        rung('Count boxes reaching the end', [NO('PE_END')], [CTU('C1', 5)]),
        rung('Run until the batch is complete', [NO('RUN'), NC('C1.DN')], [OTE('MOTOR')]),
        rung('Batch complete light', [NO('C1.DN')], [OTE('LIGHT_AMBER')]),
        rung('RESET clears the counter', [NO('RESET_PB')], [RES('C1')]),
        rung('Green while moving', [NO('MOTOR')], [OTE('LIGHT_GREEN')]),
        rung('Red while E-stop is engaged', [NO('ESTOP')], [OTE('LIGHT_RED')]),
      ],
    },
  },
  {
    id: 'sorter',
    name: 'Tall-box sorter',
    description: 'The conveyor runs continuously; when the height sensor PE_TALL sees a tall (blue) box, the DIVERTER pushes it into the reject bin.',
    factory: { autoSpawn: true },
    program: {
      name: 'Tall-box sorter',
      rungs: [
        runSealIn(),
        rung('Conveyor runs while RUN', [NO('RUN')], [OTE('MOTOR')]),
        rung('Fire the diverter when a tall box is in front of it', [NO('RUN'), NO('PE_TALL')], [OTE('DIVERTER')]),
        rung('Green while running', [NO('MOTOR')], [OTE('LIGHT_GREEN')]),
        rung('Amber flash when rejecting', [NO('DIVERTER')], [OTE('LIGHT_AMBER')]),
        rung('Red while E-stop is engaged', [NO('ESTOP')], [OTE('LIGHT_RED')]),
      ],
    },
  },
  {
    id: 'blank',
    name: 'Blank program',
    description: 'Start from scratch.',
    factory: { autoSpawn: false },
    program: { name: 'Untitled', rungs: [{ comment: '', logic: [], outputs: [] }] },
  },
];

export function cloneExample(id) {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex) throw new Error(`No example ${id}`);
  return { ...ex, program: JSON.parse(JSON.stringify({ version: 1, ...ex.program })) };
}

const GRT = (a, b) => ({ type: 'GRT', a: String(a), b: String(b) });
const GEQ = (a, b) => ({ type: 'GEQ', a: String(a), b: String(b) });
const MOV = (src, dest) => ({ type: 'MOV', src: String(src), dest });
const MATH = (type, a, b, dest) => ({ type, a: String(a), b: String(b), dest });
const JSR = (routine) => ({ type: 'JSR', routine });
const AOI = (aoi, tag, args) => ({ type: 'AOI', aoi, tag, args });
void GRT;

function ideDemo() {
  const p = newProject('IDE demo: tasks, JSR, UDT, AOI');
  p.dataTypes.push({
    name: 'ConveyorData',
    description: 'Status of one conveyor line',
    members: [
      { name: 'Running', type: 'BOOL' },
      { name: 'BoxCount', type: 'DINT' },
      { name: 'BoxesPerMin', type: 'REAL' },
      { name: 'BatchDone', type: 'BOOL' },
    ],
  });
  p.aois.push({
    name: 'MotorCtl',
    description: '3-wire start/stop with permissive. Run seals in until Stop or loss of Permit.',
    params: [
      { name: 'Start', usage: 'Input', type: 'BOOL' },
      { name: 'Stop', usage: 'Input', type: 'BOOL' },
      { name: 'Permit', usage: 'Input', type: 'BOOL' },
      { name: 'Run', usage: 'Output', type: 'BOOL' },
    ],
    locals: [{ name: 'Sealed', type: 'BOOL' }],
    rungs: [
      rung('Seal-in', [BR([NO('Start')], [NO('Sealed')]), NC('Stop'), NO('Permit')], [OTE('Sealed')]),
      rung('Drive the output parameter', [NO('Sealed')], [OTE('Run')]),
    ],
  });
  p.aois.push({
    name: 'Blink',
    description: 'Flasher: Out toggles every 500 ms while Enable is on. Uses two local timers.',
    params: [
      { name: 'Enable', usage: 'Input', type: 'BOOL' },
      { name: 'Out', usage: 'Output', type: 'BOOL' },
    ],
    locals: [{ name: 'TOn', type: 'TIMER' }, { name: 'TOff', type: 'TIMER' }],
    rungs: [
      rung('On phase', [NO('Enable'), NC('TOff.DN')], [TON('TOn', 500)]),
      rung('Off phase', [NO('TOn.DN')], [TON('TOff', 500)]),
      rung('Output is on during the second half', [NO('Enable'), NO('TOn.DN')], [OTE('Out')]),
    ],
  });
  p.controllerTags.push(
    { name: 'Line', type: 'ConveyorData', description: 'Line status (UDT)' },
    { name: 'Motor1', type: 'MotorCtl', description: 'Conveyor motor control (AOI instance)' },
    { name: 'Flash1', type: 'Blink', description: 'Batch-done flasher (AOI instance)' },
  );
  const main = p.tasks[0];
  main.programs[0] = {
    name: 'Conveyor',
    mainRoutine: 'MainRoutine',
    tags: [
      { name: 'Permit', type: 'BOOL', description: 'No E-stop and batch not done' },
      { name: 'BoxCtr', type: 'COUNTER', description: 'Boxes delivered' },
      { name: 'Flash', type: 'BOOL', description: 'Flasher output' },
    ],
    routines: [
      {
        name: 'MainRoutine',
        rungs: [
          rung('Permissive: no E-stop and batch not complete', [NC('ESTOP'), NC('Line.BatchDone')], [OTE('Permit')]),
          rung('Motor control via the MotorCtl AOI', [], [AOI('MotorCtl', 'Motor1', { Start: 'START_PB', Stop: 'STOP_PB', Permit: 'Permit', Run: 'Line.Running' })]),
          rung('Drive the conveyor', [NO('Line.Running')], [OTE('MOTOR')]),
          rung('Count boxes at the discharge', [NO('PE_END')], [CTU('BoxCtr', 999999)]),
          rung('Publish the count into the UDT', [], [MOV('BoxCtr.ACC', 'Line.BoxCount')]),
          rung('RESET clears the count (and releases the E-stop button)', [NO('RESET_PB')], [RES('BoxCtr')]),
          rung('Stack lights live in their own routine', [], [JSR('Lights')]),
        ],
      },
      {
        name: 'Lights',
        rungs: [
          rung('Flash amber when the batch is done', [], [AOI('Blink', 'Flash1', { Enable: 'Line.BatchDone', Out: 'Flash' })]),
          rung('Green while running', [NO('Line.Running')], [OTE('LIGHT_GREEN')]),
          rung('Amber: stopped, or flashing at batch done', [BR([NC('Line.Running'), NC('ESTOP'), NC('Line.BatchDone')], [NO('Flash')])], [OTE('LIGHT_AMBER')]),
          rung('Red during E-stop', [NO('ESTOP')], [OTE('LIGHT_RED')]),
        ],
      },
    ],
  };
  p.tasks.push({
    name: 'StatsTask', type: 'periodic', period: 1000,
    programs: [{
      name: 'Stats',
      mainRoutine: 'MainRoutine',
      tags: [
        { name: 'LastCount', type: 'DINT', description: '' },
        { name: 'Delta', type: 'DINT', description: 'Boxes in the last second' },
        { name: 'BatchSize', type: 'DINT', value: 10, description: 'Boxes per batch' },
      ],
      routines: [{
        name: 'MainRoutine',
        rungs: [
          rung('Boxes since last period (runs every 1000 ms)', [], [MATH('SUB', 'Line.BoxCount', 'LastCount', 'Delta'), MOV('Line.BoxCount', 'LastCount')]),
          rung('Rate as REAL', [], [MATH('MUL', 'Delta', 60.0, 'Line.BoxesPerMin')]),
          rung('Batch complete', [GEQ('Line.BoxCount', 'BatchSize')], [OTE('Line.BatchDone')]),
        ],
      }],
    }],
  });
  return p;
}

export const PROJECT_EXAMPLES = [
  {
    id: 'ide-demo',
    name: 'IDE demo: tasks, JSR, UDT, AOI',
    description: 'A continuous task runs the Conveyor program (MotorCtl AOI, JSR to Lights, program-scoped counter). A 1000 ms periodic task computes boxes/min into the Line UDT and sets Line.BatchDone after BatchSize boxes; amber flashes via the Blink AOI. Press RESET to start a new batch.',
    factory: { autoSpawn: true },
    project: ideDemo,
  },
];

export const ALL_EXAMPLES = [...EXAMPLES.filter((e) => e.id !== 'blank'), ...PROJECT_EXAMPLES, EXAMPLES.find((e) => e.id === 'blank')];

/** Any example (v1 or v2) as a validated v2 project. */
export function exampleProject(id) {
  const pe = PROJECT_EXAMPLES.find((e) => e.id === id);
  if (pe) return { ...pe, project: migrate(clone(pe.project())) };
  const ex = cloneExample(id);
  return { ...ex, project: migrate(ex.program) };
}
