# Scenarios

A scenario is an answer to the question "what is this world *about*?" — supplied
up front rather than discovered as the player walks.

Today a world has a premise the model invents on first contact
(`lorePrompt()` takes no arguments) and a story that emerges, if it emerges at
all, from whatever an NPC happened to improvise. That is the right default for an
infinite world, and it stays the default. But it makes two things impossible: you
cannot ask for *a particular* story, and you cannot play a good one twice.

Scenarios add both, in three flavours that differ only in **when** the authoring
happens.

| Flavour | Authoring | Model at play time |
|---|---|---|
| `procedural` | none — deterministic fallbacks | never |
| `live` | during play, in the background | yes |
| `prebuilt` | ahead of time, into an artifact | **never** |

`procedural` is today's `NO_AI=1`, unchanged. `live` is today's default plus a
brief. `prebuilt` is new: every model call has already happened, the results are
in a file, and the game is a pure function of that file.

## Why this is cheap

Every model output in the game already passes through one of four typed shapes,
and three of them are already persisted with a deterministic fallback behind
them:

| Shape | Produced by | Persisted as |
|---|---|---|
| `WorldLore` | `Director.ensureLore` | `state.lore` |
| `RegionSpec` | `Director.ensureRegion` | `state.regions` |
| `SiteSpec` | `Director.resolveSite` | `state.sites` |
| `DialogueTurnResponse` | `dialogue.ts` | — (interactive) |

`Director` already accepts `{lore, regions, sites, sources, disabled}` in its
constructor. **A prebuilt scenario is a pre-populated version of those four
fields.** There is no second Director, no alternate generation path, and no new
branch on the movement path — `prebuilt` is `disabled: true` with the answers
already in hand.

It also gets a property no other flavour has. In `live`, a spec arriving late
triggers `rebuildSite`, and the commitment rule in `Director` exists precisely to
stop a town rearranging itself around a standing player. In `prebuilt` every spec
is present before the first frame, so there is no late spec, no rebuild, and no
commitment race. The town the player walks into is the authored one, always.

The genuinely new runtime component is scripted dialogue — and `canned.ts`
already proves its shape: a deterministic provider returning
`DialogueTurnResponse`. Authored trees are a richer sibling of it, not a new
subsystem.

## The brief

The brief is shared by `live` and `prebuilt`, which is what makes "guide a live
world's generation" fall out of this work rather than being a second feature.

```ts
interface ScenarioBrief {
  readonly premise?: string;      // freeform, the main knob
  readonly setting?: string;      // "a drowned archipelago of debt-collectors"
  readonly storyline?: string;    // "find a sibling who joined the tithe-ships"
  readonly tone?: string;
  readonly protagonist?: string;
  readonly avoid?: string;
  readonly duration?: Duration;   // "short" | "medium" | "long"
}
```

`premise` is freeform and is what most people will use — `SCENARIO_PROMPT`, or
one text field in the launcher. The rest refine it. It lives in
`core/world/brief.ts` rather than `src/scenario/`, for the reason `spec.ts`
already gives for `WorldLore`: it is persisted in `GameState`, and core cannot
depend on anything above it.

Every prompt normalises its own brief instead of trusting the caller. Briefs
arrive from environment variables, a launcher field and artifact JSON, and a
whitespace-only field from any of them has to read as silence — a brief that says
nothing must leave the default prompts byte-identical, or every world that
predates briefs would start generating differently.

The injection point is `prompt.ts`, and the house rule there does not change: the
model is *naming and populating a place the engine already built*. A brief adds
intent, never geometry. `lorePrompt(brief?)` replaces the hardcoded premise;
`regionPrompt` and `sitePrompt` gain `brief` and, in `prebuilt`, the site's role
in the arc.

A `live` world persists its brief in `state.brief`, so a resumed world keeps
generating in the same key rather than reverting to the generic premise on the
next region it reaches.

## Duration

