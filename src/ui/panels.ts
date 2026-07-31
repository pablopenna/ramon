// Layout controller for the three-zone workbench: which panel is main, which
// dock every other panel sits in, plus collapse / reorder / resize and the
// persistence of all of it. It owns *layout only* — panel content is still
// rendered straight into #editor / #registers / #flags / #console / #diagnostics
// by main.ts, even while a panel is collapsed (cheap, and it keeps a re-expanded
// panel correct with no refresh hook).
//
// The state machine lives next door in ./layout/model.ts as pure functions over
// plain data; this file is the DOM half — elements, pointer gestures, storage.
// Every mutation here goes model-first: compute the next layout, then render it.
//
// Panels are discovered from the DOM ([data-panel] + data-default-weight) rather
// than from a registry array like ARCHES: a panel carries only a title, a default
// size and a default zone, all of which the markup already states, so a second
// source of truth in TypeScript would just drift. The zone a section is *authored*
// in is its default zone. Adding a panel is a markup-only change.
//
// Sizing model: each expanded panel is `flex: <weight> 1 0` along its dock's axis,
// with flex-grow written inline here; collapsed panels get grow 0 and fall back to
// header size. The docks themselves are sized as a fraction of the workbench,
// written as --right-frac / --bottom-frac. Neither is stored in pixels, so a layout
// saved on a big monitor restores sensibly on a small one.

import {
  allCollapsed,
  clampFraction,
  clampWeight,
  defaultLayout,
  deserialize,
  moveTo,
  moveWithin,
  panelsIn,
  // Aliased: the class has a `promote` method that delegates to this.
  promote as promoteMain,
  serialize,
  ZONE_IDS,
  type DiscoveredPanel,
  type DockLayout,
  type PanelState,
  type ZoneFractions,
  type ZoneId,
} from './layout/model.ts';

export type { DockLayout, PanelState, ZoneId } from './layout/model.ts';

/** The docks a panel can be sent to — every zone except the singular main. */
export type DockId = Exclude<ZoneId, 'main'>;

export interface PanelDockElements {
  /** The workbench root: the pointer captor for drags (the only ancestor that
   *  survives re-inserting a panel into another zone) and the host for the
   *  --right-frac / --bottom-frac custom properties. */
  root: HTMLElement;
  main: HTMLElement;
  right: HTMLElement;
  bottom: HTMLElement;
}

