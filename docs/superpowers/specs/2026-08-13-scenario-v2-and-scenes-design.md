# Scenario v2, Phases and Scenes

**Status:** approved 2026-08-13. Sub-project 1 of
`2026-08-13-game-maker-architecture-design.md`.

**Done when:** a hand-written scenario *directory* containing a cutscene and two phases
loads, plays, and passes the existing validators — with no CLI and no agent involved.

**Not in scope:** the `craft` CLI (files are hand-written here), elevation terraform,
the skill, and the review loop.

**In scope, and first:** the deletions listed in the umbrella spec. Changing
`readScenario` to load directories breaks `generate.ts` and everything downstream of it
on the first commit, so the old authoring pipeline comes out before the new format goes
in rather than being carried through the work.

---

## 1. What changes and what does not

The engine, renderer and world generator are not restructured. Three things are added:

1. A **directory loader** that produces the same in-memory artifact the engine already
   consumes, so nothing downstream of `readScenario` learns that the file format
   changed.
2. **Phase composition** — a pure function from base content plus game state to the
   resolved content the engine sees.
3. A **scene player** — a state machine in `GameState`, advanced by a new `SceneFrame`
   command dispatched on an interval while a scene runs.

`SceneFrame` is new rather than reusing `Tick` because `tick` is an *action counter*, not
a clock: one per player command, sixty to the in-game hour, and it drives lighting,
weather and NPC schedules. Running a three-second cutscene off it would burn an hour of
daylight. (`Tick` also turns out to be dead — nothing in the tree dispatches it.)

## 2. On-disk format

```
.scenarios/<id>/
  scenario.json      seed, recipe, bounds, spawn, packs, title, blurb, provenance
  story.md           prose. Never parsed. Read by humans and by the agent.
  world/
    sites.json       Record<siteId, SiteSpec>
    terraform.json   authored tile stamps
    placements.json  { placements, signs, barriers }
  phases/
    1-<slug>.json    the base phase: triggers, beats, and nothing else
    2-<slug>.json    a diff
  scenes/
    <scene-id>.json  one scene per file
  trees/
    <npcId>.json     one conversation per file
```

`scenario.json` carries `"artifactVersion": 2`. There is no migration path from v1 —
every existing scenario is deleted on this branch.

**Filenames are the ids.** `scenes/the-messenger-arrives.json` has id
`the-messenger-arrives`; `trees/thornwick-3.json` is the tree for npc `thornwick-3`.
The loader rejects a file whose internal id disagrees with its name, which is the same
rule `repo.ts` already applies to site keys.

**Phase files are ordered by their numeric prefix**, not by directory listing order.

## 3. Phases

### Shape

```ts
export interface Phase {
	readonly id: string;
	readonly name: string;
	/**
	 * When this phase is in force. Absent on the base phase, which is always in force.
	 * Evaluated against GameState like any other condition.
	 */
	readonly when?: Condition;
	readonly sites?: Diff<SiteSpec>;
	readonly placements?: Diff<Placement>;
	readonly signs?: Diff<Sign>;
	readonly barriers?: Diff<AuthoredBarrier>;
	readonly triggers?: Diff<Trigger>;
	readonly terraform?: Diff<TerraformEdit>;
	/** Replaces a conversation wholesale. `null` removes it. */
	readonly trees?: Readonly<Record<string, DialogueTree | null>>;
	/** Beats that only exist once this phase is in force. */
	readonly beats?: readonly ScenarioBeat[];
}

export interface Diff<T> {
	readonly add?: readonly T[];
	/** By id. Removing an id that is not present is an error, not a no-op. */
	readonly remove?: readonly string[];
	/** By id: same id, new content. Replacing an absent id is an error. */
	readonly replace?: readonly T[];
}
```

`remove` and `replace` failing loudly on an absent id is deliberate. A diff that
silently does nothing because the base was refactored underneath it is precisely the
drift that full snapshots would have caused, arriving by a different door.

### Composition

```ts
export function composeScenario(
	base: ScenarioContent,
	phases: readonly Phase[],
	state: GameState,
): ScenarioContent;
```

Pure. Entered phases are those whose `when` holds, applied in file order, each diff over
the result of the last. Memoised on the joined ids of the entered set, because it runs on
every command.

**Phase membership is derived, never stored.** Nothing about which phase is active goes
into the save. A save is flags and deltas, as it is today, and correcting a phase file
corrects saves already in flight.

### Terraform and chunk invalidation

A phase that changes `terraform` changes tiles that are already built and resident, so
entering it must invalidate and rebuild the affected chunks.

