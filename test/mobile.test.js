import test from 'node:test';
import assert from 'node:assert/strict';
import { TABS, tabForView, viewForTab, rememberView } from '../js/mobile.js';
import { TOUR_STEPS } from '../js/tour.js';
import { exampleProject } from '../js/examples.js';

const demo = () => exampleProject('ide-demo').project;

test('mobile: tab bar has the main areas plus the project drawer', () => {
  assert.deepEqual(TABS.map((t) => t.id), ['project', 'ladder', 'factory', 'tags', 'trend']);
});

test('mobile: views map to tabs', () => {
  assert.equal(tabForView('routine'), 'ladder');
  assert.equal(tabForView('aoi'), 'ladder');
  assert.equal(tabForView('tags'), 'tags');
  assert.equal(tabForView('io'), 'tags');
  assert.equal(tabForView('udt'), 'tags');
  assert.equal(tabForView('trend'), 'trend');
  assert.equal(tabForView('xref'), null);
  assert.equal(tabForView(undefined), null);
});

test('mobile: Ladder tab opens the first main routine, then remembers the last routine', () => {
  const p = demo();
  const first = p.tasks.flatMap((t) => t.programs)[0];
  assert.deepEqual(viewForTab('ladder', { kind: 'tags', scope: 'Controller' }, p, {}),
    { kind: 'routine', program: first.name, routine: first.mainRoutine });
  // already on a routine: no change
  assert.equal(viewForTab('ladder', { kind: 'routine', program: first.name, routine: first.mainRoutine }, p, {}), null);
  const mem = {};
  const other = first.routines[first.routines.length - 1];
  rememberView(mem, { kind: 'routine', program: first.name, routine: other.name, rung: 3 });
  assert.equal(mem.ladder.rung, undefined);
  assert.deepEqual(viewForTab('ladder', { kind: 'xref' }, p, mem), { kind: 'routine', program: first.name, routine: other.name, rung: undefined });
  // a remembered routine that no longer exists falls back to the main routine
  const gone = { ladder: { kind: 'routine', program: first.name, routine: 'Deleted' } };
  assert.equal(viewForTab('ladder', { kind: 'xref' }, p, gone).routine, first.mainRoutine);
});

test('mobile: Tags·IO tab returns to the last tags or I/O view; Trend opens the trend', () => {
  const p = demo();
  assert.deepEqual(viewForTab('tags', { kind: 'trend' }, p, {}), { kind: 'tags', scope: 'Controller' });
  const mem = rememberView({}, { kind: 'io' });
  assert.deepEqual(viewForTab('tags', { kind: 'routine' }, p, mem), { kind: 'io', rung: undefined });
  assert.equal(viewForTab('tags', { kind: 'io' }, p, mem), null);
  assert.deepEqual(viewForTab('trend', { kind: 'tags' }, p, {}), { kind: 'trend' });
  assert.equal(viewForTab('trend', { kind: 'trend' }, p, {}), null);
  assert.equal(viewForTab('factory', { kind: 'tags' }, p, {}), null);
});

test('mobile: a project without programs still gives the Ladder tab a view', () => {
  const p = { tasks: [], aois: [] };
  assert.deepEqual(viewForTab('ladder', { kind: 'tags' }, p, {}), { kind: 'controller' });
});

test('mobile: every tour step says which phone panel / drawer / menu to show', () => {
  for (const s of TOUR_STEPS) {
    assert.ok(s.mobile && typeof s.mobile === 'object', s.id);
    if (s.mobile.panel) assert.ok(['center', 'factory'].includes(s.mobile.panel), s.id);
  }
  assert.equal(TOUR_STEPS.find((s) => s.id === 'tree').mobile.drawer, true);
  assert.equal(TOUR_STEPS.find((s) => s.id === 'factory').mobile.panel, 'factory');
  assert.equal(TOUR_STEPS.find((s) => s.id === 'online').mobile.menu, true);
});
