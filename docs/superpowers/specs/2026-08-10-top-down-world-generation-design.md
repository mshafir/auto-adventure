# Top-down world generation

A design for generating worlds that are reliably playable, by inverting the order of
authoring and replacing every advisory hint with a solved constraint.

## The problem, in the words of the code

Three new scenarios were generated and were hard to play: the events did not connect,
and places the story named could not be found. None of that is bad luck. Each symptom
has a named cause in the current pipeline.

**The order is inverted from what the code claims.** `src/ai/author/author.ts:58` says the
arc is plotted before the towns are populated, "so each town knows its part in the story
instead of having one assigned to it afterwards". It does not happen. Sites are pass 3
(`author.ts:322`); the arc is pass 4 (`author.ts:380`). Every town, cast, structure and
hook is invented blind to the story, and the arc then picks its cast *by index* out of
people who were created for flavour. That is a story stapled onto a world, which is
precisely what the comment says it avoids.

**Beats are sequenced, not caused.** `requires: [arc:previous]` (`author.ts:744`) makes a
sequence. Nothing makes beat N's content follow from beat N-1's. Then the prose is written
one NPC at a time in a worker pool (`author.ts:451`), each call seeing only its own beat
summary and a next-stop place name. No scene knows what any other scene said.

**Nothing constrains where beats land.** The arc call is shown every settlement and picks
freely (`author.ts:611`). The only filter is `walkableSites` (`author.ts:244`), and walkable
is not findable: consecutive beats may sit three hundred tiles apart across a ridge with no
road between them. Signposts and `toldWhereToGo` (`src/scenario/wayfinding.ts:73`) are
patches applied after the story is already unfollowable.

**A required building is a suggestion.** `src/core/gen/features/settlement.ts:244-247`:

> The spec is advisory: more structures than plots are truncated by importance and fewer
> are padded with filler, so a malformed or oversized spec degrades instead of failing.

A plot too small for the requested structure yields `undefined` and is given **filler**
(`settlement.ts:249-254`). So the story's counting house becomes a house. Then
`pruneUnreachable` (`settlement.ts:332`) may demolish it. Then `hidingPlace`
(`author.ts:657`) papers over the gap by hiding the item somewhere else. Three independent
layers of silent substitution, all downstream of a spec that was never binding.

**The pipeline never plays the story it writes.** `walkTheStory` drives the real engine
through the arc, and its only caller is the offline CLI at `src/tools/validate.ts:98`.

## What makes the fix possible

Four properties of the existing generator carry the whole design.

**A feature patch is a pure function of `(world, site, spec)`.** `src/core/gen/features/patch.ts:69-88`:
a settlement is generated once in its own frame, cached by site id, and clipped into every
chunk it touches. So the work inside a town may be arbitrarily expensive and arbitrarily
clever, provided it stays pure. Determinism is the only tax on complexity here.

**The noise fields cost nothing to sample.** `elevationAt`, `slopeAt`, `civilizationAt` and
`macroSite` are pure per-point and need no chunk generated. A `long` world is 324 macro
cells. So thousands of candidate worlds can be scored per second without building one,
which is what turns "regenerate until it fits" from an aspiration into an algorithm.

**Authored places already exist.** `WorldRecipe.places` pins a site of a chosen kind,
importance and radius into a macro cell, and `macroSite:75-90` honours it over the roll
while keeping the cell's id and region, so roads, rivers, specs and the halo treat it as
native. Up to 64 (`src/core/world/recipe-schema.ts:244`).

**The fields will accept direction, under one rule.** `src/core/world/fields.ts:4-18` states
it exactly:

> Every one is `f(world, x, y)` with no state, no caching keyed on a chunk, and no per-chunk
> parameters — which is precisely why biome boundaries, coastlines and mountain ranges run
> across chunk borders without any stitching code existing anywhere. The recipe is
> world-constant and its zones are smooth radial fields, so it changes what the function
> computes without giving it a notion of a chunk — the property that matters is preserved.
> Nothing that varies per chunk may ever reach this layer.

So anything **world-constant and continuous** may be injected into the fields. That is the
licence for the layout described below: it is not a new philosophy but the existing `zones`
mechanism generalised from a sparse set of radial blobs to a dense coarse lattice.

## The law

**The model never emits an identifier.**