export interface PanelDockOptions {
  /** Fired after a *committed* change — collapse, move, promote, drag end,
   *  resize end, reset — and never per pointermove frame. */
  onLayoutChange?: (layout: DockLayout) => void;
  /** Defaults to window.localStorage; pass null to disable persistence. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

/** A panel's DOM. All of its *state* lives in the layout model. */
interface Panel {
  id: string;
  title: string;
  section: HTMLElement;
  toggle: HTMLButtonElement;
  makeMain: HTMLButtonElement;
  dock: HTMLButtonElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  body: HTMLElement;
  grip: HTMLElement | null;
}

/** Which way a stack runs / a splitter is dragged. The right dock stacks
 *  vertically, the bottom dock horizontally, and each dock's own size is
 *  dragged along the *other* axis — hence two tables below. */
interface Axis {
  pos: 'clientX' | 'clientY';
  size: 'width' | 'height';
  /** True when the splitter draws a vertical seam, i.e. resizes side by side. */
  seamVertical: boolean;
}
const ALONG_X: Axis = { pos: 'clientX', size: 'width', seamVertical: true };
const ALONG_Y: Axis = { pos: 'clientY', size: 'height', seamVertical: false };

/** How panels stack *inside* a dock. */
const STACK_AXIS: Record<DockId, Axis> = { right: ALONG_Y, bottom: ALONG_X };
/** How the dock itself is resized against the main panel. */
const ZONE_AXIS: Record<DockId, Axis> = { right: ALONG_X, bottom: ALONG_Y };

/** Reorder-button glyphs and labels, by stack direction. */
const ARROWS = {
  right: { up: '▲', down: '▼', upWord: 'up', downWord: 'down' },
  bottom: { up: '◀', down: '▶', upWord: 'left', downWord: 'right' },
} as const;

const STORAGE_KEY = 'ramon.layout.v2';
/** The pre-zones format. It cannot be migrated (it has no notion of a main
 *  panel or of docks), so it is dropped rather than read. */
const LEGACY_KEY = 'ramon.layout.v1';

/** How small a drag may squeeze an expanded panel, in px. */
const MIN_PANEL_PX = 64;
/** Step for arrow-key resizing, in px of intended movement. */
const KEY_RESIZE_PX = 12;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export class PanelDock {
  private readonly el: PanelDockElements;
  private readonly opts: PanelDockOptions;
  private readonly storage: PanelDockOptions['storage'];
  private readonly panels = new Map<string, Panel>();
  /** The markup's own layout — what reset() returns to. */
  private readonly defaults: DockLayout;
  /** Live state. Held mutable so a resize drag can rewrite weights per frame
   *  without rebuilding the model; every other mutation replaces the array. */
  private layout: { panels: PanelState[]; zones: ZoneFractions };
  /** Keyed by the id of the panel *after* the splitter, so a collapse toggle
   *  reuses elements instead of churning them. */
  private readonly splitters = new Map<string, HTMLElement>();
  private readonly zoneSplitters = new Map<DockId, HTMLElement>();

  constructor(el: PanelDockElements, opts: PanelDockOptions = {}) {
    this.el = el;
    this.opts = opts;
    this.storage = opts.storage === undefined ? safeLocalStorage() : opts.storage;

    const discovered = this.discover();
    this.defaults = defaultLayout(discovered, readDefaultFractions(el));
    this.layout = mutable(deserialize(this.read(), this.defaults));
    // Before the first render, not after: render() hides the seam of a dock that
    // is empty or all-collapsed, and it can only do that once zoneSplitters has
    // the elements. Binding needs nothing render() produces.
    this.bindZoneSplitters();
    this.render();
    this.bindPanels();
  }

  // ---- public API ----

  getLayout(): DockLayout {
    return { panels: this.layout.panels.map((p) => ({ ...p })), zones: { ...this.layout.zones } };
  }

  setCollapsed(id: string, collapsed: boolean): void {
    const s = this.stateOf(id);
    // The main panel may not be collapsed: it would leave a hole where the
    // whole point of the zone is that something is always in it.
    if (!s || s.zone === 'main' || s.collapsed === collapsed) return;
    s.collapsed = collapsed;
    // Visual-only: never reorders, so no panel's scroll position and no
    // keyboard focus is disturbed by a collapse.
    this.render();
    this.commit();
  }

  /** Move a panel one slot within its dock. `activated` is the button that
   *  triggered it, if any — it may end up disabled and silently blur. */
  move(id: string, delta: -1 | 1, activated?: HTMLButtonElement): void {
    this.transact(moveWithin(this.layout.panels, id, delta), id, activated);
  }

  /** Send a panel to the other dock, appended at the end. */
  toOtherDock(id: string, activated?: HTMLButtonElement): void {
    const s = this.stateOf(id);
    if (!s || s.zone === 'main') return;
    const target: DockId = s.zone === 'right' ? 'bottom' : 'right';
    const next = moveTo(this.layout.panels, id, target, panelsIn(this.layout.panels, target).length);
    this.transact(next, id, activated);
  }

  /** Make a panel the main one; the outgoing main panel takes its old slot. */
  promote(id: string): void {
    this.transact(promoteMain(this.layout.panels, id), id);
  }

  /** Back to the markup's zones, order, sizes, everything expanded. */
  reset(): void {
    this.layout = mutable(this.defaults);
    this.render();
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      /* storage may be blocked; the in-memory reset already happened */
    }
    this.opts.onLayoutChange?.(this.getLayout());
  }

  // ---- model plumbing ----

  private stateOf(id: string): PanelState | undefined {
    return this.layout.panels.find((p) => p.id === id);
  }

  /** Adopt a layout the model produced, re-render, restore what the DOM move
   *  destroyed, and persist. No-op when the model refused the change. */
  private transact(
    next: readonly PanelState[],
    id: string,
    activated?: HTMLButtonElement,
  ): void {
    if (next === this.layout.panels) return;
    const panel = this.panels.get(id);
    // Re-inserting a scroll container resets its scrollTop — save it across the
    // move. Reordering is the only path that detaches a panel.
    const scroll = panel?.body.scrollTop ?? 0;
    this.layout.panels = next.map((p) => ({ ...p }));
    this.render();
    if (panel) panel.body.scrollTop = scroll;

    // A panel moved to an end disables the button that got it there; the browser
    // would then blur to <body> and strand the keyboard user.
    if (activated?.disabled && panel) {
      const alt = [panel.up, panel.down, panel.dock, panel.makeMain, panel.toggle];
      alt.find((b) => b !== activated && !b.disabled)?.focus();
    }
    this.commit();
  }

