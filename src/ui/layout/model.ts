// The workbench layout, as data. Zero DOM: every function here is a pure,
// total function over plain objects, so `npm run proof:layout` can exercise the
// awkward parts (the single-main invariant, cross-zone moves, repairing a
// corrupted saved blob) in Node with no browser and no jsdom dependency.
//
// src/ui/panels.ts owns the other half — elements, pointer gestures, storage.
//
// Three zones:
//
//   ┌──────────────────┬──────────┐   main:   exactly one panel, always
//   │      MAIN        │  RIGHT   │   right:  0..n panels stacked vertically
//   │                  │  stack   │   bottom: 0..n panels side by side
//   ├──────────────────┤          │
//   │     BOTTOM       │          │   Either dock may be empty.
//   └──────────────────┴──────────┘

export type ZoneId = 'main' | 'right' | 'bottom';

export const ZONE_IDS = ['main', 'right', 'bottom'] as const;

/** Where a panel goes when a dock can't have it — see `promote`/`mergeSaved`. */
const FALLBACK_DOCK: ZoneId = 'right';

/** One panel's persisted state. Position within its zone is the array order. */
export interface PanelState {
  id: string;
  zone: ZoneId;
  collapsed: boolean;
  /** Relative share of its dock. Only ratios within one zone matter. */
  weight: number;
}

/** Dock size as a fraction of the workbench, not pixels: a layout saved on a
 *  large monitor then restores sensibly on a small one. */
export interface ZoneFractions {
  right: number;
  bottom: number;
}

export interface DockLayout {
  /** Grouped by zone in ZONE_IDS order; order within a zone is visual order. */
  panels: readonly PanelState[];
  zones: ZoneFractions;
}

/** What the markup states about a panel — the input to `defaultLayout`. */
export interface DiscoveredPanel {
  id: string;
  /** The zone the section is authored in. */
  zone: ZoneId;
  defaultWeight: number;
}

export const MIN_WEIGHT = 0.05;
export const MAX_WEIGHT = 100;
/** A dock may not be squeezed to nothing, nor swallow the main panel. */
export const MIN_FRACTION = 0.1;
export const MAX_FRACTION = 0.7;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const clampWeight = (w: number): number => clamp(w, MIN_WEIGHT, MAX_WEIGHT);
export const clampFraction = (f: number): number => clamp(f, MIN_FRACTION, MAX_FRACTION);

const isZone = (v: unknown): v is ZoneId => ZONE_IDS.includes(v as ZoneId);

// ---- queries ----

export function panelsIn(panels: readonly PanelState[], zone: ZoneId): PanelState[] {
  return panels.filter((p) => p.zone === zone);
}

/** The main panel. Every layout this module returns has exactly one. */
export function mainPanel(panels: readonly PanelState[]): PanelState | undefined {
  return panels.find((p) => p.zone === 'main');
}

/** Split into per-zone lists, then `join` back. Keeps the move maths trivial. */
function split(panels: readonly PanelState[]): Record<ZoneId, PanelState[]> {
  return {
    main: panelsIn(panels, 'main'),
    right: panelsIn(panels, 'right'),
    bottom: panelsIn(panels, 'bottom'),
  };
}

function join(groups: Record<ZoneId, PanelState[]>): PanelState[] {
  return ZONE_IDS.flatMap((z) => groups[z]);
}

// ---- moves ----
// All three return a NEW array (the same PanelState objects are reused where
// nothing about them changed) and are no-ops when the request is impossible, so
// callers never have to pre-validate.

/** Move a panel one slot within its own dock. No-op for the main panel. */
export function moveWithin(
  panels: readonly PanelState[],
  id: string,
  delta: -1 | 1,
): readonly PanelState[] {
  const p = panels.find((x) => x.id === id);
  if (!p || p.zone === 'main') return panels;
  const groups = split(panels);
  const list = groups[p.zone];
  const i = list.indexOf(p);
  const j = i + delta;
  if (j < 0 || j >= list.length) return panels;
  list[i] = list[j]!;
  list[j] = p;
  return join(groups);
}

/** Move a panel into `zone`. `index` is an insertion index into the destination
 *  list *with `id` already removed* — which is exactly what a drag computes from
 *  the other panels' midpoints — and is clamped. Targeting 'main' promotes.
 *
 *  Moving the main panel *out* is refused: it would leave main empty. The way
 *  out is to promote something else, which swaps this panel into its slot. */
export function moveTo(
  panels: readonly PanelState[],
  id: string,
  zone: ZoneId,
  index: number,
): readonly PanelState[] {
  if (zone === 'main') return promote(panels, id);
  const p = panels.find((x) => x.id === id);
  if (!p || p.zone === 'main') return panels;

  const groups = split(panels);
  const from = groups[p.zone];
  const i = from.indexOf(p);
  from.splice(i, 1);
  const to = groups[zone];
  const at = clamp(index, 0, to.length);
  if (p.zone === zone && at === i) return panels; // already there
  to.splice(at, 0, p.zone === zone ? p : { ...p, zone });
  return join(groups);
}