No site ids. No NPC indices. No coordinates. No choosing from a list of real things it was
shown. The model emits *requirements in its own vocabulary* — "a harbour, remote, where a
tally is kept" — and a deterministic solver maps requirements onto ids, or fails.

This is enforced at the schema: the story bible schema has no numeric id field anywhere.

The law is what deletes code rather than adding it. `arcPrompt` currently shows the model
every settlement and asks for indices, and `lowerArc` then spends a hundred and forty lines
defending against the answers — dropping out-of-range indices, detecting when the model
"reliably conflates *these are alternatives* with *this follows that*" (`author.ts:719-735`).
Under this law none of those answers can be given, so none of that defence needs to exist.

Division of labour, stated once:

| The model decides | Deterministic code decides |
| --- | --- |
| premise, title, the causal chain | every position, every id, every assignment |
| what kind of place each beat needs | which actual site that is |
| what kind of building, and why | which plot it occupies |
| who people are, what they want | where they stand |
| every word anybody says | every flag, lock, placement and signpost |

## Architecture

A new module `src/forge/` replaces `src/ai/author/*` as the **producer**. `src/scenario/`
keeps and grows as the **judge** — `validate.ts`, `repair.ts`, `walk.ts`, `completeness.ts`,
`wayfinding.ts`, `signposts.ts` — and as the repo. `ScenarioArtifact` remains the runtime
contract, additive fields only, so `src/engine`, saves, and the hand-written Gawain and
Thornwick scenarios are untouched.

### Passes

| # | Pass | Calls | Fails how |
| --- | --- | --- | --- |
| A | brief → story bible | 1 | schema retry |
| B | bible → requirements | 0 | mechanical, cannot fail |
| C | sketch the layout from the seed | 0 | mechanical, cannot fail |
| D | tier-1: edit the layout, place the stage, verify | 0 | **reports and stops** |
| E | tier-2 place solve, per stage site | 0 | returns to D with that site excluded |
| F | name and populate | parallel | falls back to deterministic specs |
| G | lower to artifact | 0 | mechanical, cannot fail |
| H | prose: serial along the spine, then parallel | serial + pooled | a missing tree is a finding |
| I | judge: validate, repair, mend, **walk** | mend only | findings, and a bounded retry on a failed walk |

The expensive half is F and H. Everything that can make a world unplayable is decided in C, D
and E, which cost nothing, so the floor on a failed generation is **one model call**. That one
call is unavoidable: requirements come from the story, and there is no story before pass A.

## Data model

New types live in `src/forge/requirements.ts`. Nothing here reaches the artifact except
where noted.

### What the model writes

Pass A returns exactly one object, and it contains no identifier that refers to anything
real:

```ts
interface StoryBible {
  readonly title: string;
  readonly premise: string;
  readonly places: readonly PlaceRequirement[];
  readonly cast: readonly CastRequirement[];
  readonly spine: readonly SpineBeat[];
  readonly sides: readonly SideBeat[];
  readonly endings: readonly EndingSketch[];
}
```

Every cross-reference inside it — `SpineBeat.at`, `SpineBeat.with`,
`CastRequirement.inside` — points at another handle the model itself invented, so pass B can
check the whole bible is internally closed before a map is consulted. A spine beat naming a
place that does not appear in `places` is a schema-level fault, caught and retried for the
price of one call.

```ts
/** A place the story needs, described the way a writer would describe it. */
interface PlaceRequirement {
  readonly id: string;                 // the author's own handle, e.g. "the-drowned-landing"
  readonly kind: PlaceKind;            // closed story-side vocabulary
  readonly qualities: readonly PlaceQuality[];
  readonly structures: readonly StructureRequirement[];
}

type PlaceKind = "settlement" | "harbour" | "stronghold" | "ruin" | "cave" | "waymark";
type PlaceQuality = "coastal" | "remote" | "wooded" | "high" | "fortified" | "ruined";

interface StructureRequirement {
  readonly id: string;
  readonly kind: StructureKind;        // the engine's existing closed list
  readonly relations: readonly Relation[];
  readonly anchors: readonly AnchorKind[];  // anchors the story needs to exist
  readonly locked?: boolean;
}

/** Somebody the story needs, described by what they do rather than who they are. */
interface CastRequirement {
  readonly id: string;                 // the author's own handle, e.g. "the-tally-keeper"
  readonly at: string;                 // PlaceRequirement.id — where they live
  readonly does: string;               // their function in the story, in a phrase
  /** The structure they are found in or at, when the story needs them somewhere precise. */
  readonly inside?: string;            // StructureRequirement.id
}

type Relation =
  | { readonly t: "OnSquare" }
  | { readonly t: "OnArrivalStreet" }
  | { readonly t: "InsideWall" }
  | { readonly t: "AtEdge" }
  | { readonly t: "Isolated"; readonly minGap: number }
  | { readonly t: "Adjacent"; readonly to: string }
  | { readonly t: "AwayFrom"; readonly from: string; readonly minTiles: number };
```