  // ---- rendering ----

  private render(): void {
    this.applyState();
    this.applyFractions();
    for (const zone of ZONE_IDS) this.syncZone(zone);
  }

  /** Classes, ARIA, button affordances and flex weights. Never touches the tree. */
  private applyState(): void {
    for (const zone of ZONE_IDS) {
      const list = panelsIn(this.layout.panels, zone);
      const arrows = zone === 'bottom' ? ARROWS.bottom : ARROWS.right;
      const last = list.length - 1;

      list.forEach((s, i) => {
        const p = this.panels.get(s.id)!;
        const isMain = zone === 'main';
        const expanded = !s.collapsed;

        p.section.classList.toggle('is-collapsed', s.collapsed);
        p.section.classList.toggle('is-main', isMain);
        p.toggle.setAttribute('aria-expanded', String(expanded));
        // Always written inline, for every panel: an inline longhand beats the
        // stylesheet shorthand, so a stale flexGrow would resurrect a collapsed
        // panel — or leave a stale dock weight on a panel that moved zones.
        p.section.style.flexGrow = isMain ? '1' : expanded ? String(s.weight) : '0';

        // Reorder means up/down in the right dock but left/right in the bottom
        // one, and the dock button points at whichever dock it isn't in — both
        // follow the panel around, so they are rewritten rather than authored.
        p.up.textContent = arrows.up;
        p.down.textContent = arrows.down;
        p.up.setAttribute('aria-label', `Move ${p.title} ${arrows.upWord}`);
        p.down.setAttribute('aria-label', `Move ${p.title} ${arrows.downWord}`);
        const target = zone === 'right' ? 'bottom' : 'right';
        p.dock.textContent = zone === 'right' ? '⤵' : '⤴';
        p.dock.setAttribute('aria-label', `Move ${p.title} to the ${target} dock`);
        p.dock.title = `Move to the ${target} dock`;

        // Every one of these would break the "exactly one main panel" invariant,
        // so on the main panel they are all off. CSS hides them as well; this is
        // the half that also stops a keyboard user reaching them.
        p.up.disabled = isMain || i === 0;
        p.down.disabled = isMain || i === last;
        p.makeMain.disabled = isMain;
        p.dock.disabled = isMain;
      });
    }
  }

  private applyFractions(): void {
    this.el.root.style.setProperty('--right-frac', String(this.layout.zones.right));
    this.el.root.style.setProperty('--bottom-frac', String(this.layout.zones.bottom));
  }

  /** Reconcile a zone's children to `panel [splitter panel]*`, with a splitter
   *  only between two adjacent *expanded* panels. Nodes already in the right
   *  place are left alone, so nothing is needlessly detached. */
  private syncZone(zone: ZoneId): void {
    const list = panelsIn(this.layout.panels, zone);
    const sectionOf = (s: PanelState): HTMLElement => this.panels.get(s.id)!.section;

    if (zone === 'main') {
      // One panel, no splitters — the invariant means there is nothing to decide.
      reconcile(this.el.main, list.map(sectionOf));
      return;
    }

    const desired: HTMLElement[] = [];
    let prev: PanelState | null = null;
    for (const s of list) {
      if (prev && !prev.collapsed && !s.collapsed) desired.push(this.splitterFor(zone, prev, s));
      desired.push(sectionOf(s));
      prev = s;
    }
    reconcile(this.el[zone], desired);

    // An empty dock collapses away entirely, taking its zone splitter with it.
    const empty = list.length === 0;
    this.el[zone].classList.toggle('is-empty', empty);
    this.zoneSplitters.get(zone)?.classList.toggle('is-empty', empty);

    // A dock with nothing left but collapsed panels stops honouring its fraction
    // and shrinks to its headers; its seam goes too, since an auto-sized dock
    // gives it nothing to drag. The fraction itself is untouched, so expanding
    // any panel puts the dock straight back at the size the user left it.
    const strip = allCollapsed(this.layout.panels, zone);
    this.el[zone].classList.toggle('is-strip', strip);
    this.zoneSplitters.get(zone)?.classList.toggle('is-strip', strip);
  }

