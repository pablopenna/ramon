// Layout controller for the right-hand sidebar: collapse, reorder and resize the
// Registers / Console / Diagnostics panels, and remember the result across
// reloads. It owns *layout only* — panel content is still rendered straight into
// #registers / #flags / #console / #diagnostics by main.ts, even while a panel is
// collapsed (cheap, and it keeps a re-expanded panel correct with no refresh hook).
//
// Panels are discovered from the DOM ([data-panel] + data-default-weight) rather
// than from a registry array like ARCHES: a panel carries only a title and a
// default size, both of which the markup already states, so a second source of
// truth in TypeScript would just drift. Adding a panel is a markup-only change.
//
// Sizing model: each expanded panel is `flex: <weight> 1 0` with flex-grow written
// inline here; collapsed panels get grow 0 and fall back to header height. Weights
// (not pixel heights) mean a layout saved on a big monitor restores sensibly on a
// small one, with no resize bookkeeping.

/** Persisted per-panel state. Array order in PanelLayout *is* the visual order. */
export interface PanelState {
  id: string;
  collapsed: boolean;
  /** Relative share of the space left to expanded panels. Only ratios matter. */
  weight: number;
}

export type PanelLayout = readonly PanelState[];

export interface PanelSidebarOptions {
  /** Fired after a *committed* change — collapse, reorder, drag end, reset — and
   *  never per pointermove frame. */
  onLayoutChange?: (layout: PanelLayout) => void;
  /** Defaults to window.localStorage; pass null to disable persistence. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

/** A panel's live state plus its DOM. Never leaves this module. */
interface Panel {
  id: string;
  title: string;
  defaultWeight: number;
  section: HTMLElement;
  toggle: HTMLButtonElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  body: HTMLElement;
  collapsed: boolean;
  weight: number;
}

const STORAGE_KEY = 'ramon.layout.v1';
/** How small a drag may squeeze an expanded panel, in px. */
const MIN_PANEL_PX = 64;
/** Weight step for arrow-key resizing, in px of intended movement. */
const KEY_RESIZE_PX = 12;
const MIN_WEIGHT = 0.05;
const MAX_WEIGHT = 100;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clampWeight = (w: number): number => clamp(w, MIN_WEIGHT, MAX_WEIGHT);

export class PanelSidebar {
  private readonly parent: HTMLElement;
  private readonly opts: PanelSidebarOptions;
  private readonly storage: PanelSidebarOptions['storage'];
  private panels: Panel[];
  /** Document order, fixed at construction — what reset() returns to. */
  private readonly discoveryOrder: readonly Panel[];
  /** Keyed by the id of the panel *below* the splitter, so collapse toggles
   *  reuse elements instead of churning them. */
  private readonly splitters = new Map<string, HTMLElement>();

  constructor(parent: HTMLElement, opts: PanelSidebarOptions = {}) {
    this.parent = parent;
    this.opts = opts;
    this.storage = opts.storage === undefined ? safeLocalStorage() : opts.storage;
    this.panels = discover(parent);
    this.discoveryOrder = [...this.panels];

    const saved = loadLayout(this.storage, this.defaults());
    this.applyLayout(saved);
    this.applyState();
    this.syncDom();

    for (const p of this.panels) {
      p.toggle.addEventListener('click', () => this.setCollapsed(p.id, !p.collapsed));
      p.up.addEventListener('click', () => this.move(p.id, -1, p.up));
      p.down.addEventListener('click', () => this.move(p.id, 1, p.down));
      const grip = p.section.querySelector<HTMLElement>('.panel-grip');
      grip?.addEventListener('pointerdown', (ev) => this.beginDrag(p, ev));
    }
  }

  getLayout(): PanelLayout {
    return this.panels.map((p) => ({ id: p.id, collapsed: p.collapsed, weight: p.weight }));
  }

  setCollapsed(id: string, collapsed: boolean): void {
    const p = this.panels.find((x) => x.id === id);
    if (!p || p.collapsed === collapsed) return;
    p.collapsed = collapsed;
    // Visual-only: never touches the tree, so no panel's scroll position or the
    // keyboard focus is disturbed by a collapse.
    this.applyState();
    this.syncDom();
    this.commit();
  }