`PlaceKind` is story-side on purpose and maps to `SiteKind` in pass B: `harbour → docks`,
`stronghold → castle | fort`, `settlement → hamlet | village | town`, and so on. The model
never says "docks", because "docks" is a thing on a map.

### The causal spine

```ts
interface SpineBeat {
  readonly id: string;
  readonly whatHappens: string;
  readonly at: string;                 // PlaceRequirement.id
  readonly with: string;               // CastRequirement.id
  readonly yields: Yield;              // what the player leaves with
  readonly because: string;            // why the previous yield makes this possible
}

type Yield =
  | { readonly t: "Knowledge"; readonly of: string }
  | { readonly t: "Item"; readonly name: string; readonly hiddenIn?: string }
  | { readonly t: "Access"; readonly to: string };
```

`Yield` being typed is what makes causality machine-checkable rather than a sentence
somebody hopes is true. Beat N's prerequisite is derived from beat N-1's `Yield`, and the
flag, item placement or lock that implements it is *generated* in pass G rather than
authored. A spine whose beat 3 claims to open a door that no earlier beat yielded access to
is rejected in pass B, before a map is even consulted.

Sides are optional leaves, each naming its host spine beat. Endings key off which sides
completed. There is no free-form branching, which is what makes most of the current
`checkBranches` and `checkForkIsSpoken` failure modes structurally unreachable.

### What the solvers return

```ts
type SolveResult<T> =
  | { readonly ok: true; readonly solution: T }
  | { readonly ok: false; readonly failure: SolveFailure };

interface WorldSolution {
  readonly seed: number;
  readonly recipe?: WorldRecipe;
  readonly bounds: WorldBounds;
  readonly spawn: Vec2;
  readonly stage: ReadonlyMap<string, number>;   // requirement id -> site id
  readonly pinned: readonly PlaceRecipe[];
  readonly legs: readonly Leg[];
  readonly proved: readonly string[];            // invariants actually checked
  readonly trials: number;
}

/** One journey the player will make, as the solver proved it walkable. */
interface Leg {
  readonly from: string;                         // PlaceRequirement.id, or "spawn"
  readonly to: string;                           // PlaceRequirement.id
  readonly tiles: number;                        // routed length, not straight line
  readonly bridged: boolean;                     // whether the route crosses water
}

interface SolveFailure {
  readonly binding: string;      // the requirement that could not be met
  readonly reason: string;       // in words, for a person to read
  readonly tried: number;
  readonly relaxations: readonly Relaxation[];
}

type Relaxation =
  | { readonly t: "DropQuality"; readonly place: string; readonly quality: PlaceQuality }
  | { readonly t: "SubstituteKind"; readonly place: string; readonly to: PlaceKind }
  | { readonly t: "MergePlaces"; readonly keep: string; readonly into: string }
  | { readonly t: "WidenLegs"; readonly toTiles: number }
  | { readonly t: "GrowDuration"; readonly to: Duration };
```

`Relaxation` is declarative rather than a closure so the launcher can render it as a choice,
the test suite can enumerate it, and applying one is a pure function that re-enters the
solver.

## Tier 0: the layout, and what the seed is for

The seed is currently a lottery ticket on whether the story is tellable at all. Every field
is noise, so the only way to get a harbour is to find a seed whose noise happens to put a
coast where the story needs one. That is the root of the seeding problem, and it is why
tier 1 was originally specified as an escalating search.

Invert it. **The seed sketches; the solver edits; the seed then fills in texture.**

1. **Sketch.** The seed produces a coarse layout at macro resolution — where the sea is,
   where the high ground is, which regions are wooded — by sampling the existing fields.
   Nothing new is invented here; this is today's world, read at low resolution.
2. **Edit.** The solver changes the sketch to satisfy the story's requirements: carve a bay
   against the cell chosen for the harbour, raise ground for the stronghold, lift a small
   rise under every stage site, cut valleys along the rivers.