`ChunkManager.invalidateRect(rect)` already does exactly this — it exists because a
settlement's spec arriving late has the same problem, and dropping rather than patching is
safe because regeneration is deterministic. Phase entry calls it over the bounding
rectangle of the terraform diff. This is the one place phases reach into the engine.

A phase whose terraform diff is empty — which is most of them — costs nothing.

## 4. Terraform (tile stamps only)

```ts
export type TerraformEdit =
	| { readonly t: "Path"; readonly id: string; readonly from: Point; readonly to: Point;
	    readonly width?: number; readonly surface: "dirt" | "cobble" | "plank" }
	| { readonly t: "Bridge"; readonly id: string; readonly from: Point; readonly to: Point }
	| { readonly t: "Clearing"; readonly id: string; readonly at: Point; readonly radius: number }
	| { readonly t: "Stamp"; readonly id: string; readonly at: Point;
	    readonly tiles: readonly (readonly [dx: number, dy: number, terrain: string])[] };
```

Applied as a `FeaturePatch` during `generateChunk`, alongside the patches the town
generator already produces. `Path` and `Bridge` reuse `carveStreet` from
`core/gen/features/terraform.ts` rather than reimplementing rasterisation.

Elevation brushes are designed in the umbrella spec and **not built here**. When they
arrive they hook into `sampleFieldBuffer` before banding, so that biome, coastline and
the existing procedural `rivers.ts` all respond to a carved valley. Nothing in this
sub-project should make that harder — in particular `TerraformEdit` is a discriminated
union so a new variant is additive.

## 5. Scenes

### Shape

```ts
export interface Scene {
	readonly id: string;
	/** Stage names to real people. `"player"` is always available and needs no entry. */
	readonly cast?: Readonly<Record<string, string>>;
	readonly steps: readonly SceneStep[];
	/** Whether ESC ends it early. Default true. */
	readonly skippable?: boolean;
}

export interface SceneStep {
	/** Actions that run together. The step ends when every one of them has finished. */
	readonly do: readonly SceneAction[];
	/** Ticks to hold after they finish. */
	readonly hold?: number;
}

export type SceneAction =
	| { readonly t: "Camera"; readonly to: ScenePoint; readonly pan?: "cut" | "slow" | "fast" }
	| { readonly t: "Spawn"; readonly actor: string; readonly at: ScenePoint }
	| { readonly t: "Despawn"; readonly actor: string }
	| { readonly t: "WalkTo"; readonly actor: string; readonly to: ScenePoint;
	    readonly speed?: "slow" | "normal" | "fast" }
	| { readonly t: "Face"; readonly actor: string; readonly at: ScenePoint | Facing }
	| { readonly t: "Say"; readonly actor: string; readonly text: string }
	| { readonly t: "Card"; readonly card: Card }
	| { readonly t: "Wait"; readonly ticks: number }
	| { readonly t: "Effects"; readonly effects: readonly DomainEffect[] };
```

`ScenePoint` reuses `PlacementSite` verbatim — the `world`, `interior` and
`site`+`structure`+`anchor` spellings — so a scene point cannot mean something a
placement could not, and both resolve through the same code.

### Staging

A scene is **staged** when it starts and never touched afterwards. Staging resolves
every `ScenePoint` to a definite tile and precomputes every `WalkTo` path with
`findPath` from `core/geom/astar.ts`, which is deterministic. The result is a
`StagedScene` whose actions carry only plain coordinates and tile lists.

This is what keeps `advanceScene` a pure function of `(StagedScene, SceneState)` with no
world access at all — the reducer never pathfinds, and a scene's movement cannot diverge
between two runs. The engine stages and caches; the reducer asks for the staged scene
through `WorldProbe`, the way it already asks `doorAt` and `barrierAt`.

A `WalkTo` whose path cannot be found is a staging failure, reported like an
unresolvable placement rather than silently skipped.

A `Say` action finishes when the player presses SPACE. Everything else finishes on its
own, so a step containing only movement and camera work runs to completion unattended.

### Runtime state

```ts
// added to GameState
readonly scene?: {
	readonly id: string;
	readonly step: number;
	/** Ticks elapsed inside the current step. */
	readonly elapsed: number;
	readonly actors: Readonly<Record<string, SceneActor>>;
	/** Camera target in world coordinates. Absent means follow the player. */
	readonly camera?: Point;
	/** The line on screen, if any. */
	readonly caption?: { readonly speaker: string; readonly text: string };
};

interface SceneActor {
	readonly x: number;
	readonly y: number;
	readonly facing: Facing;
	/** Remaining tiles of a walk, if one is in progress. */
	readonly path?: readonly Point[];
}
```