Duration is the only field that means something mechanical, because in a bounded
world narrative length and spatial extent are the same knob.

| | beats | footprint radius | walking | estimate |
|---|---|---|---|---|
| `short` | 3 | 4 chunks | ~1500 tiles | ~30 min |
| `medium` | 6 | 6 chunks | ~4500 tiles | ~1.5 hr |
| `long` | 10 | 9 chunks | ~12000 tiles | ~4 hr |

The estimate is checked rather than asserted. Validation paths
`spawn → beat₁ → … → beatₙ` with A\* over the *bounded* world and warns when the
result is more than 40% off the table. At radius 9 that is a 1216² grid per leg,
which is fine offline but is the slowest thing in the pipeline — path over a
downsampled passability grid first and only go full-resolution when the coarse
path fails.

Tiles-per-minute is a guess about the player, not a fact about the world. Treat
the estimate as an ordering, not a promise.

## The artifact

One versioned JSON file, self-contained and shareable.

```ts
interface ScenarioArtifact {
  readonly artifactVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly brief: ScenarioBrief;

  readonly seed: number;                     // authoritative — see below
  readonly spawn: { x: number; y: number };
  readonly bounds: WorldBounds;

  readonly lore: WorldLore;
  readonly regions: Record<string, RegionSpec>;
  readonly sites: Record<string, SiteSpec>;
  readonly arc: ScenarioArc;
  readonly trees: Record<string, DialogueTree>;

  readonly authoredWith: {
    readonly models: Record<string, string>;
    readonly calls: number;
    readonly at: string;
  };
}
```

**The seed lives in the artifact, not the environment.** This is load-bearing.
Site ids are `hash32(seed, 0x51e0, mx, my)`, so an artifact loaded against a
different seed would key its specs to sites that do not exist — a world of
correctly-named towns standing in the wrong places, or nowhere. `WORLD_SEED` is
ignored when a scenario is loaded, the same way a save's own seed already wins
over the configured one.

Dialogue trees key off `npcId(siteId, slot)`. Both halves are deterministic —
the site id from the macro hash, the slot from the array index `resolveSite`
assigns — so tree keys are computable at authoring time with no runtime
cooperation at all.

## The boundary

A scenario is a bounded map, not a slice of an infinite world. The story needs to
know where it ends, and validation needs a closed region to reason about.