3. **Texture.** The seed decides everything below the lattice — which trees, which cliff,
   which jitter, which interior.

The consequence is that the seed regains a useful meaning: **the same story, in the same
geography, with different texture.** A reroll changes how a world looks without changing
whether it works, which is a better product than today's all-or-nothing reroll.

### The control lattice

A coarse lattice over the bounded world carrying **offsets, not absolute values** — noise
still provides the texture, the lattice decides the large-scale shape:

```
elevationAt(x, y) = unit( warped_fbm(…) · detailScale + controlElevation(world, x, y) )
```

`controlElevation` is a **bicubic** sample of the lattice. Bicubic and not bilinear, and this
is not a cosmetic preference: `slopeAt` (`fields.ts:140-148`) is a finite difference of
`elevationAt`, so a merely-C0 lattice makes slope show lattice-aligned ridges. Roads cost
`slopeAt * 220` (`roads.ts:41`) and cliffs read slope and roughness, so the visible symptom
of getting this wrong is a **grid-aligned road network and cliff pattern** — a world that
looks generated in exactly the way `elevationAt`'s domain warp exists to prevent
(`fields.ts:38-41`). C1 continuity is a requirement.

Three further constraints, each with a reason:

- **It fades to zero at the bounds.** A lattice is finite and the live unbounded director has
  no bounds, so the outermost ring tapers to zero and the world outside the boundary
  generates exactly as it does today.
- **There is a free path when there is no lattice.** `flatFields` (`fields.ts:158-166`) is the
  existing pattern, and it exists because these functions are called once per tile per field
  and the empty case had been costing 8700 allocations per chunk. A lattice lookup must cost
  a single length check when there is no lattice.
- **It is on the hottest path in the engine.** `fields.ts:44-47` records that elevation is
  sampled ~4400 times per chunk and *is* the chunk budget; `slopeAt` multiplies that by five.
  A bicubic sample is sixteen lattice reads — cheap against a warped fbm stack, but not free.
  Flat `Float32Array` with integer indexing, and measured rather than assumed.

### What is persisted

Not the lattice. Twenty thousand floats would be the first part of a `.scenarios/*.json` that
a person cannot read, and readability is a stated value of the format. Persist the small
declarative thing that generates it:

```ts
interface WorldLayout {
  readonly cell: number;                          // tiles per control cell
  readonly seas: readonly AreaShape[];            // pushed below seaLevel
  readonly highlands: readonly AreaShape[];
  readonly woods: readonly AreaShape[];           // moisture, not elevation
  readonly rises: readonly { readonly at: Vec2; readonly lift: number }[];
  readonly valleys: readonly { readonly along: readonly Vec2[]; readonly depth: number }[];
}
```

`controlFieldsFor(layout)` builds the `Float32Array` deterministically and is memoised per
world. The same reasoning as `BuildingPlacement.lock` (`patch.ts:59-66`): the thing travels
with the spec rather than with the tiles, "which is what makes it free to persist".

## Tier 1: the world constructor

With a layout, tier 1 stops searching for a world that happens to fit and constructs one that
does. Three steps, not four escalating ones.

1. **Place the stage.** `macroSite` per cell over the sketched world; match place requirements
   to rolled sites in spine order under hard constraints — distance from spawn roughly
   increasing, no single leg longer than `LONG_MARCH` (320 tiles), the whole walk no shorter
   than `SHORT_STORY` (60 tiles). Both numbers come from `src/scenario/validate.ts:135-136`,
   where they were learned from real playthroughs: a long single leg is what spoils a session,
   and a total walk that short is a story that never leaves the room it started in. They are
   used at the same altitude here as there — `LONG_MARCH` per leg (`validate.ts:1432`),
   `SHORT_STORY` against the total (`validate.ts:1438`) — so the solver and the judge cannot
   disagree about pacing.
2. **Edit the layout to close the gaps.** A requirement with no suitable rolled site is
   satisfied by construction rather than by rerolling: edit the lattice so the ground suits
   it, and pin the site with a `PlaceRecipe`. A pin must still pass the ground test
   `siteKindAt` would have applied — above `seaLevel`, under `maxSlope`, shoreline for docks,
   hillside for caves — because `macroSite:75-90` honours a pin **outright and unchecked**,
   and a bad pin puts a village in the sea. Pin radius is clamped so `maxFeatureRadius`
   cannot exceed `HALO` (`macro.ts:198-215`). Because the lattice is edited *before* sites are
   resolved, the ground test passes by construction rather than by luck.