  private splitterFor(zone: DockId, above: PanelState, below: PanelState): HTMLElement {
    let s = this.splitters.get(below.id);
    if (!s) {
      s = document.createElement('div');
      s.dataset.kind = 'panel';
      s.tabIndex = 0;
      s.setAttribute('role', 'separator');
      s.setAttribute('aria-valuemin', '0');
      s.setAttribute('aria-valuemax', '100');
      const el = s;
      el.addEventListener('pointerdown', (ev) => this.beginPanelResize(el, ev));
      el.addEventListener('keydown', (ev) => this.onPanelSplitterKey(el, ev));
      el.addEventListener('dblclick', () => this.equalize(el));
      this.splitters.set(below.id, el);
    }
    // Re-set on every call, not just on creation: a panel that changed dock
    // brings its cached splitter along, and the axis flips with the dock.
    const axis = STACK_AXIS[zone];
    s.className = `panel-splitter${axis.seamVertical ? ' is-vertical' : ''}`;
    s.setAttribute('aria-orientation', axis.seamVertical ? 'vertical' : 'horizontal');
    s.dataset.zone = zone;
    s.dataset.below = below.id;
    s.setAttribute('aria-label', `Resize ${titleOf(this.panels, above)} and ${titleOf(this.panels, below)}`);
    const total = above.weight + below.weight;
    s.setAttribute('aria-valuenow', String(Math.round((above.weight / total) * 100)));
    return s;
  }

  // ---- panel resizing ----

  /** The expanded pair a splitter sits between, straight from the model. */
  private pairFor(splitter: HTMLElement): { a: PanelState; b: PanelState; axis: Axis } | null {
    const zone = splitter.dataset.zone as DockId | undefined;
    if (!zone) return null;
    const list = panelsIn(this.layout.panels, zone);
    const j = list.findIndex((p) => p.id === splitter.dataset.below);
    const b = list[j];
    const a = list[j - 1];
    return a && b && !a.collapsed && !b.collapsed ? { a, b, axis: STACK_AXIS[zone] } : null;
  }

  private beginPanelResize(splitter: HTMLElement, ev: PointerEvent): void {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const pair = this.pairFor(splitter);
    if (!pair) return;
    const { a, b, axis } = pair;

    const aPx0 = this.sizeOf(a, axis);
    const bPx0 = this.sizeOf(b, axis);
    const totalPx = aPx0 + bPx0;
    const totalW = a.weight + b.weight;
    if (totalPx < MIN_PANEL_PX * 2 || totalW <= 0) return;

    const start = ev[axis.pos];
    this.gesture(splitter, ev, axis, {
      move: (e) => {
        const d = clamp(e[axis.pos] - start, MIN_PANEL_PX - aPx0, bPx0 - MIN_PANEL_PX);
        this.applyPair(splitter, a, b, (aPx0 + d) / totalPx, totalW);
      },
      end: () => this.commit(),
    });
  }

