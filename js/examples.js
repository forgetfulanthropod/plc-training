// One-click example programs.
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