3. **Verify.** Seconds, once. Full passability sweep of the bounded world; `reachableFrom` the
   spawn; `roadBetween` for every leg, bridges included. The only step that generates chunks.

Rerolling the seed remains available as a fallback, starting at `resolveSeed(id)`
(`src/scenario/generate.ts:134`) and walking outward deterministically — but it is now the
exception rather than the mechanism. Reproducibility survives because the artifact records
both `seed` and `layout`; what changes is that the id names *where the search began* rather
than the world itself, which needs saying in `artifact.ts` where the current contract is
documented.

## Rivers

Rivers are traced by steepest descent over macro-cell elevation from highland springs
(`src/core/world/rivers.ts:44-90`), so **they are already a consequence of elevation**: decide
the lattice and the rivers are decided with it. Each of the four things wanted here lands
differently.

- **A specific procedural flow** already exists, and is already the right kind: one
  world-space polyline, cached per world, clipped per chunk, so banks line up with no
  stitching code.
- **Going around structures** is the real gap — nothing today stops a river running through a
  town. The fix is not a special case. The `rises` in the layout lift the ground under each
  stage site, and steepest descent then routes around them using the existing physics, which
  also makes towns look right: a settlement on a rise with water below it. A hard deflection
  guard in `traceRiver` stays as a backstop only, because a guard alone can strand a river in
  the middle of the map with no mouth.
- **Altering the topography around them** is a cycle: rivers derive from elevation, and the
  valleys want to alter elevation. It is broken by being explicitly one-pass — trace on the
  lattice, write the `valleys` offsets back, retrace **once**, keep that. No fixpoint
  iteration. The rivers that ship must be the ones traced against the *final* lattice, or the
  channel and its banks disagree.
- **Bridges where they cross a path** already work: `src/core/gen/pipeline.ts:242-244` stamps
  `T.bridge` where a road meets `MASK_CHANNEL`. Only sea crossings are missing, which is the
  change below.

## Tier 2: the place solver

Reservation before decoration. Replaces `settlement.ts:244-279`.

Per-site requirements come from decomposing the story: for each spine beat and side landing
at this place, what must exist here, and in what relation to what.

1. Plots come from the BSP exactly as today.
2. **Required structures are solved first**, by backtracking over the relations — on the
   square, on the street you arrive by, inside the wall, at the edge and alone, adjacent to
   another named building, behind a lock. The domains are small (≤ ~30 plots × ≤ ~6
   requirements), so exhaustive finite-domain search with forward checking is both instant
   and complete: if an assignment exists it is found, and if none exists that is a fact
   rather than a guess.
3. **Then** filler takes what is left. Filler can never outbid a requirement because it
   never competes for the same plot.
4. `pruneUnreachable` may **never demolish a reserved building.** An unreachable reserved
   building demolishes a *neighbour* and re-carves. If it is still unreachable, tier 2
   fails, and tier 1 tries a different site for that requirement, then a different world.
5. Anchors the story needs are declared and their existence is an invariant. So
   `hidingPlace` (`author.ts:657`) — the fallback that hides a story item in the wrong
   building — is **deleted** rather than improved.

Everything here is a pure function of `(world, site, requirements)`, which is what keeps
the patch cache and the chunk-clipping contract intact.

## Bridges

`src/core/world/roads.ts:36-37` returns `Number.POSITIVE_INFINITY` for any coarse cell below
sea level, so a road never crosses water and every story must live on one landmass. That
single line rejects a large fraction of otherwise-good worlds.

Change it to finite-but-expensive for water spans under a small number of coarse cells, so
A\* still strongly prefers land but will bridge a narrow inlet. `src/core/gen/pipeline.ts:242-244`
already stamps `T.bridge` where a road meets a river channel; extend that to any road tile
below sea level, and teach `gridFor` that the tile is passable. Long open-sea crossings stay
impossible, which is correct: a bridge across a bay is not a bridge.

This lands early because it widens the solver's search space more than any other single
change.

## Validation as invariants, throughout

Each solver returns its solution together with the invariants it actually proved, or a
failure with the binding constraint named. The invariants are the specification:

