// Guided tutorial: a dependency-free spotlight tour.
// The step data, the Tour state machine and the placement maths are DOM-free so they can be
// unit tested; TourOverlay is the small browser-only renderer.

export const TOUR_KEY = 'plc-training:tourDone';

/**
 * view: the IDE view to open before the step ('main' = main routine of the first program).
 * targets: CSS selectors; the spotlight covers the union of the first match of each.
 */
export const TOUR_STEPS = [
  {
    id: 'tree', title: 'Project tree', view: null, targets: ['.tree-panel'], mobile: { drawer: true },
    text: 'Your project is organised like a real controller: Controller → Tasks → Programs → Routines, plus tags, I/O configuration, user-defined data types and Add-On Instructions. Click any item to open it.',
  },
  {
    id: 'ladder', title: 'Ladder editor & toolbar', view: 'main', targets: ['#ladder-area .toolbar', '#ladder'], mobile: { panel: 'center' },
    text: 'Select a rung or instruction, then use the toolbar to add contacts (NO/NC), branches, compares, coils, timers, counters, math, JSR and AOI calls. The inspector below edits the selected instruction.',
  },
  {
    id: 'tags', title: 'Tags', view: { kind: 'tags', scope: 'Controller' }, targets: ['table.grid.tags'], mobile: { panel: 'center' },
    text: 'The tag editor lists controller-scoped tags (switch the scope to see a program\'s own tags). Set data types (BOOL, INT, DINT, REAL, TIMER, COUNTER or a UDT), initial values and descriptions.',
  },
  {
    id: 'io', title: 'I/O configuration', view: { kind: 'io' }, targets: ['#view-body table.grid'], mobile: { panel: 'center' },
    text: 'Every field device in the virtual factory is wired to a module channel (e.g. Local:1:I.Data.0), and each channel maps to a tag. Inputs are copied in at the start of each scan, outputs copied out at the end.',
  },
  {
    id: 'run', title: 'Run & Single Scan', view: null, targets: ['#run-controls'], mobile: {},
    text: 'Run scans the program continuously (every 50 ms); Program stops it and turns outputs off; Single Scan executes exactly one scan so you can step through logic. Reset Controller restores the initial tag values.',
  },
  {
    id: 'factory', title: 'Virtual factory', view: null, targets: ['#factory', '.operator'], mobile: { panel: 'factory' },
    text: 'Your outputs drive this conveyor cell: motor, diverter and stack light. Photo-eyes and the START / STOP / RESET / E-STOP buttons are your inputs. Try loading an example, pressing Run, then START.',
  },
  {
    id: 'online', title: 'Download & Go Online', view: 'main', targets: ['#btn-online', '#online-badge', '#btn-download', '#btn-upload', '#sync-badge'], mobile: { panel: 'center', menu: true },
    text: 'You edit the offline project. Download sends it to the simulated controller; Upload pulls the running copy back. Go Online to see energized rungs and live values. The badge tells you whether offline and controller match.',
  },
  {
    id: 'xref', title: 'Cross reference', view: { kind: 'xref' }, targets: ['.xref'], mobile: { panel: 'center' },
    text: 'Find every place a tag is read or written, including I/O module mappings. Click a location to jump straight to that rung.',
  },
  {
    id: 'force', title: 'Forces', view: { kind: 'tags', scope: 'Controller' }, targets: ['#force-col', '#btn-forces', '#forces-badge'], mobile: { panel: 'center' },
    text: 'Force a controller tag ON/OFF (or to a number) from the Force column, then Enable forces. Forces override the field and the logic, persist with the project, and a flashing FORCES ACTIVE badge warns you while they are in effect.',
  },
  {
    id: 'trend', title: 'Trend', view: { kind: 'trend' }, targets: ['#trend-canvas', '.pens'], mobile: { panel: 'center' },
    text: 'Chart tags over time: add pens here or with the 📈 button in the tag editor. Samples are taken every controller scan. That\'s the tour — replay it any time with "? Tour".',
  },
];

function safeGet(storage, key) {
  try { return storage ? storage.getItem(key) : null; } catch { return null; }
}
function safeSet(storage, key, value) {
  try { if (storage) storage.setItem(key, value); } catch { /* storage full or blocked */ }
}

