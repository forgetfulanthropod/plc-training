// Simulated controller: holds the downloaded ("running") copy of the project and its memory,
// schedules tasks, maps physical I/O through the I/O configuration and applies forces.
import { Ctx, runRungs, MAX_DEPTH } from './ladder.js';
import { clone, typesOf, declsOf, initState, allPrograms, captureValues, validateProject } from './project.js';

export class Controller {
  constructor() {
    this.project = null;
    this.state = null;
    this.mode = 'program'; // 'program' | 'run'
    this.forces = {};
    this.forcesEnabled = false;
    this.traces = {};
    this.outputs = {};
    this.fault = null;
    this.time = 0; // ms of simulated controller time
  }

  /** Copy the offline project into the controller. Memory is re-initialised; mode goes to PROGRAM. */
  download(project) {
    this.project = validateProject(clone(project));
    this.types = typesOf(this.project);
    this.ctrlDecls = declsOf(this.project.controllerTags);
    this.progDecls = {};
    for (const { program } of allPrograms(this.project)) this.progDecls[program.name] = declsOf(program.tags);
    this.state = initState(this.project);
    this.taskAcc = {};
    this.traces = {};
    this.outputs = {};
    this.fault = null;
    this.mode = 'program';
  }

  /** Copy of the running project with current tag values captured as initial values. */
  upload() {
    if (!this.project) throw new Error('Controller has no project');
    return captureValues(clone(this.project), this.state);
  }

  ctx(programName = null, extra = {}) {
    return new Ctx(this.state, {
      scope: programName ? this.state.programs[programName] : null,
      scopeDecls: programName ? this.progDecls[programName] : null,
      ctrlDecls: this.ctrlDecls,
      types: this.types,
      forces: this.forcesEnabled ? this.forces : null,
      traces: this.traces,
      ...extra,
    });
  }

  runRoutine(program, routine, dt, depth = 0) {
    const ctx = this.ctx(program.name, {
      depth,
      jsr: (name, caller, d) => {
        const target = program.routines.find((r) => r.name === name);
        if (!target) throw new Error(`JSR: routine "${name}" not found in ${program.name}`);
        if (caller.depth + 1 >= MAX_DEPTH) throw new Error('JSR nesting too deep');
        this.runRoutine(program, target, d, caller.depth + 1);
      },
    });
    this.traces[`${program.name}/${routine.name}`] = runRungs(routine.rungs, ctx, dt);
  }

  runProgram(program, dt) {
    const main = program.routines.find((r) => r.name === program.mainRoutine);
    if (main) this.runRoutine(program, main, dt);
  }

  /** Field signals -> input tags via the I/O table. */
  applyInputs(inputs) {
    const c = this.ctx();
    for (const row of this.project.ioConfig) if (row.dir === 'IN' && row.tag) c.write(row.tag, !!inputs[row.signal]);
  }

  /** Output tags -> field signals via the I/O table (forces applied). */
  computeOutputs() {
    const c = this.ctx();
    const o = {};
    for (const row of this.project.ioConfig) if (row.dir === 'OUT') o[row.signal] = row.tag ? c.bit(row.tag) : false;
    this.outputs = o;
    return o;
  }

  /** One controller scan of dt ms: inputs, every task due, outputs. */
  scan(inputs = {}, dt = 50) {
    if (!this.project) return null;
    if (this.fault) return this.outputs;
    try {
      this.applyInputs(inputs);
      for (const task of this.project.tasks) {
        if (task.type === 'periodic') {
          this.taskAcc[task.name] = (this.taskAcc[task.name] || 0) + dt;
          while (this.taskAcc[task.name] >= task.period) {
            this.taskAcc[task.name] -= task.period;
            for (const pr of task.programs) this.runProgram(pr, task.period);
          }
        } else {
          for (const pr of task.programs) this.runProgram(pr, dt);
        }
      }
      this.state.scanCount += 1;
      this.time += dt;
    } catch (e) {
      this.fault = e.message;
      this.mode = 'program';
    }
    return this.computeOutputs();
  }

  clearFault() { this.fault = null; }

  /** Clear memory back to the downloaded initial values. */
  reset() {
    if (this.project) { this.state = initState(this.project); this.taskAcc = {}; this.traces = {}; this.outputs = {}; this.fault = null; }
  }

  read(ref, programName = null) {
    if (!this.state) return undefined;
    return this.ctx(programName && this.state.programs[programName] ? programName : null).read(ref);
  }

  write(ref, value, programName = null) {
    if (!this.state) return;
    this.ctx(programName && this.state.programs[programName] ? programName : null).write(ref, value);
  }

  toggle(ref, programName = null) {
    this.write(ref, !this.ctx(programName && this.state.programs[programName] ? programName : null).bit(ref), programName);
  }
}