- every place requirement maps to exactly one real site
- every site is inside the bounds, is built rather than declined, and is reachable from spawn
- every leg has a route, and its length is within bounds
- every required structure exists at its site, is not filler, and is not demolished
- every required anchor exists and is reachable from the town square
- every beat after the first has a `because` naming a `Yield` an earlier beat produced
- every item objective has a placement, and every placement a building that was asked for
- every leg's destination is named to the player before they need it

`validateArtifact`'s existing checks stay, in their existing role — the net that catches
what nobody predicted — plus **`walkTheStory` promoted into the pipeline** as pass I's gate.
A walk that does not finish is the one condition that earns a bounded retry.

The point of moving these earlier is not that the final pass is wrong. It is that a fault
found in pass D costs nothing and a fault found in pass I costs a whole generation.

### Additions to `ScenarioArtifact`

Additive only.

- `arc.beats[].because?: string` — the causal reason, so the journal can say it and
  `checkCausality` can check it
- `recipe.layout?: WorldLayout` — the declarative layout, from which the control lattice is
  rebuilt on load. It belongs in the recipe rather than beside it, because the recipe is
  already the thing the fields consult and is already world-constant
- `forge?: { bible, requirements, solution }` — kept for debuggability, for regenerating a
  world from the same story, and so that a failure can be reported against what was asked
  for rather than what was produced

Nothing is removed and nothing changes meaning, so the engine, the save format and the
hand-written scenarios are unaffected.

## Determinism

Determinism becomes load-bearing in a new place, and this is the most dangerous part of the
design. A solver whose result depends on `Map` or `Set` iteration order seeded from a
non-deterministic source, on floating-point accumulation order, or on anything outside
`(world, site, spec)`, will make two chunks disagree about a town. `patch.ts:69-79` exists
to prevent exactly that, and the symptom is a town whose outskirts vanish when the player
walks far enough away — a fault that reads as a rendering bug.

Rules:

- solvers take their randomness only from `rngFor(seed, …)`, never from `Math.random`
- iteration order over candidates is by explicit sort on stable keys, never by insertion
- backtracking explores in a fixed order, so the *first* solution found is a function of the
  inputs alone
- every solver gets a golden test in the manner of `src/core/gen/golden.test.ts`

The lattice adds a second, subtler requirement. `controlFieldsFor(layout)` must produce a
bit-identical `Float32Array` from the same layout every time, on every platform — because the
lattice reaches the *fields*, and a field that differs in the last bit between two runs is a
coastline that differs between two chunks generated in different sessions. So the builder
accumulates in a fixed order, and the river writeback runs its single pass over `valleys`
sorted on a stable key rather than in trace order.

## Testing

The heart of this design is that the parts which decide playability need no model to test.

- **Property tests, tier 1.** A corpus of hand-written story bibles covering the awkward
  shapes — needs a harbour and a stronghold, all beats in one town, ten beats, needs a cave
  and a ruin, landlocked, island-heavy — crossed with 500 seeds and four durations. Assert
  the solve rate, and assert that every reported solution satisfies every invariant. Zero
  model calls.
- **Property tests, tier 2.** For every solution above: every required structure exists, is
  the right kind, is reachable, was never filler, was never demolished, and every required
  anchor is present.
- **Lattice tests.** Three separate properties, because they fail separately. *Continuity*:
  sample `slopeAt` along a line crossing many lattice boundaries and assert no spike at the
  boundaries — the test that catches bilinear-instead-of-bicubic. *Fade*: fields outside the
  bounds are identical with and without a layout. *Cost*: a benchmark on `elevationAt` and
  `slopeAt` with and without a lattice, with a budget, since this is the chunk's hottest path.
- **Golden tests.** Byte-identical patches for fixed inputs, before and after, and a
  bit-identical control lattice from a fixed layout.
- **Failure tests.** A deliberately unsatisfiable bible produces a `SolveFailure` whose
  `binding` names the right requirement and whose `relaxations`, when applied, produce a
  solvable bible.
- **End to end.** `walkTheStory` over generated artifacts, which is the only test that
  answers "can a person finish this".
- The existing live tests (`thornwick-live`, `green-chapel-live`, `arc-live`, `trees-live`)
  keep running against the hand-written scenarios and must not change.

## Failure: report, do not compromise

When tier 1 cannot construct a world that satisfies every requirement, generation stops and
reports. It does not quietly deliver a smaller story, because quiet degradation is the whole
class of fault this design exists to remove.