/** Tour state machine. Callbacks: onShow(step, index, total), onEnd(reason). */
export class Tour {
  constructor(steps = TOUR_STEPS, { storage = null, onShow = () => {}, onEnd = () => {} } = {}) {
    if (!steps.length) throw new Error('A tour needs at least one step');
    this.steps = steps;
    this.storage = storage;
    this.onShow = onShow;
    this.onEnd = onEnd;
    this.index = 0;
    this.active = false;
  }

  /** True on the first visit (no finished/skipped flag stored). */
  static shouldAutoStart(storage) {
    return !safeGet(storage, TOUR_KEY);
  }

  get step() { return this.steps[this.index]; }
  get total() { return this.steps.length; }
  get isFirst() { return this.index === 0; }
  get isLast() { return this.index === this.steps.length - 1; }

  /** Start (or replay) from the first step, regardless of the stored flag. */
  start(index = 0) {
    this.active = true;
    this.goTo(index);
    return this;
  }

  goTo(i) {
    if (!this.active) return;
    this.index = Math.max(0, Math.min(this.steps.length - 1, i));
    this.onShow(this.step, this.index, this.total);
  }

  next() {
    if (!this.active) return;
    if (this.isLast) this.finish();
    else this.goTo(this.index + 1);
  }

  back() {
    if (!this.active || this.isFirst) return;
    this.goTo(this.index - 1);
  }

  skip() { this.end('skipped'); }
  finish() { this.end('finished'); }

  end(reason) {
    if (!this.active) return;
    this.active = false;
    safeSet(this.storage, TOUR_KEY, reason);
    this.onEnd(reason);
  }
}

// ------------------------------------------------------------------ geometry (pure)

/** Bounding box of several rects ({left, top, width, height}); null if none have area. */
export function unionRect(rects) {
  const rs = rects.filter((r) => r && r.width > 0 && r.height > 0);
  if (!rs.length) return null;
  const left = Math.min(...rs.map((r) => r.left));
  const top = Math.min(...rs.map((r) => r.top));
  const right = Math.max(...rs.map((r) => r.left + r.width));
  const bottom = Math.max(...rs.map((r) => r.top + r.height));
  return { left, top, width: right - left, height: bottom - top };
}