  /** Split `totalW` across the pair at `ratio`. Their sum is invariant, so no
   *  other panel's share shifts and the conversion stays exact. */
  private applyPair(
    splitter: HTMLElement,
    a: PanelState,
    b: PanelState,
    ratio: number,
    totalW: number,
  ): void {
    a.weight = clampWeight(totalW * ratio);
    b.weight = clampWeight(totalW - a.weight);
    this.panels.get(a.id)!.section.style.flexGrow = String(a.weight);
    this.panels.get(b.id)!.section.style.flexGrow = String(b.weight);
    splitter.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  private onPanelSplitterKey(splitter: HTMLElement, ev: KeyboardEvent): void {
    const pair = this.pairFor(splitter);
    if (!pair) return;
    const { a, b, axis } = pair;
    const dir = keyStep(ev, axis);
    if (dir === 0) return;
    const aPx0 = this.sizeOf(a, axis);
    const bPx0 = this.sizeOf(b, axis);
    const d = clamp(dir * KEY_RESIZE_PX, MIN_PANEL_PX - aPx0, bPx0 - MIN_PANEL_PX);
    ev.preventDefault();
    this.applyPair(splitter, a, b, (aPx0 + d) / (aPx0 + bPx0), a.weight + b.weight);
    this.commit();
  }

  /** Double-click a splitter: give its two panels an even share. */
  private equalize(splitter: HTMLElement): void {
    const pair = this.pairFor(splitter);
    if (!pair) return;
    this.applyPair(splitter, pair.a, pair.b, 0.5, pair.a.weight + pair.b.weight);
    this.commit();
  }

  private sizeOf(s: PanelState, axis: Axis): number {
    // box-sizing is border-box globally, so the rect is the resolved size.
    return this.panels.get(s.id)!.section.getBoundingClientRect()[axis.size];
  }

  // ---- dock resizing ----

  /** Drag the seam between the main panel and a dock. The fraction is measured
   *  against the splitter's own parent, which is exactly the box `calc(var(...)
   *  * 100%)` resolves against in the stylesheet. */
  private beginZoneResize(splitter: HTMLElement, zone: DockId, ev: PointerEvent): void {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const container = splitter.parentElement;
    if (!container) return;
    const axis = ZONE_AXIS[zone];
    const box = container.getBoundingClientRect();
    const total = box[axis.size];
    if (total <= 0) return;

    // The dock hugs the far edge, so its size is (far edge − pointer); the
    // offset pins the seam to where it was actually grabbed.
    const far = axis.size === 'width' ? box.right : box.bottom;
    const offset = this.el[zone].getBoundingClientRect()[axis.size] - (far - ev[axis.pos]);

    this.gesture(splitter, ev, axis, {
      move: (e) => this.setFraction(zone, (far - e[axis.pos] + offset) / total),
      end: () => this.commit(),
    });
  }

  private onZoneSplitterKey(splitter: HTMLElement, zone: DockId, ev: KeyboardEvent): void {
    const axis = ZONE_AXIS[zone];
    const dir = keyStep(ev, axis);
    if (dir === 0) return;
    const total = splitter.parentElement?.getBoundingClientRect()[axis.size] ?? 0;
    if (total <= 0) return;
    ev.preventDefault();
    // Dragging the seam *towards* the dock shrinks it, hence the minus.
    this.setFraction(zone, this.layout.zones[zone] - (dir * KEY_RESIZE_PX) / total);
    this.commit();
  }

  private setFraction(zone: DockId, frac: number): void {
    this.layout.zones[zone] = clampFraction(frac);
    this.applyFractions();
    const splitter = this.zoneSplitters.get(zone);
    splitter?.setAttribute('aria-valuenow', String(Math.round(this.layout.zones[zone] * 100)));
  }

  // ---- gestures ----

  /** The shared pointer-capture dance for both kinds of splitter: capture, mark
   *  the body so the resize cursor beats CodeMirror's `cursor: text`, and unbind
   *  on up *or* cancel. */
  private gesture(
    captor: HTMLElement,
    ev: PointerEvent,
    axis: Axis,
    on: { move: (e: PointerEvent) => void; end: () => void },
  ): void {
    ev.preventDefault(); // suppress text selection and the native drag
    captor.focus(); // preventDefault suppresses the implicit focus in some engines
    captor.setPointerCapture(ev.pointerId);
    captor.classList.add('is-active');
    document.body.classList.add('is-resizing', axis.seamVertical ? 'is-resizing-col' : 'is-resizing-row');

    const end = (): void => {
      captor.removeEventListener('pointermove', on.move);
      captor.removeEventListener('pointerup', end);
      captor.removeEventListener('pointercancel', end);
      captor.classList.remove('is-active');
      document.body.classList.remove('is-resizing', 'is-resizing-col', 'is-resizing-row');
      on.end();
    };
    captor.addEventListener('pointermove', on.move);
    captor.addEventListener('pointerup', end);
    captor.addEventListener('pointercancel', end);
  }

  /** Drag the grip: hit-test the zone under the pointer, then hand off to the
   *  same model functions the header buttons use, so the two can't drift apart.
   *
   *  The pointer is captured on the workbench *root*, not on the grip or the
   *  dock: a move re-inserts the dragged panel, possibly into another zone, and
   *  re-inserting the capturing element's ancestor releases the capture — which
   *  would strand the drag after the first hop. The root never moves. */
  private beginDrag(panel: Panel, ev: PointerEvent): void {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (this.stateOf(panel.id)?.zone === 'main') return; // dragging main out would empty it
    ev.preventDefault();

    const captor = this.el.root;
    captor.setPointerCapture(ev.pointerId);
    panel.section.classList.add('is-dragging');
    // Reveals an empty dock as a drop strip: display:none leaves no rect to
    // aim at, and an emptied dock is exactly the one you want to drop back into.
    document.body.classList.add('is-dragging-panel');
    let over: ZoneId | null = null;

    const onMove = (e: PointerEvent): void => {
      over = this.zoneAt(e.clientX, e.clientY);
      this.el.main.classList.toggle('is-drop-target', over === 'main');
      // Docking follows the pointer live, but promotion waits for the release:
      // the main zone lies between the two docks, so every right→bottom drag
      // crosses it, and promoting on the way through would make the docks
      // unreachable from each other.
      if (over === null || over === 'main') return;
      this.transact(
        moveTo(this.layout.panels, panel.id, over, this.dropIndex(over, panel.id, e)),
        panel.id,
      );
    };
    const end = (): void => {
      captor.removeEventListener('pointermove', onMove);
      captor.removeEventListener('pointerup', end);
      captor.removeEventListener('pointercancel', end);
      panel.section.classList.remove('is-dragging');
      document.body.classList.remove('is-dragging-panel');
      this.el.main.classList.remove('is-drop-target');
      if (over === 'main') this.promote(panel.id);
    };
    captor.addEventListener('pointermove', onMove);
    captor.addEventListener('pointerup', end);
    captor.addEventListener('pointercancel', end);
  }

  /** Which zone a point is over, or null between/outside them (the toolbar, a
   *  zone splitter) — where a drag should simply hold its position. */
  private zoneAt(x: number, y: number): ZoneId | null {
    for (const zone of ZONE_IDS) {
      const r = this.el[zone].getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return zone;
      }
    }
    return null;
  }

