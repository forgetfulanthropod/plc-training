import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tour, TOUR_STEPS, TOUR_KEY, placeBubble, unionRect, clipRect } from '../js/tour.js';

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
}

function make(storage = new MemStorage()) {
  const shown = [];
  const ended = [];
  const tour = new Tour(TOUR_STEPS, { storage, onShow: (s, i, n) => shown.push([s.id, i, n]), onEnd: (r) => ended.push(r) });
  return { tour, shown, ended, storage };
}

test('tour has 8-10 steps covering the required areas, each with a title, text and targets', () => {
  assert.ok(TOUR_STEPS.length >= 8 && TOUR_STEPS.length <= 10);
  assert.deepEqual(TOUR_STEPS.map((s) => s.id), ['tree', 'ladder', 'tags', 'io', 'run', 'factory', 'online', 'xref', 'force', 'trend']);
  for (const s of TOUR_STEPS) {
    assert.ok(s.title && s.text && s.targets.length, s.id);
    assert.ok(s.view === null || s.view === 'main' || typeof s.view.kind === 'string', s.id);
  }
  assert.equal(new Set(TOUR_STEPS.map((s) => s.id)).size, TOUR_STEPS.length);
});

test('first visit auto-starts; no flag stored until the tour ends', () => {
  const { tour, storage } = make();
  assert.equal(Tour.shouldAutoStart(storage), true);
  tour.start();
  assert.equal(tour.active, true);
  assert.equal(storage.getItem(TOUR_KEY), null);
  assert.equal(Tour.shouldAutoStart(storage), true, 'closing the tab mid-tour shows it again next time');
});

test('next/back navigate within bounds and report each step', () => {
  const { tour, shown } = make();
  tour.start();
  tour.back();
  assert.equal(tour.index, 0, 'back on first step is a no-op');
  tour.next(); tour.next();
  assert.equal(tour.index, 2);
  tour.back();
  assert.equal(tour.index, 1);
  assert.deepEqual(shown.map((x) => x[1]), [0, 1, 2, 1]);
  assert.equal(shown[0][2], TOUR_STEPS.length);
  assert.equal(tour.isFirst, false);
});

test('skip ends the tour, stores the flag and suppresses auto-start', () => {
  const { tour, ended, storage } = make();
  tour.start();
  tour.next();
  tour.skip();
  assert.equal(tour.active, false);
  assert.deepEqual(ended, ['skipped']);
  assert.equal(storage.getItem(TOUR_KEY), 'skipped');
  assert.equal(Tour.shouldAutoStart(storage), false);
  tour.next(); tour.skip();
  assert.deepEqual(ended, ['skipped'], 'inactive tour ignores further input');
});

test('Next on the last step finishes and stores the flag', () => {
  const { tour, ended, storage } = make();
  tour.start();
  for (let i = 0; i < TOUR_STEPS.length - 1; i++) tour.next();
  assert.equal(tour.isLast, true);
  assert.equal(tour.active, true);
  tour.next();
  assert.equal(tour.active, false);
  assert.deepEqual(ended, ['finished']);
  assert.equal(storage.getItem(TOUR_KEY), 'finished');
  assert.equal(Tour.shouldAutoStart(storage), false);
});

test('replay starts again from step 1 even after the flag is set', () => {
  const { tour, shown, ended, storage } = make();
  tour.start(); tour.next(); tour.next(); tour.finish();
  assert.equal(Tour.shouldAutoStart(storage), false);
  tour.start();
  assert.equal(tour.active, true);
  assert.equal(tour.index, 0);
  assert.deepEqual(shown.at(-1), ['tree', 0, TOUR_STEPS.length]);
  tour.skip();
  assert.deepEqual(ended, ['finished', 'skipped']);
});

test('broken or missing storage never throws and defaults to showing the tour', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.equal(Tour.shouldAutoStart(broken), true);
  assert.equal(Tour.shouldAutoStart(null), true);
  const { tour, ended } = make(broken);
  tour.start();
  assert.doesNotThrow(() => tour.skip());
  assert.deepEqual(ended, ['skipped']);
});

test('geometry: unionRect, clipRect', () => {
  assert.deepEqual(unionRect([{ left: 10, top: 10, width: 10, height: 10 }, { left: 30, top: 5, width: 5, height: 5 }, { left: 0, top: 0, width: 0, height: 0 }]),
    { left: 10, top: 5, width: 25, height: 15 });
  assert.equal(unionRect([]), null);
  assert.deepEqual(clipRect({ left: -20, top: 100, width: 100, height: 2000 }, { width: 400, height: 800 }, 6), { left: 0, top: 94, width: 86, height: 706 });
  assert.equal(clipRect({ left: 500, top: 0, width: 10, height: 10 }, { width: 400, height: 800 }), null);
});

test('geometry: placeBubble prefers below, then above, side, and stays in the viewport', () => {
  const vp = { width: 1000, height: 800 };
  const size = { width: 300, height: 150 };
  assert.equal(placeBubble({ left: 100, top: 100, width: 200, height: 50 }, size, vp).side, 'bottom');
  assert.equal(placeBubble({ left: 100, top: 600, width: 200, height: 150 }, size, vp).side, 'top');
  assert.equal(placeBubble({ left: 0, top: 0, width: 500, height: 800 }, size, vp).side, 'right');
  assert.equal(placeBubble({ left: 600, top: 0, width: 400, height: 800 }, size, vp).side, 'left');
  const over = placeBubble({ left: 0, top: 0, width: 1000, height: 800 }, size, vp);
  assert.equal(over.side, 'over');
  const c = placeBubble(null, size, vp);
  assert.equal(c.side, 'center');
  for (const p of [over, c, placeBubble({ left: 950, top: 10, width: 40, height: 20 }, size, vp)]) {
    assert.ok(p.left >= 8 && p.left + size.width <= vp.width - 8 && p.top >= 8 && p.top + size.height <= vp.height - 8, JSON.stringify(p));
  }
  const phone = placeBubble({ left: 0, top: 50, width: 390, height: 300 }, { width: 374, height: 200 }, { width: 390, height: 844 });
  assert.ok(phone.left >= 8 && phone.left + 374 <= 390 - 8 + 0.001);
});