Because the layout is edited rather than searched for, this path should be **rare** — it fires
on requirements that contradict each other rather than on an unlucky seed. A stronghold that
must be both remote and reachable on foot within 320 tiles is a contradiction no terrain can
resolve, and that is the kind of thing worth telling a person about.

The report must be actionable rather than a dead end:

```
This premise needs a stronghold that is remote and within 320 tiles on foot.
No layout satisfies both — "remote" pushes it past the walk you asked for.

  · a harbour, 210 tiles out                    ✓
  · three settlements                           ✓
  · a stronghold, remote, ≤320 tiles            ✗  ← binding

  1. the stronghold becomes a fortified village      (SubstituteKind)
  2. drop "remote" from the stronghold               (DropQuality)
  3. hold the last two beats in one place            (MergePlaces)
  4. allow legs up to 480 tiles                      (WidenLegs)
  5. generate a larger world                         (GrowDuration)
```

Each option is a `Relaxation`, applied purely, re-entering the solver. One model call has
been spent at this point and nothing has been written.

## Phases

Each is independently shippable and each is verifiable on its own.

1. **Requirements and invariants, no behaviour change.** Define the types; implement the
   invariant checks as functions; run them against the three scenarios that prompted this so
   that each observed symptom is attributed to a named violated invariant. Measurement before
   rewrite, and the only way to know afterwards whether any of this worked.
2. **Tier-2 place solver.** Reservation before decoration in `settlement.ts`. Pure,
   property-tested, zero tokens, and independent of everything else in this document. First
   because it is the single change that most directly fixes "the location cannot be found",
   and it can ship while the rest is still being designed.
3. **Bridges.** `roads.ts` cost function, `pipeline.ts` S5 stamping, `gridFor` passability.
   Golden tests for the seam. Small, contained, and it widens what tier 1 can solve.
4. **The control lattice.** Field plumbing only, with no story anywhere near it:
   `WorldLayout`, `controlFieldsFor`, bicubic sampling, fade at the bounds, the free path when
   there is no layout. Continuity, fade and cost tests. This is the riskiest phase and it is
   deliberately isolated, so that when a coastline goes wrong there is exactly one new thing
   it can be.
5. **Tier-1 world constructor.** Sketch, edit, verify. Pure, property-tested, zero tokens.
6. **Rivers.** Rises under stage sites, the one-pass valley writeback, the deflection
   backstop. After tier 1 because it needs to know where the stage is.
7. **`src/forge/` pipeline.** Passes A–I wired, behind a flag in `generate.ts`, with the old
   path kept until the walk-gate pass rate on a fixed seed corpus beats it.
8. **Non-rectangular buildings.** `BuildingPlacement.rect` becomes the bounding box beside a
   new `footprint?: readonly Rect[]` — a union of rectangles giving L, T, U and courtyard
   shapes — so every existing reader keeps working unchanged. Wall stamping becomes the
   boundary of the union; door choice becomes the union edge tile nearest the street.
   Interiors are already separate grids keyed by `interiorId`, so their room graphs are
   independent work.

Two orderings are deliberate. **Phase 2 comes before all the world work** because it is
independent of it, needs no model, and addresses the loudest symptom — there is no reason to
wait for terrain to fix a building that was never binding. **Phase 8 is last** because it is
the least reliability-critical thing in this document, and attempting novel geometry inside a
solver that is not yet proven means debugging both at once.

## What is retired, once forge is proven

- `src/ai/author/*` — replaced by `src/forge/`
- `hidingPlace` (`author.ts:657`) — the building is asked for on purpose, so there is
  nothing to fall back to
- the defensive half of `lowerArc` (`author.ts:664-805`) — the model can no longer emit an
  index, a sibling-arm parent, or a hallucinated site
- "the spec is advisory" in `settlement.ts` — the spec becomes binding

## Non-goals

- Changing the runtime contract. `ScenarioArtifact` gains fields and loses none.
- Rewriting `src/engine`.
- Touching the hand-written scenarios, or the packs.
- The live in-game director. It has a different problem — it cannot see the future — and
  nothing here applies to it.
- Free-form branching narrative. The spine-and-leaves shape is a deliberate constraint.
- Changing how unbounded worlds generate. A layout exists only inside a scenario's bounds and
  fades to zero at them, so a world with no layout — which is every live world, and every
  existing test fixture — generates exactly as it does today. That is a property the lattice
  tests assert rather than a hope.