  /** Where the dragged panel would land in `zone`: the first sibling whose
   *  midpoint the pointer has passed. Measured against the *other* panels only,
   *  which is what makes it stable — inserting the dragged panel pushes those
   *  midpoints further away, so a settled drop never oscillates. */
  private dropIndex(zone: DockId, id: string, e: PointerEvent): number {
    const axis = STACK_AXIS[zone];
    const others = panelsIn(this.layout.panels, zone).filter((p) => p.id !== id);
    const pos = e[axis.pos];
    for (let i = 0; i < others.length; i++) {
      const r = this.panels.get(others[i]!.id)!.section.getBoundingClientRect();
      const mid = axis.size === 'width' ? r.left + r.width / 2 : r.top + r.height / 2;
      if (pos < mid) return i;
    }
    return others.length;
  }

  // ---- wiring ----

  private discover(): DiscoveredPanel[] {
    const discovered: DiscoveredPanel[] = [];
    for (const zone of ZONE_IDS) {
      // Direct children only: a panel's *content* may well contain markup that
      // would otherwise be mistaken for a nested panel.
      for (const section of this.el[zone].querySelectorAll<HTMLElement>(':scope > [data-panel]')) {
        const id = section.dataset.panel!;
        const q = <T extends HTMLElement>(sel: string): T | null => section.querySelector<T>(sel);
        const toggle = q<HTMLButtonElement>('.panel-toggle');
        const makeMain = q<HTMLButtonElement>('.panel-main');
        const dock = q<HTMLButtonElement>('.panel-dock');
        const up = q<HTMLButtonElement>('.panel-move[data-move="up"]');
        const down = q<HTMLButtonElement>('.panel-move[data-move="down"]');
        const body = q<HTMLElement>('.panel-body');
        if (!toggle || !makeMain || !dock || !up || !down || !body) {
          throw new Error(
            `Panel "${id}" is missing a .panel-toggle, .panel-main, .panel-dock, .panel-move or .panel-body`,
          );
        }
        const weight = Number(section.dataset.defaultWeight ?? '1');
        this.panels.set(id, {
          id,
          title: toggle.textContent?.trim() || id,
          section,
          toggle,
          makeMain,
          dock,
          up,
          down,
          body,
          grip: q<HTMLElement>('.panel-grip'),
        });
        discovered.push({
          id,
          zone,
          defaultWeight: Number.isFinite(weight) && weight > 0 ? weight : 1,
        });
      }
    }
    // Docks may be empty, but the main zone may not — the layout has nowhere to
    // put a panel it can promote from.
    if (discovered.filter((d) => d.zone === 'main').length !== 1) {
      throw new Error('PanelDock: the main zone must contain exactly one [data-panel] section');
    }
    return discovered;
  }