Started by a new `DomainEffect`, `{ t: "PlayScene", id }`. Advanced by
`{ t: "SceneFrame" }`, which the UI dispatches on an interval for as long as
`state.scene` is set. Ended by running out of steps, or by `{ t: "SkipScene" }` when
`skippable`.

### The three rules that make it safe

**Input is locked.** While `state.scene` is set, the reducer ignores `Move`, `Interact`
and dialogue commands. One guard at the top of `reduce`, not a check in each handler.

**Saving is deferred.** The debounced save waits; a save forced by quitting writes a
state with `scene` cleared. An interrupted scene therefore replays from its first step
next time.

**A trigger's flag is written when its scene completes, not when it fires.** Otherwise
an interrupted scene is marked done and never plays. `pendingTriggers` omits its
`SetFlag` when its effects contain a `PlayScene`, and the scene player writes it on
completion.

Replay makes idempotency load-bearing, so: **`craft check` rejects non-idempotent
effects — `GrantItem`, `TakeItem`, `AdjustGold`, `Damage`, `Heal`, `AdjustDisposition`,
`AdjustReputation` — anywhere but a scene's final step.** In the final step they are
safe, because a scene that reached its last step also wrote its trigger flag. Everything
else in `DomainEffect` is already idempotent by construction. This check is written
here, as a pure function, and merely *called* by the CLI in sub-project 2.

### Rendering

Three additions, all reads of `state.scene`:

- The viewport centres on `state.scene.camera` when present rather than on the player.
  A `pan` interpolates the centre over the step's ticks; `cut` sets it immediately.
- Scene actors draw as sprites at their scene positions. During a scene they take
  precedence over the static NPC placement for the same person, so nobody appears twice.
- `caption` draws as a banner over the world. `Card` reuses the existing full-screen
  card view unchanged.

`ShowCard` remains a `DomainEffect` — it is what beats and dialogue already use — but
authored full-screen text now reaches the player through a scene's `Card` step.

## 6. Loader

```ts
export function readScenarioDir(dir: string): ScenarioArtifact;
```

Reads the directory, validates every file against its schema, resolves the pack, and
returns the same `ScenarioArtifact` shape the engine consumes today plus `phases` and
`scenes`. The engine's entry point does not change; `repo.ts` gains directory reading
and loses single-file reading.

Existing checks that must keep working, unchanged in behaviour: site key agreement with
`siteId`, specs keyed to a seed that produces them, no repeated NPC slots, tree and arc
problems.

## 7. Testing

- **Fixture:** `test/fixtures/scenarios/two-phase/` — a real directory with two towns,
  one cutscene, two phases, and a terraform path. It is the artifact under test for
  everything below and the worked example the skill will point at in sub-project 3.
- **Composition:** unit tests over `composeScenario` — a diff that adds, one that
  removes, one that replaces, a `remove` of an absent id failing loudly, and two phases
  composing in order.
- **Scene player:** pure reducer tests over `Tick` — a walk consumes its path, a step
  with two actions ends when the slower finishes, `Say` blocks until SPACE, a skip
  jumps to the end, and an interrupted scene leaves no trigger flag.
- **Idempotency check:** a scene with `GrantItem` in a middle step is rejected; the same
  scene with it in the last step passes.
- **End to end:** the headless walker plays the fixture from spawn, triggers the scene,
  and finds the world in phase 2 afterwards — including a tile the terraform diff
  changed.
- **Chunk invalidation:** entering a phase with a terraform diff rebuilds the affected
  chunks and leaves untouched ones resident.

## 8. Risks

- **Chunk invalidation on phase entry** reuses `invalidateRect`, but a phase entered
  while the player is standing in the affected rectangle rebuilds the ground under them.
  A terraform diff that removes the tile they occupy could strand them somewhere
  impassable; the engine must re-check passability after a phase-entry rebuild.
- **Scene timing versus the render loop.** `SceneFrame` is dispatched by the UI on an
  interval, and the store already coalesces renders on a frame budget. A slow machine
  makes a scene run slower rather than skip steps, which is the right failure, but it
  means a scene's duration is not guaranteed.
- **A scene has no clock.** Because `SceneFrame` deliberately does not advance world
  time, a long cutscene happens in an instant of game time. Correct for a conversation
  in a square; wrong if a scene ever wants to depict a journey. Accepted.
- **Deferred saving** means a player who quits mid-scene loses the few seconds before
  it. Accepted: a scene is seconds long, and the alternative is making every step
  resumable.
