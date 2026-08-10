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

Two properties of the existing generator carry the whole design.

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
| C | tier-1 world solve | 0 | **reports and stops** |
| D | tier-2 place solve, per stage site | 0 | returns to C with that site excluded |
| E | name and populate | parallel | falls back to deterministic specs |
| F | lower to artifact | 0 | mechanical, cannot fail |
| G | prose: serial along the spine, then parallel | serial + pooled | a missing tree is a finding |
| H | judge: validate, repair, mend, **walk** | mend only | findings, and a bounded retry on a failed walk |

The expensive half is E and G. Everything that can make a world unplayable is decided in C
and D, which cost nothing, so the floor on a failed generation is **one model call**. That
one call is unavoidable: requirements come from the story, and there is no story before
pass A.

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
flag, item placement or lock that implements it is *generated* in pass F rather than
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

## Tier 1: the world solver

Given `WorldRequirement` — the places, their kinds and qualities, leg-length bounds,
connectivity, region spread — search over `(seed, recipe)` for a world that satisfies every
one. Layered so that cost is only paid by survivors.

1. **Field prefilter.** Microseconds. Samples `elevationAt`, `slopeAt`, `civilizationAt`,
   `moistureAt` on a coarse lattice over the candidate bounds. Rejects a seed with no
   coastline when the story needs a harbour, no high ground when it needs a stronghold, no
   habitable land when it needs four settlements. No chunk is generated and no site is
   built.
2. **Macro match.** Milliseconds. `macroSite` per cell over the bounds; match place
   requirements to rolled sites in spine order under hard constraints — distance from spawn
   roughly increasing, no single leg longer than `LONG_MARCH` (320 tiles) and the whole walk
   no shorter than `SHORT_STORY` (60 tiles). Both numbers come from
   `src/scenario/validate.ts:135-136`, where they were learned from real playthroughs: a long
   single leg is what actually spoils a session, and a total walk that short is a story that
   never leaves the room it started in. They are used at the same altitude here as there —
   `LONG_MARCH` per leg (`validate.ts:1432`), `SHORT_STORY` against the total
   (`validate.ts:1438`) — so the solver and the judge cannot disagree about pacing.
   Region spread where asked for.
3. **Recipe nudge and pin.** Milliseconds. An unmatched requirement first tries a weight
   nudge (a world that wants two more villages can have them), then a `PlaceRecipe` pin.
   A pin must itself pass the ground test `siteKindAt` would have applied — above
   `seaLevel`, under `maxSlope`, shoreline for docks, hillside for caves — because
   `macroSite:75-90` honours a pin **outright and unchecked**, and a bad pin puts a village
   in the sea. The pin's radius is clamped so `maxFeatureRadius` cannot exceed `HALO`
   (`macro.ts:198-215`).
4. **Finalist verify.** Seconds, and only for the best few candidates. Full passability
   sweep of the bounded world; `reachableFrom` the spawn; `roadBetween` for every leg,
   including bridges. This is the only stage that generates chunks.

The search starts at `resolveSeed(id)` (`src/scenario/generate.ts:134`) and walks outward
deterministically. Reproducibility survives because the artifact already records the answer
in `artifact.seed`; what changes is that the id names *where the search began* rather than
the world itself, and that needs saying in `artifact.ts` where the current contract is
documented.

**Bounded.** A trial budget per stage, and a wall-clock ceiling. Exhaustion is a
`SolveFailure`, never a compromise.

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
what nobody predicted — plus **`walkTheStory` promoted into the pipeline** as pass H's gate.
A walk that does not finish is the one condition that earns a bounded retry.

The point of moving these earlier is not that the final pass is wrong. It is that a fault
found in pass C costs nothing and a fault found in pass H costs a whole generation.

### Additions to `ScenarioArtifact`

Additive only.

- `arc.beats[].because?: string` — the causal reason, so the journal can say it and
  `checkCausality` can check it
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
- **Golden tests.** Byte-identical patches for fixed inputs, before and after.
- **Failure tests.** A deliberately unsatisfiable bible produces a `SolveFailure` whose
  `binding` names the right requirement and whose `relaxations`, when applied, produce a
  solvable bible.
- **End to end.** `walkTheStory` over generated artifacts, which is the only test that
  answers "can a person finish this".
- The existing live tests (`thornwick-live`, `green-chapel-live`, `arc-live`, `trees-live`)
  keep running against the hand-written scenarios and must not change.

## Failure: report, do not compromise

When tier 1 exhausts its budget, generation stops and reports. It does not quietly deliver a
smaller story, because quiet degradation is the whole class of fault this design exists to
remove.

The report must be actionable rather than a dead end:

```
This premise needs a harbour and a stronghold within 320 tiles of each other.
No world in 300 seeds had both. What the ground offered instead:

  · a harbour, 210 tiles out                    ✓
  · a stronghold — nothing within 640 tiles     ✗  ← binding

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
   that each observed symptom is attributed to a named violated invariant. Measurement
   before rewrite.
2. **Bridges.** `roads.ts` cost function, `pipeline.ts` S5 stamping, `gridFor` passability.
   Golden tests for the seam.
3. **Tier-1 world solver.** Pure, property-tested, zero tokens.
4. **Tier-2 place solver.** Pure, property-tested, zero tokens. This is the phase that most
   directly fixes "the location cannot be found".
5. **`src/forge/` pipeline.** Passes A–H wired, behind a flag in `generate.ts`, with the old
   path kept until the walk-gate pass rate on a fixed seed corpus beats it.
6. **Non-rectangular buildings.** `BuildingPlacement.rect` becomes the bounding box beside
   a new `footprint?: readonly Rect[]` — a union of rectangles giving L, T, U and courtyard
   shapes — so every existing reader keeps working unchanged. Wall stamping becomes the
   boundary of the union; door choice becomes the union edge tile nearest the street.
   Interiors are already separate grids keyed by `interiorId`, so their room graphs are
   independent work.

Phase 6 is deliberately last. It is the least reliability-critical thing in this document,
and attempting it inside a solver that is not yet proven would mean debugging geometry and
constraint satisfaction at the same time.

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