Two constraints shape the implementation. The flags byte is fully allocated, and
`flags.ts` asks that new state be derived from terrain where it can be — so
**there is no `Boundary` flag**. The band is made of terrain that is already
impassable: `deepWater`, `cliff`, `mountain`, none of which carry `Passable`.
This also makes it unbreakable for free. The rewrite removed runtime
wall-breaking outright (`settlement.test.ts`: "the old design let the player
punch through stone when an objective was unreachable"), so nothing in the game
mutates terrain for passability and nothing can open the band.

```ts
interface WorldBounds {
  readonly minX: number; readonly minY: number;
  readonly maxX: number; readonly maxY: number;
  readonly style: "ocean" | "cliffs" | "mountains" | "chasm";
  readonly thickness: number;   // ~6-10 tiles
}
```

`GenContext` gains an optional `bounds`, and `generateChunk` gains one stage:

> **S9 — boundary.** Runs after the settlement patches are stamped, so it wins
> over any patch that reaches the edge, and before the water/passable tally, so
> `TerrainSummary` describes what the chunk actually is.

The seam contract survives intact. A tile remains a pure function of
`(seed, worldPosition, bounds)`, and `bounds` is a scenario constant — no stage
reads another chunk, so chunks still cannot disagree. The band's inner edge takes
`fbm2` jitter at the world seed so it reads as geography rather than a ruler
line; that is the same trick `groundPatchAt` uses, and it costs nothing.

Because `bounds` is optional and no caller passes it today, the goldens do not
change and `procedural`/`live` stay unbounded infinite worlds.

Threading: `ChunkManager` and `findSpawn` both construct a `GenContext` and both
need it. Nothing else does.

What the player sees costs nothing either — `describeFaced` already narrates
terrain, so walking into the band reads *"Bare stone climbing out of sight."*
The world-map panel should draw the extent, so the edge is legible before it is
reached.

Three things the boundary demands of the authoring pass, all possible only
because the generator is pure and available offline:

- **The rect must not intersect any site footprint.** Every site position and
  radius is known from `sitesAround` before a single model call, so the pass
  solves for a rect that lands in the gaps. This is what stops a town being half
  clipped into a cliff face.
- **A\* runs with bounds applied.** Arc reachability is checked against the real
  bounded world, not the infinite one it was surveyed from.
- **Style must suit the edge.** Do not ring a desert in ocean. The model picks;
  the validator checks the choice against `biomeAt` along the band.

A road that runs into the band simply dead-ends. That reads acceptably for
`cliffs` and `mountains`; for `ocean` and `chasm` it reads better still. Not
worth a generator change in v1.

## The arc

No new rules engine. `verifyQuests` already latches objectives against `have`,
`flag`, `reach` and `talk` after every command, and `mapActions` already lowers
declarative actions into `DomainEffect[]`. A beat is therefore a thin wrapper
over primitives that exist:

```ts
interface ScenarioBeat {
  readonly id: string;
  readonly order: number;
  readonly siteId: number;        // where it is anchored
  readonly npcSlot: number;       // and with whom
  readonly requires: readonly string[];   // flag gate
  readonly setsFlag: string;
  readonly quest?: Quest;
  readonly journal?: string;
}
```

Beats gate on flags. Quests complete through the existing verifier, so a beat
cannot wedge because an NPC forgot to call `completeQuest` — the failure mode
`quests.ts` was written to eliminate. Dialogue nodes carry `ActionResponse`
values, so a baked conversation can give items, open quests, adjust reputation
and set flags through zero new runtime machinery.

## Dialogue trees

```ts
interface DialogueNode {
  readonly id: string;
  readonly speech: string;
  readonly requires?: readonly string[];    // flags / quest ids — state variants
  readonly choices: readonly { text: string; goto: string | null }[];
  readonly actions?: readonly ActionResponse[];
}

interface DialogueTree {
  readonly npcId: string;
  readonly entry: string;      // first meeting
  readonly revisit?: string;   // every meeting after
  readonly nodes: Record<string, DialogueNode>;
}
```

The runtime cursor is a new `node?: string` on `NpcRecord` — already persisted
per NPC, already survives ESC, a reload and chunk eviction, and already the home
of the stable-id invariant this depends on.

`scripted.ts` returns the same `{runDialogueTurn, summarizeNpc}` pair
`createDialogueService` does, so `effect-runner.ts` does not change.
`summarizeNpc` takes the existing trim-only branch: memory still stays bounded,
it just stops being rewritten.

**Any node miss falls through to `cannedTurn`.** The tree is an enrichment over a
floor that already works, never a cliff.

The honest limitation: a baked tree cannot react to arbitrary player state the
way a live call can. `requires` variants and a revisit node cover the cases worth
covering; a player who does something genuinely strange gets a stiff
conversation. That is the price of the mode, and it is why `live` remains the
default.

## Authoring

`src/tools/author.ts`, run offline, checkpointing between passes because it is
expensive enough to want resuming.

| Pass | Does | Cost |
|---|---|---|
| 0 | **Survey.** `findSpawn`, `sitesAround` over the footprint, `siteContext`/`regionContext` for each, boundary-rect solve | free — all pure |
| 1 | **Lore** from the brief | 1 call |
| 2 | **Arc** — beats placed over the surveyed sites | 1 call |
| 3 | **Regions** | ~6 calls |
| 4 | **Sites**, each told its arc role | ~13 calls |
| 5 | **Trees**, per NPC | ~40 calls |
| 6 | **Validate and repair** | free |

Pass 0 is why this produces better worlds than `live` can. The model is handed
the real site list — kinds, importance, bearings, building budgets, distances —
before it invents anything. Pass 2 runs *before* sites deliberately, so each site
knows its place in the story rather than having one assigned afterwards.

At radius 6 that is roughly 60 calls: ~169 macro cells, ~13 settlements, ~40
people. A couple of minutes at Flash speeds with a concurrency of 4.

### Validation is the point

Pass 6 is the strongest argument for prebuilt scenarios existing. The entire
generator is pure and runs offline, so the authoring tool can execute it against
its own output and check things live generation structurally cannot:

- every `NpcSpec.structureName` matches a building the settlement generator
  actually placed, and every `placement` anchor exists
- `buildingBudget` is respected
- quest `reach` targets resolve through `placeNameAt`; `have` items are
  obtainable somewhere in the arc
- beat sites are A\*-reachable from spawn *within the bounds*, and the walking
  distance matches the requested duration
- the boundary rect intersects no site footprint and suits its edge biome
- every tree node is reachable and every `goto` resolves

Failures feed a repair pass. A golden test asserts the artifact's site ids equal
`macroSite(seed, mx, my).id`, which is the one invariant that silently ruins
everything if it breaks.

## Launcher

`main.tsx` currently builds the whole session before `render`. That splits:

- `src/session.ts` — `buildSession(choice: LaunchChoice)`, everything
  `startGame` does except rendering.
- `src/ui/launcher/` — an Ink screen listing saves (`saveRoot()/saves/*/save.json`)
  and scenarios (`saveRoot()/scenarios/*.json`, plus `--scenario <path>`), with a
  **New game** submenu choosing flavour and a text field for a live brief.
- `main.tsx` — render launcher, await a choice, build the session, render `App`.

There is no text input component yet, because dialogue is choice-only. A ~40-line
`useInput` field is preferable to adding `ink-text-input` for one screen.

Saves gain `world.scenarioId?`, so resuming re-attaches the artifact: the save
carries the specs, but the trees, arc and bounds live only in the file. The field
is optional, so `SAVE_VERSION` does not move.

## Layout

| Path | What it is |
|---|---|
| `src/core/world/brief.ts` | `ScenarioBrief` and `Duration`, pure — it is saved state |
| `src/scenario/scenario.ts` | Artifact and arc types, `ARTIFACT_VERSION` |
| `src/scenario/schema.ts` | Zod schemas for the artifact |
| `src/scenario/repo.ts` | List and load artifacts |
| `src/scenario/arc.ts` | Beat → quest/flag lowering (pure) |
| `src/ai/dialogue/scripted.ts` | Tree walker and the scripted service |
| `src/ai/author/` | The offline pipeline and its prompts |
| `src/tools/author.ts` | CLI entry point |
| `src/ui/launcher/` | The selector |
| `src/session.ts` | Session assembly, extracted from `main.tsx` |
| `src/core/gen/bounds.ts` | S9, pure — lives in `core` and imports nothing new |

## Phases

Each phase leaves the game playable.

| # | Lands |
|---|---|
| 1 | ✅ `ScenarioBrief`; brief-aware prompts; brief persisted; `SCENARIO_*` env. Promptable `live`, no new UI. |
| 2 | Launcher, selector, flavour picker, `session.ts` split. |
| 3 | Artifact format, repo, `prebuilt` loading of lore/regions/sites. A working pre-gen mode with canned conversation. |
| 3b | `bounds` in `GenContext`, S9, threading, seam tests. Small and independent; can land beside 3. |
| 4 | The authoring tool and its validation pass, including the boundary solve. |
| 5 | The arc: baked quests, flags, journal. |
| 6 | Dialogue trees, authored and walked. |

Phase 3 plus 4 is the feature in rough form. Phase 6 is where it gets good.