/** Clip a rect to the viewport (with padding added first). */
export function clipRect(rect, vp, pad = 0) {
  if (!rect) return null;
  const left = Math.max(0, rect.left - pad);
  const top = Math.max(0, rect.top - pad);
  const right = Math.min(vp.width, rect.left + rect.width + pad);
  const bottom = Math.min(vp.height, rect.top + rect.height + pad);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Where to put the caption bubble next to a target rect, inside the viewport.
 * Tries below, above, right, left; falls back to bottom-centre over the target.
 */
export function placeBubble(rect, size, vp, gap = 12, margin = 8) {
  const { width: w, height: h } = size;
  const maxLeft = Math.max(margin, vp.width - w - margin);
  const maxTop = Math.max(margin, vp.height - h - margin);
  if (!rect) return { side: 'center', left: clamp((vp.width - w) / 2, margin, maxLeft), top: clamp((vp.height - h) / 2, margin, maxTop) };
  const cx = clamp(rect.left + rect.width / 2 - w / 2, margin, maxLeft);
  const cy = clamp(rect.top + rect.height / 2 - h / 2, margin, maxTop);
  const below = rect.top + rect.height + gap;
  if (below + h <= vp.height - margin) return { side: 'bottom', left: cx, top: below };
  const above = rect.top - gap - h;
  if (above >= margin) return { side: 'top', left: cx, top: above };
  const right = rect.left + rect.width + gap;
  if (right + w <= vp.width - margin) return { side: 'right', left: right, top: cy };
  const left = rect.left - gap - w;
  if (left >= margin) return { side: 'left', left, top: cy };
  return { side: 'over', left: clamp((vp.width - w) / 2, margin, maxLeft), top: maxTop };
}

// ------------------------------------------------------------------ DOM overlay (browser only)

export class TourOverlay {
  /**
   * prepare(step): open the step's view (synchronously) before it is measured.
   */
  constructor({ prepare = () => {}, storage = null, steps = TOUR_STEPS, onEnd = () => {} } = {}) {
    this.prepare = prepare;
    this.tour = new Tour(steps, {
      storage,
      onShow: (step, i, n) => this.show(step, i, n),
      onEnd: (reason) => { this.teardown(); onEnd(reason); },
    });
    this.reposition = this.reposition.bind(this);
    this.onKey = this.onKey.bind(this);
  }

  get active() { return this.tour.active; }

  start() {
    if (this.tour.active) return;
    this.build();
    this.tour.start(0);
  }

  build() {
    const root = document.createElement('div');
    root.className = 'tour-root';
    root.innerHTML = `
      <div class="tour-blocker"></div>
      <div class="tour-spot"></div>
      <div class="tour-bubble" role="dialog" aria-modal="true" aria-labelledby="tour-title" tabindex="-1">
        <div class="tour-count"></div>
        <h3 id="tour-title" class="tour-title"></h3>
        <p class="tour-text"></p>
        <div class="tour-actions">
          <button type="button" class="btn ghost tour-skip">Skip</button>
          <span class="tour-gap"></span>
          <button type="button" class="btn tour-back">Back</button>
          <button type="button" class="btn run tour-next">Next</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    this.spot = root.querySelector('.tour-spot');
    this.bubble = root.querySelector('.tour-bubble');
    root.querySelector('.tour-skip').addEventListener('click', () => this.tour.skip());
    root.querySelector('.tour-back').addEventListener('click', () => this.tour.back());
    root.querySelector('.tour-next').addEventListener('click', () => this.tour.next());
    window.addEventListener('resize', this.reposition);
    window.addEventListener('scroll', this.reposition, true);
    window.addEventListener('transitionend', this.reposition, true); // e.g. the phone drawer sliding in
    window.addEventListener('keydown', this.onKey, true);
  }

  teardown() {
    window.removeEventListener('resize', this.reposition);
    window.removeEventListener('scroll', this.reposition, true);
    window.removeEventListener('transitionend', this.reposition, true);
    clearTimeout(this.settle);
    window.removeEventListener('keydown', this.onKey, true);
    if (this.root) this.root.remove();
    this.root = null;
  }

  onKey(e) {
    if (!this.tour.active) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.tour.skip(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); this.tour.next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); this.tour.back(); }
  }

  targets() {
    const step = this.tour.step;
    return step.targets.map((s) => document.querySelector(s)).filter(Boolean);
  }

  show(step, i, n) {
    try { this.prepare(step); } catch (e) { console.warn('Tour: could not open view', e); }
    const els = this.targets();
    if (els[0]) els[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.root.querySelector('.tour-count').textContent = `Step ${i + 1} of ${n}`;
    this.root.querySelector('.tour-title').textContent = step.title;
    this.root.querySelector('.tour-text').textContent = step.text;
    this.root.querySelector('.tour-back').disabled = i === 0;
    const next = this.root.querySelector('.tour-next');
    next.textContent = i === n - 1 ? 'Finish' : 'Next';
    this.root.dataset.step = step.id;
    this.reposition();
    clearTimeout(this.settle);
    this.settle = setTimeout(this.reposition, 280); // after layout transitions settle
    next.focus({ preventScroll: true });
  }

  reposition() {
    if (!this.root || !this.tour.active) return;
    const vp = { width: window.innerWidth, height: window.innerHeight };
    const rect = clipRect(unionRect(this.targets().map((e) => e.getBoundingClientRect())), vp, 6);
    if (rect) {
      Object.assign(this.spot.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    } else {
      this.spot.style.display = 'none';
    }
    this.root.classList.toggle('no-target', !rect);
    const b = this.bubble.getBoundingClientRect();
    const pos = placeBubble(rect, { width: b.width || 340, height: b.height || 180 }, vp);
    Object.assign(this.bubble.style, { left: `${pos.left}px`, top: `${pos.top}px` });
    this.bubble.dataset.side = pos.side;
    this.lastRect = rect;
  }
}
