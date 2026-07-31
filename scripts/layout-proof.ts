// Headless proof of the workbench layout model: drive the REAL functions from
// src/ui/layout/model.ts (the same ones src/ui/panels.ts calls) under Node. No
// browser, no DOM, no jsdom — which is exactly why the model was split out of
// panels.ts. Run: `npm run proof:layout`.
//
// What it protects: the "exactly one main panel" invariant across every move,
// cross-dock moves, draining a dock, and the leniency of the saved-layout merge
// (a stale or hand-edited blob must degrade to something usable, never to an
// exception or a blank screen).

import {
  defaultLayout,
  deserialize,
  mainPanel,
  moveTo,
  moveWithin,
  panelsIn,
  promote,
  serialize,
  type DiscoveredPanel,
  type DockLayout,
  type PanelState,
  type ZoneId,
} from '../src/ui/layout/model.ts';

// Mirrors index.html: the editor is main, the other three start in the right dock.
const MARKUP: DiscoveredPanel[] = [
  { id: 'editor', zone: 'main', defaultWeight: 3 },
  { id: 'registers', zone: 'right', defaultWeight: 3 },
  { id: 'console', zone: 'right', defaultWeight: 3 },
  { id: 'diagnostics', zone: 'right', defaultWeight: 1 },
];
const DEFAULTS = defaultLayout(MARKUP, { right: 0.25, bottom: 0.3 });

let failures = 0;
let checks = 0;

function check(what: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) return;
  failures++;
  console.error(`FAIL: ${what}${detail === undefined ? '' : `\n      got: ${JSON.stringify(detail)}`}`);
}

function eq(what: string, actual: unknown, expected: unknown): void {
  check(what, JSON.stringify(actual) === JSON.stringify(expected), actual);
}

/** Panel ids in a zone, in order — the shorthand every assertion below uses. */
const ids = (panels: readonly PanelState[], zone: ZoneId): string[] =>
  panelsIn(panels, zone).map((p) => p.id);

/** The invariant the whole design rests on. Asserted after every mutation. */
function checkInvariant(what: string, panels: readonly PanelState[]): void {
  const mains = panelsIn(panels, 'main');
  check(`${what}: exactly one main panel`, mains.length === 1, ids(panels, 'main'));
  check(`${what}: the main panel is never collapsed`, mains[0]?.collapsed === false);
  check(
    `${what}: no panel lost or duplicated`,
    new Set(panels.map((p) => p.id)).size === MARKUP.length && panels.length === MARKUP.length,
    panels.map((p) => p.id),
  );
}

// ---- defaults -------------------------------------------------------------

eq('defaults: main zone', ids(DEFAULTS.panels, 'main'), ['editor']);
eq('defaults: right dock', ids(DEFAULTS.panels, 'right'), ['registers', 'console', 'diagnostics']);
eq('defaults: bottom dock is empty', ids(DEFAULTS.panels, 'bottom'), []);
eq('defaults: fractions', DEFAULTS.zones, { right: 0.25, bottom: 0.3 });
checkInvariant('defaults', DEFAULTS.panels);

// ---- reordering within a dock ---------------------------------------------

{
  let p = moveWithin(DEFAULTS.panels, 'console', -1);
  eq('moveWithin: console up', ids(p, 'right'), ['console', 'registers', 'diagnostics']);
  p = moveWithin(p, 'console', -1);
  eq('moveWithin: past the top is a no-op', ids(p, 'right'), ['console', 'registers', 'diagnostics']);
  check('moveWithin: a refused move returns the same array', moveWithin(p, 'console', -1) === p);
  check('moveWithin: the main panel cannot be reordered', moveWithin(p, 'editor', 1) === p);
  checkInvariant('moveWithin', p);
}

// ---- moving between docks --------------------------------------------------

{
  let p: readonly PanelState[] = DEFAULTS.panels;
  p = moveTo(p, 'console', 'bottom', 0);
  eq('moveTo: left the right dock', ids(p, 'right'), ['registers', 'diagnostics']);
  eq('moveTo: joined the bottom dock', ids(p, 'bottom'), ['console']);
  eq(
    'moveTo: the moved panel carries its zone',
    p.find((x) => x.id === 'console')?.zone,
    'bottom',
  );

  p = moveTo(p, 'registers', 'bottom', 0);
  eq('moveTo: inserted at index 0', ids(p, 'bottom'), ['registers', 'console']);
  p = moveTo(p, 'diagnostics', 'bottom', 99);
  eq('moveTo: an out-of-range index clamps to the end', ids(p, 'bottom'), [
    'registers',
    'console',
    'diagnostics',
  ]);

  // Either dock may be empty — the whole point of the feature.
  eq('moveTo: the right dock can be drained', ids(p, 'right'), []);
  checkInvariant('moveTo: right dock drained', p);

  // …and back the other way.
  for (const id of ['registers', 'console', 'diagnostics']) p = moveTo(p, id, 'right', 99);
  eq('moveTo: the bottom dock can be drained', ids(p, 'bottom'), []);
  eq('moveTo: order preserved on the way back', ids(p, 'right'), [
    'registers',
    'console',
    'diagnostics',
  ]);
  checkInvariant('moveTo: bottom dock drained', p);

  check('moveTo: the main panel cannot be moved out', moveTo(p, 'editor', 'bottom', 0) === p);
  check('moveTo: an unknown id is a no-op', moveTo(p, 'nope', 'bottom', 0) === p);
  check('moveTo: a same-slot move is a no-op', moveTo(p, 'registers', 'right', 0) === p);
}

// ---- promotion swaps -------------------------------------------------------