/** Make `id` the main panel. The outgoing main panel takes the exact slot the
 *  promoted one vacated — that swap is what keeps "exactly one main" true
 *  without any special cases elsewhere. A promoted panel is never collapsed. */
export function promote(panels: readonly PanelState[], id: string): readonly PanelState[] {
  const p = panels.find((x) => x.id === id);
  if (!p || p.zone === 'main') return panels;

  const groups = split(panels);
  const from = groups[p.zone];
  const slot = from.indexOf(p);
  from.splice(slot, 1);

  const outgoing = groups.main[0];
  if (outgoing) from.splice(slot, 0, { ...outgoing, zone: p.zone });
  groups.main = [{ ...p, zone: 'main', collapsed: false }];
  return join(groups);
}

// ---- defaults, validation, persistence ----

/** The layout `reset()` returns to: the markup's own order, zones and weights. */
export function defaultLayout(
  discovered: readonly DiscoveredPanel[],
  zones: ZoneFractions,
): DockLayout {
  const panels = discovered.map((d) => ({
    id: d.id,
    zone: d.zone,
    collapsed: false,
    weight: clampWeight(d.defaultWeight),
  }));
  return {
    panels: join(split(panels)),
    zones: { right: clampFraction(zones.right), bottom: clampFraction(zones.bottom) },
  };
}

/** Merge a parsed saved blob onto the panels the markup actually has.
 *
 *  Deliberately lenient — a stale or hand-edited layout should degrade to
 *  something usable, never to an exception or a blank screen. Unknown ids are
 *  dropped, ids added since the save are appended to their default zone,
 *  unknown zones and non-finite numbers fall back to the markup defaults, and
 *  the single-main invariant is *repaired* rather than triggering a wholesale
 *  reset. Never throws. */
export function mergeSaved(raw: unknown, defaults: DockLayout): DockLayout {
  const byId = new Map(defaults.panels.map((d) => [d.id, d]));
  const saved = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const out: PanelState[] = [];
  const seen = new Set<string>();
  if (Array.isArray(saved.panels)) {
    for (const entry of saved.panels) {
      if (entry === null || typeof entry !== 'object') continue;
      const { id, zone, collapsed, weight } = entry as Record<string, unknown>;
      if (typeof id !== 'string' || seen.has(id)) continue;
      const def = byId.get(id);
      if (!def) continue; // a panel that no longer exists in the markup
      seen.add(id);
      out.push({
        id,
        zone: isZone(zone) ? zone : def.zone,
        collapsed: collapsed === true,
        weight:
          typeof weight === 'number' && Number.isFinite(weight) ? clampWeight(weight) : def.weight,
      });
    }
  }
  for (const d of defaults.panels) if (!seen.has(d.id)) out.push({ ...d });

  return { panels: join(split(repairMain(out, defaults))), zones: readZones(saved.zones, defaults) };
}

/** Force exactly one main panel: the first one claiming it wins, extras drop
 *  back to their default dock, and if none claims it the markup's main panel is
 *  reinstated. Mutates and returns `panels`. */
function repairMain(panels: PanelState[], defaults: DockLayout): PanelState[] {
  const dockFor = (id: string): ZoneId => {
    const z = defaults.panels.find((d) => d.id === id)?.zone;
    return z === undefined || z === 'main' ? FALLBACK_DOCK : z;
  };

  let main: PanelState | undefined;
  for (const p of panels) {
    if (p.zone !== 'main') continue;
    if (main) p.zone = dockFor(p.id);
    else main = p;
  }
  if (!main) {
    const fallbackId = mainPanel(defaults.panels)?.id ?? panels[0]?.id;
    main = panels.find((p) => p.id === fallbackId);
    if (main) main.zone = 'main';
  }
  if (main) main.collapsed = false; // the main panel is never collapsed
  return panels;
}

function readZones(raw: unknown, defaults: DockLayout): ZoneFractions {
  const z = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const read = (key: keyof ZoneFractions): number =>
    typeof z[key] === 'number' && Number.isFinite(z[key])
      ? clampFraction(z[key])
      : defaults.zones[key];
  return { right: read('right'), bottom: read('bottom') };
}

/** Storage format. Weights and fractions are rounded so a drag doesn't write a
 *  20-digit float on every gesture. */
export function serialize(layout: DockLayout): string {
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  return JSON.stringify({
    v: 2,
    panels: layout.panels.map((p) => ({
      id: p.id,
      zone: p.zone,
      collapsed: p.collapsed,
      weight: round(p.weight),
    })),
    zones: { right: round(layout.zones.right), bottom: round(layout.zones.bottom) },
  });
}

/** `serialize`'s inverse, tolerant of anything: malformed JSON, a v1 blob (a
 *  bare array — no zones, so it can't be honoured) and null all yield defaults. */
export function deserialize(raw: string | null, defaults: DockLayout): DockLayout {
  if (!raw) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  return mergeSaved(parsed, defaults);
}