  /** Move a panel one slot up (-1) or down (+1). `activated` is the button that
   *  triggered it, if any — it may end up disabled and silently blur. */
  move(id: string, delta: -1 | 1, activated?: HTMLButtonElement): void {
    const i = this.panels.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.panels.length) return;
    const p = this.panels[i]!;

    // Re-inserting a scroll container resets its scrollTop — save it across the
    // move. This is the only path that detaches a panel.
    const scroll = p.body.scrollTop;
    this.panels[i] = this.panels[j]!;
    this.panels[j] = p;
    this.applyState();
    this.syncDom();
    p.body.scrollTop = scroll;

    // A panel moved to an end disables the button that got it there; the browser
    // would then blur to <body> and strand the keyboard user.
    if (activated?.disabled) {
      const fallback = activated === p.up ? p.down : p.up;
      (fallback.disabled ? p.toggle : fallback).focus();
    }
    this.commit();
  }

  /** Back to document order and data-default-weight, everything expanded. */
  reset(): void {
    this.applyLayout(this.defaults());
    this.applyState();
    this.syncDom();
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      /* storage may be blocked; the in-memory reset already happened */
    }
    this.opts.onLayoutChange?.(this.getLayout());
  }

  // ---- state application ----

  /** Document order + markup defaults, i.e. the layout `reset()` returns to. */
  private defaults(): PanelState[] {
    return this.discoveryOrder.map((p) => ({ id: p.id, collapsed: false, weight: p.defaultWeight }));
  }

  private applyLayout(layout: readonly PanelState[]): void {
    const byId = new Map(this.panels.map((p) => [p.id, p]));
    this.panels = layout.map((s) => {
      const p = byId.get(s.id)!;
      p.collapsed = s.collapsed;
      p.weight = s.weight;
      return p;
    });
  }

  /** Classes, ARIA and flex weights. Deliberately does not touch the tree. */
  private applyState(): void {
    const last = this.panels.length - 1;
    this.panels.forEach((p, i) => {
      const expanded = !p.collapsed;
      p.section.classList.toggle('is-collapsed', p.collapsed);
      p.toggle.setAttribute('aria-expanded', String(expanded));
      // Always written inline, for every panel: an inline longhand beats the
      // stylesheet shorthand, so a stale flexGrow would resurrect a collapsed panel.
      p.section.style.flexGrow = expanded ? String(p.weight) : '0';
      p.up.disabled = i === 0;
      p.down.disabled = i === last;
    });
  }

  /** Reconcile the parent's children to `panel [splitter panel]*`, with a splitter
   *  only between two adjacent *expanded* panels. Nodes already in the right place
   *  are left alone, so nothing is needlessly detached. */
  private syncDom(): void {
    const desired: HTMLElement[] = [];
    let prev: Panel | null = null;
    for (const p of this.panels) {
      if (prev && !prev.collapsed && !p.collapsed) desired.push(this.splitterFor(prev, p));
      desired.push(p.section);
      prev = p;
    }

    let cursor: ChildNode | null = this.parent.firstChild;
    for (const node of desired) {
      if (cursor === node) {
        cursor = cursor.nextSibling;
        continue;
      }
      this.parent.insertBefore(node, cursor);
    }
    while (cursor) {
      const next: ChildNode | null = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
  }

  private splitterFor(above: Panel, below: Panel): HTMLElement {
    let s = this.splitters.get(below.id);
    if (!s) {
      s = document.createElement('div');
      s.className = 'panel-splitter';
      s.setAttribute('role', 'separator');
      s.setAttribute('aria-orientation', 'horizontal');
      s.setAttribute('aria-valuemin', '0');
      s.setAttribute('aria-valuemax', '100');
      s.tabIndex = 0;
      const el = s;
      el.addEventListener('pointerdown', (ev) => this.beginResize(el, ev));
      el.addEventListener('keydown', (ev) => this.onSplitterKey(el, ev));
      el.addEventListener('dblclick', () => this.equalize(el));
      this.splitters.set(below.id, el);
    }
    s.dataset.below = below.id;
    s.setAttribute('aria-label', `Resize ${above.title} and ${below.title}`);
    const total = above.weight + below.weight;
    s.setAttribute('aria-valuenow', String(Math.round((above.weight / total) * 100)));
    return s;
  }

  // ---- resizing ----

  /** The expanded pair a splitter sits between, straight from the model. */
  private pairFor(splitter: HTMLElement): [Panel, Panel] | null {
    const j = this.panels.findIndex((p) => p.id === splitter.dataset.below);
    const b = this.panels[j];
    const a = this.panels[j - 1];
    return a && b && !a.collapsed && !b.collapsed ? [a, b] : null;
  }

  private beginResize(splitter: HTMLElement, ev: PointerEvent): void {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const pair = this.pairFor(splitter);
    if (!pair) return;
    const [a, b] = pair;

    // box-sizing is border-box globally, so the rect height is the resolved size.
    const aPx0 = a.section.getBoundingClientRect().height;
    const bPx0 = b.section.getBoundingClientRect().height;
    const totalPx = aPx0 + bPx0;
    const totalW = a.weight + b.weight;
    if (totalPx < MIN_PANEL_PX * 2 || totalW <= 0) return;

    const y0 = ev.clientY;
    ev.preventDefault(); // suppress text selection and the native drag
    splitter.focus(); // preventDefault suppresses the implicit focus in some engines
    splitter.setPointerCapture(ev.pointerId);
    splitter.classList.add('is-active');
    document.body.classList.add('is-resizing');

    const onMove = (e: PointerEvent): void => {
      const d = clamp(e.clientY - y0, MIN_PANEL_PX - aPx0, bPx0 - MIN_PANEL_PX);
      this.applyPair(splitter, a, b, (aPx0 + d) / totalPx, totalW);
    };
    const end = (): void => {
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', end);
      splitter.removeEventListener('pointercancel', end);
      splitter.classList.remove('is-active');
      document.body.classList.remove('is-resizing');
      this.commit();
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', end);
    splitter.addEventListener('pointercancel', end);
  }

  /** Split `totalW` across the pair at `ratio`. Their sum is invariant, so no
   *  other panel's share shifts and the conversion stays exact. */
  private applyPair(
    splitter: HTMLElement,
    a: Panel,
    b: Panel,
    ratio: number,
    totalW: number,
  ): void {
    a.weight = clampWeight(totalW * ratio);
    b.weight = clampWeight(totalW - a.weight);
    a.section.style.flexGrow = String(a.weight);
    b.section.style.flexGrow = String(b.weight);
    splitter.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  private onSplitterKey(splitter: HTMLElement, ev: KeyboardEvent): void {
    const step = ev.key === 'ArrowUp' ? -KEY_RESIZE_PX : ev.key === 'ArrowDown' ? KEY_RESIZE_PX : 0;
    if (step === 0) return;
    const pair = this.pairFor(splitter);
    if (!pair) return;
    const [a, b] = pair;
    const aPx0 = a.section.getBoundingClientRect().height;
    const bPx0 = b.section.getBoundingClientRect().height;
    const d = clamp(step, MIN_PANEL_PX - aPx0, bPx0 - MIN_PANEL_PX);
    ev.preventDefault();
    this.applyPair(splitter, a, b, (aPx0 + d) / (aPx0 + bPx0), a.weight + b.weight);
    this.commit();
  }

  /** Double-click a splitter: give its two panels an even share. */
  private equalize(splitter: HTMLElement): void {
    const pair = this.pairFor(splitter);
    if (!pair) return;
    const [a, b] = pair;
    this.applyPair(splitter, a, b, 0.5, a.weight + b.weight);
    this.commit();
  }

  // ---- reordering by drag ----

  /** Drag the grip: when the pointer crosses a neighbour's midpoint, hand off to
   *  move() so this and the ▲/▼ buttons can't drift apart.
   *
   *  The pointer is captured on the *container*, not on the grip: a reorder
   *  re-inserts the dragged panel, and re-inserting the capturing element's
   *  ancestor releases the capture, which would strand the drag after the first
   *  swap. The container never moves. */
  private beginDrag(panel: Panel, ev: PointerEvent): void {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    const captor = this.parent;
    captor.setPointerCapture(ev.pointerId);
    panel.section.classList.add('is-dragging');

    const onMove = (e: PointerEvent): void => {
      const i = this.panels.indexOf(panel);
      const rect = panel.section.getBoundingClientRect();
      if (e.clientY < rect.top) {
        const above = this.panels[i - 1];
        // Only swap once the pointer is past the neighbour's midpoint, so a
        // panel doesn't oscillate while the cursor hovers a boundary.
        if (above && e.clientY < midpoint(above)) this.move(panel.id, -1);
      } else if (e.clientY > rect.bottom) {
        const below = this.panels[i + 1];
        if (below && e.clientY > midpoint(below)) this.move(panel.id, 1);
      }
    };
    const end = (): void => {
      captor.removeEventListener('pointermove', onMove);
      captor.removeEventListener('pointerup', end);
      captor.removeEventListener('pointercancel', end);
      panel.section.classList.remove('is-dragging');
    };
    captor.addEventListener('pointermove', onMove);
    captor.addEventListener('pointerup', end);
    captor.addEventListener('pointercancel', end);
  }

  // ---- persistence ----

  private commit(): void {
    try {
      this.storage?.setItem(
        STORAGE_KEY,
        JSON.stringify(
          this.panels.map((p) => ({
            id: p.id,
            collapsed: p.collapsed,
            weight: Math.round(p.weight * 1000) / 1000,
          })),
        ),
      );
    } catch {
      /* private mode or quota: the layout is a nicety, never fail the app for it */
    }
    this.opts.onLayoutChange?.(this.getLayout());
  }
}

function midpoint(p: Panel): number {
  const r = p.section.getBoundingClientRect();
  return r.top + r.height / 2;
}

/** Read the panels out of the markup, in document order. */
function discover(parent: HTMLElement): Panel[] {
  const sections = parent.querySelectorAll<HTMLElement>('[data-panel]');
  const panels: Panel[] = [];
  for (const section of sections) {
    const id = section.dataset.panel!;
    const toggle = section.querySelector<HTMLButtonElement>('.panel-toggle');
    const up = section.querySelector<HTMLButtonElement>('.panel-move[data-move="up"]');
    const down = section.querySelector<HTMLButtonElement>('.panel-move[data-move="down"]');
    const body = section.querySelector<HTMLElement>('.panel-body');
    if (!toggle || !up || !down || !body) {
      throw new Error(`Panel "${id}" is missing a .panel-toggle, .panel-move or .panel-body`);
    }
    const weight = Number(section.dataset.defaultWeight ?? '1');
    panels.push({
      id,
      title: toggle.textContent?.trim() || id,
      defaultWeight: Number.isFinite(weight) && weight > 0 ? weight : 1,
      section,
      toggle,
      up,
      down,
      body,
      collapsed: false,
      weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
    });
  }
  if (panels.length === 0) throw new Error('PanelSidebar: no [data-panel] sections found');
  return panels;
}

/** localStorage, or null where merely *touching* it throws (Safari private mode,
 *  blocked cookies). */
function safeLocalStorage(): PanelSidebarOptions['storage'] {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Merge a persisted layout onto the panels found in the DOM: unknown ids are
 *  dropped, ids added since the save are appended in document order, weights are
 *  clamped, and anything malformed falls back to the markup defaults. Never throws. */
function loadLayout(
  storage: PanelSidebarOptions['storage'],
  defaults: readonly PanelState[],
): PanelState[] {
  const fallback = (): PanelState[] => defaults.map((d) => ({ ...d }));

  let raw: string | null = null;
  try {
    raw = storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return fallback();
  }
  if (!raw) return fallback();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback();
  }
  if (!Array.isArray(parsed)) return fallback();

  const byId = new Map(defaults.map((d) => [d.id, d]));
  const seen = new Set<string>();
  const out: PanelState[] = [];

  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, collapsed, weight } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      collapsed: collapsed === true,
      weight:
        typeof weight === 'number' && Number.isFinite(weight)
          ? clampWeight(weight)
          : byId.get(id)!.weight,
    });
  }
  for (const d of defaults) if (!seen.has(d.id)) out.push({ ...d });
  return out;
}
