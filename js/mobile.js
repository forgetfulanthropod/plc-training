// Phone layout: bottom tab bar, project-tree drawer, overflow ("⋯") menu.
// The tab/view mapping is DOM-free for unit tests; MobileShell is the browser-only part.
// Layout itself is CSS (@media (max-width: 760px)); this module only toggles state classes
// and moves the secondary toolbar controls into the overflow menu while the phone layout is active.

export const MOBILE_QUERY = '(max-width: 760px)';

export const TABS = [
  { id: 'project', icon: '☰', label: 'Project' },
  { id: 'ladder', icon: '≡', label: 'Ladder' },
  { id: 'factory', icon: '🏭', label: 'Factory' },
  { id: 'tags', icon: '🏷', label: 'Tags·IO' },
  { id: 'trend', icon: '📈', label: 'Trend' },
];

/** Which bottom tab a view belongs to (null: a centre view without its own tab, e.g. xref). */
export function tabForView(kind) {
  if (kind === 'routine' || kind === 'aoi') return 'ladder';
  if (kind === 'tags' || kind === 'io' || kind === 'udt') return 'tags';
  if (kind === 'trend') return 'trend';
  return null;
}

function routineExists(project, v) {
  if (!v || !project) return false;
  if (v.kind === 'aoi') return (project.aois || []).some((a) => a.name === v.aoi);
  for (const t of project.tasks || []) {
    for (const p of t.programs) if (p.name === v.program) return p.routines.some((r) => r.name === v.routine);
  }
  return false;
}

/**
 * The view a tab should open, or null when the current view already belongs to that tab
 * (or the tab is not a centre view). `memory` holds the last ladder / tags views visited.
 */
export function viewForTab(tab, view, project, memory = {}) {
  const kind = view && view.kind;
  if (tab === 'ladder') {
    if (kind === 'routine' || kind === 'aoi') return null;
    if (routineExists(project, memory.ladder)) return { ...memory.ladder };
    const first = (project.tasks || []).flatMap((t) => t.programs)[0];
    if (first) return { kind: 'routine', program: first.name, routine: first.mainRoutine };
    const aoi = (project.aois || [])[0];
    return aoi ? { kind: 'aoi', aoi: aoi.name } : { kind: 'controller' };
  }
  if (tab === 'tags') {
    if (tabForView(kind) === 'tags') return null;
    return memory.tags ? { ...memory.tags } : { kind: 'tags', scope: 'Controller' };
  }
  if (tab === 'trend') return kind === 'trend' ? null : { kind: 'trend' };
  return null;
}

/** Remember the last ladder / tags view so the tabs return to it. */
export function rememberView(memory, view) {
  const tab = tabForView(view && view.kind);
  if (tab === 'ladder' || tab === 'tags') memory[tab] = { ...view, rung: undefined };
  return memory;
}

// ------------------------------------------------------------------ browser-only part

// Controls moved into the "⋯" menu on phones, in menu order (ids); a heading starts a section.
const MENU_ITEMS = [
  'Controller', 'btn-online', 'btn-download', 'btn-upload', 'btn-reset-ctrl', 'btn-forces',
  'Project', 'examples', 'btn-load-example', 'btn-new', 'btn-save', 'btn-load', 'btn-export', 'btn-import',
  'Help', 'btn-tour',
];