  private bindPanels(): void {
    for (const p of this.panels.values()) {
      p.toggle.addEventListener('click', () => {
        this.setCollapsed(p.id, !this.stateOf(p.id)?.collapsed);
      });
      p.makeMain.addEventListener('click', () => this.promote(p.id));
      p.dock.addEventListener('click', () => this.toOtherDock(p.id, p.dock));
      p.up.addEventListener('click', () => this.move(p.id, -1, p.up));
      p.down.addEventListener('click', () => this.move(p.id, 1, p.down));
      p.grip?.addEventListener('pointerdown', (ev) => this.beginDrag(p, ev));
    }
  }

  private bindZoneSplitters(): void {
    for (const zone of ['right', 'bottom'] as const) {
      const el = this.el.root.querySelector<HTMLElement>(
        `.panel-splitter[data-kind="zone"][data-zone="${zone}"]`,
      );
      if (!el) throw new Error(`PanelDock: no zone splitter for the ${zone} dock`);
      this.zoneSplitters.set(zone, el);
      el.addEventListener('pointerdown', (ev) => this.beginZoneResize(el, zone, ev));
      el.addEventListener('keydown', (ev) => this.onZoneSplitterKey(el, zone, ev));
      el.addEventListener('dblclick', () => {
        this.setFraction(zone, this.defaults.zones[zone]);
        this.commit();
      });
      el.setAttribute('aria-label', `Resize the ${zone} dock`);
      el.setAttribute('aria-valuenow', String(Math.round(this.layout.zones[zone] * 100)));
    }
  }

  // ---- persistence ----

  private read(): string | null {
    try {
      return this.storage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private commit(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, serialize(this.getLayout()));
      this.storage?.removeItem(LEGACY_KEY);
    } catch {
      /* private mode or quota: the layout is a nicety, never fail the app for it */
    }
    this.opts.onLayoutChange?.(this.getLayout());
  }
}

/** Make `container`'s children exactly `desired`, in order, moving as few nodes
 *  as possible — anything already in place keeps its scroll and its focus. */
function reconcile(container: HTMLElement, desired: readonly HTMLElement[]): void {
  let cursor: ChildNode | null = container.firstChild;
  for (const node of desired) {
    if (cursor === node) {
      cursor = cursor.nextSibling;
      continue;
    }
    container.insertBefore(node, cursor);
  }
  // Whatever is left is a splitter or a panel that moved elsewhere.
  while (cursor) {
    const next: ChildNode | null = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

/** ArrowUp/Left → -1, ArrowDown/Right → +1, along the splitter's own axis. */
function keyStep(ev: KeyboardEvent, axis: Axis): -1 | 0 | 1 {
  const [less, more] = axis.seamVertical
    ? ['ArrowLeft', 'ArrowRight']
    : ['ArrowUp', 'ArrowDown'];
  return ev.key === less ? -1 : ev.key === more ? 1 : 0;
}

function titleOf(panels: Map<string, Panel>, s: PanelState): string {
  return panels.get(s.id)?.title ?? s.id;
}

function mutable(layout: DockLayout): { panels: PanelState[]; zones: ZoneFractions } {
  return { panels: layout.panels.map((p) => ({ ...p })), zones: { ...layout.zones } };
}

function readDefaultFractions(el: PanelDockElements): ZoneFractions {
  const read = (zone: 'right' | 'bottom', fallback: number): number => {
    const v = Number(el[zone].dataset.defaultFrac ?? '');
    return Number.isFinite(v) && v > 0 ? clampFraction(v) : fallback;
  };
  return { right: read('right', 0.25), bottom: read('bottom', 0.3) };
}

/** localStorage, or null where merely *touching* it throws (Safari private mode,
 *  blocked cookies). */
function safeLocalStorage(): PanelDockOptions['storage'] {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