{
  // The outgoing main panel must land in the *exact* slot the promoted one left,
  // which is what keeps promotion reversible and the invariant free of edge cases.
  let p = promote(DEFAULTS.panels, 'console');
  eq('promote: console is main', ids(p, 'main'), ['console']);
  eq('promote: the editor took its slot', ids(p, 'right'), ['registers', 'editor', 'diagnostics']);
  checkInvariant('promote', p);

  p = promote(p, 'console');
  check('promote: promoting the main panel is a no-op', p === promote(p, 'console'));

  // Promote back and the layout is exactly where it started.
  const back = promote(p, 'editor');
  eq('promote: round-trips', ids(back, 'right'), ['registers', 'console', 'diagnostics']);
  checkInvariant('promote: round-trip', back);

  // Promoting out of the bottom dock, and out of a dock that then empties.
  let q: readonly PanelState[] = DEFAULTS.panels;
  for (const id of ['registers', 'console', 'diagnostics']) q = moveTo(q, id, 'bottom', 99);
  q = promote(q, 'diagnostics');
  eq('promote: from the bottom dock', ids(q, 'main'), ['diagnostics']);
  eq('promote: the editor took its bottom slot', ids(q, 'bottom'), [
    'registers',
    'console',
    'editor',
  ]);
  checkInvariant('promote: from the bottom dock', q);

  // A collapsed panel must come up expanded — main is never collapsed.
  const collapsed = DEFAULTS.panels.map((s) => (s.id === 'console' ? { ...s, collapsed: true } : s));
  checkInvariant('promote: a collapsed panel', promote(collapsed, 'console'));
}

// ---- persistence -----------------------------------------------------------

{
  let p: readonly PanelState[] = DEFAULTS.panels;
  p = moveTo(p, 'console', 'bottom', 0);
  p = promote(p, 'registers');
  const saved: DockLayout = { panels: p, zones: { right: 0.4, bottom: 0.35 } };
  const round = deserialize(serialize(saved), DEFAULTS);
  eq('persistence: round-trips the zones', round.zones, { right: 0.4, bottom: 0.35 });
  eq('persistence: round-trips the main panel', ids(round.panels, 'main'), ['registers']);
  eq('persistence: round-trips the docks', ids(round.panels, 'bottom'), ['console']);
  eq('persistence: round-trips the right dock', ids(round.panels, 'right'), [
    'editor',
    'diagnostics',
  ]);
  checkInvariant('persistence: round-trip', round.panels);
}

// ---- the merge is lenient, never throws ------------------------------------

const MALFORMED: Array<[string, string | null]> = [
  ['null', null],
  ['empty string', ''],
  ['not JSON', '{oh no'],
  ['not an object', '42'],
  ['a JSON null', 'null'],
  ['an empty object', '{}'],
  ['a v1 blob (a bare array)', '[{"id":"console","collapsed":true,"weight":2}]'],
  ['panels of the wrong type', '{"panels":"nope"}'],
  ['entries of the wrong type', '{"panels":[null,7,"x"]}'],
  ['an unknown panel id', '{"panels":[{"id":"ghost","zone":"main"}]}'],
  ['an unknown zone', '{"panels":[{"id":"console","zone":"outer-space"}]}'],
  ['no main panel at all', '{"panels":[{"id":"editor","zone":"right"}]}'],
  [
    'two main panels',
    '{"panels":[{"id":"console","zone":"main"},{"id":"editor","zone":"main"}]}',
  ],
  ['a collapsed main panel', '{"panels":[{"id":"console","zone":"main","collapsed":true}]}'],
  ['a duplicated id', '{"panels":[{"id":"console","zone":"bottom"},{"id":"console","zone":"main"}]}'],
  ['NaN and Infinity weights', '{"panels":[{"id":"console","zone":"right","weight":null}]}'],
  ['absurd numbers', '{"panels":[{"id":"console","weight":1e9}],"zones":{"right":50,"bottom":-3}}'],
  ['zones of the wrong type', '{"zones":"wide"}'],
];

for (const [what, raw] of MALFORMED) {
  let merged: DockLayout;
  try {
    merged = deserialize(raw, DEFAULTS);
  } catch (e) {
    check(`merge: ${what} does not throw`, false, String(e));
    continue;
  }
  checkInvariant(`merge: ${what}`, merged.panels);
  check(
    `merge: ${what} yields sane fractions`,
    [merged.zones.right, merged.zones.bottom].every((f) => f >= 0.1 && f <= 0.7),
    merged.zones,
  );
  check(
    `merge: ${what} yields sane weights`,
    merged.panels.every((p) => p.weight >= 0.05 && p.weight <= 100),
    merged.panels,
  );
}

// A few merges have a specific expected outcome, not just a valid one.
eq(
  'merge: two main panels — the first wins, the second drops to its default dock',
  ids(deserialize(MALFORMED[12]![1], DEFAULTS).panels, 'main'),
  ['console'],
);
eq(
  'merge: no main panel — the markup default is reinstated',
  ids(deserialize(MALFORMED[11]![1], DEFAULTS).panels, 'main'),
  ['editor'],
);
eq(
  'merge: an unknown zone falls back to the panel default',
  deserialize(MALFORMED[10]![1], DEFAULTS).panels.find((p) => p.id === 'console')?.zone,
  'right',
);
eq(
  'merge: panels missing from the blob are appended to their default zone',
  ids(deserialize('{"panels":[{"id":"diagnostics","zone":"right"}]}', DEFAULTS).panels, 'right'),
  ['diagnostics', 'registers', 'console'],
);
check(
  'merge: a panel dropped from the markup is forgotten',
  mainPanel(deserialize('{"panels":[{"id":"blockly","zone":"main"}]}', DEFAULTS).panels)?.id ===
    'editor',
);

// ---- report ----------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks FAILED.`);
  process.exit(1);
}
console.log(`Layout model OK — ${checks} checks passed.`);