export class MobileShell {
  constructor({ getView, setView, getProject }) {
    this.getView = getView;
    this.setView = setView;
    this.getProject = getProject;
    this.memory = {};
    this.panel = 'center';
    this.active = false;
    this.mq = window.matchMedia(MOBILE_QUERY);
    this.placeholders = new Map();
    this.menu = document.getElementById('more-menu');
    this.tabbar = document.getElementById('tabbar');
    this.buildTabbar();
    document.getElementById('btn-more').addEventListener('click', (e) => { e.stopPropagation(); this.setMenu(!document.body.classList.contains('menu-open')); });
    document.getElementById('drawer-backdrop').addEventListener('click', () => { this.setDrawer(false); this.setMenu(false); });
    this.menu.addEventListener('click', (e) => { if (e.target.closest('button')) this.setMenu(false); });
    document.addEventListener('click', (e) => {
      if (document.body.classList.contains('menu-open') && !this.menu.contains(e.target) && !e.target.closest('.tour-root')) this.setMenu(false);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('.tour-root')) { this.setMenu(false); this.setDrawer(false); } });
    const tb = document.getElementById('tb-more');
    tb.addEventListener('click', () => {
      const tbar = tb.closest('.toolbar');
      tbar.classList.toggle('expanded');
      tb.textContent = tbar.classList.contains('expanded') ? '▴ Less' : '⋯ More';
    });
    for (const b of document.querySelectorAll('.mseg [data-mview]')) {
      b.addEventListener('click', () => this.setView(b.dataset.mview === 'io' ? { kind: 'io' } : { kind: 'tags', scope: 'Controller' }));
    }
    this.mq.addEventListener('change', () => this.apply());
    this.apply();
  }

  buildTabbar() {
    for (const t of TABS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.tab = t.id;
      b.innerHTML = `<span class="ti-icon" aria-hidden="true">${t.icon}</span><span>${t.label}</span>`;
      b.addEventListener('click', () => this.selectTab(t.id));
      this.tabbar.append(b);
    }
  }

  apply() {
    const on = this.mq.matches;
    if (on === this.active) return;
    this.active = on;
    document.body.classList.toggle('mobile', on);
    if (on) this.moveIntoMenu(); else { this.restoreFromMenu(); this.setDrawer(false); this.setMenu(false); }
    this.sync();
  }

  moveIntoMenu() {
    this.menu.replaceChildren();
    for (const item of MENU_ITEMS) {
      const node = document.getElementById(item);
      if (!node) { const hd = document.createElement('div'); hd.className = 'menu-head'; hd.textContent = item; this.menu.append(hd); continue; }
      const ph = document.createComment(`menu:${item}`);
      node.before(ph);
      this.placeholders.set(node, ph);
      this.menu.append(node);
    }
  }

  restoreFromMenu() {
    for (const [node, ph] of this.placeholders) { ph.replaceWith(node); }
    this.placeholders.clear();
    this.menu.replaceChildren();
  }

  setDrawer(open) {
    document.body.classList.toggle('drawer-open', !!open && this.active);
    const btn = this.tabbar.querySelector('[data-tab="project"]');
    if (btn) btn.setAttribute('aria-expanded', String(!!open && this.active));
  }

  setMenu(open) {
    if (open && this.active) {
      const bar = document.querySelector('.topbar');
      this.menu.style.top = `${Math.max(0, bar.getBoundingClientRect().bottom) + 4}px`;
    }
    document.body.classList.toggle('menu-open', !!open && this.active);
    document.getElementById('btn-more').setAttribute('aria-expanded', String(!!open && this.active));
  }

  setPanel(panel) {
    this.panel = panel;
    this.sync();
  }

  selectTab(id) {
    if (id === 'project') { this.setMenu(false); this.setDrawer(!document.body.classList.contains('drawer-open')); return; }
    this.setDrawer(false);
    this.setMenu(false);
    if (id === 'factory') { this.setPanel('factory'); window.scrollTo(0, 0); return; }
    this.panel = 'center';
    const v = viewForTab(id, this.getView(), this.getProject(), this.memory);
    if (v) this.setView(v); else this.sync();
    window.scrollTo(0, 0);
  }

  /** Called whenever the IDE view changes. */
  onViewChange(view) {
    rememberView(this.memory, view);
    if (this.active) { this.panel = 'center'; this.setDrawer(false); }
  }

  /** Apply a tour step's mobile hints: { panel, drawer, menu }. */
  prepareStep(hints = {}) {
    if (!this.active) return;
    if (hints.panel) this.panel = hints.panel;
    this.setDrawer(!!hints.drawer);
    this.setMenu(!!hints.menu);
    this.sync();
  }

  reset() { this.setDrawer(false); this.setMenu(false); }

  sync() {
    const view = this.getView();
    const tab = this.panel === 'factory' ? 'factory' : tabForView(view && view.kind);
    document.body.dataset.mpanel = this.panel;
    document.body.dataset.mtab = tab || 'other';
    for (const b of this.tabbar.querySelectorAll('[data-tab]')) {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    for (const b of document.querySelectorAll('.mseg [data-mview]')) {
      b.classList.toggle('active', view && (b.dataset.mview === 'io' ? view.kind === 'io' : view.kind === 'tags'));
    }
  }
}
