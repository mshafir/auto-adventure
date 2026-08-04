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
  // Added, optional, in phases 5 and 6 — a v1 reader ignores what it does not know.
  readonly arc?: ScenarioArc;
  readonly trees?: Record<string, DialogueTree>;

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
Three styles, not the four first sketched — a chasm has no terrain to be made of,
and a style the renderer cannot express is not a style.
This also makes it unbreakable for free. The rewrite removed runtime
wall-breaking outright (`settlement.test.ts`: "the old design let the player
punch through stone when an objective was unreachable"), so nothing in the game
mutates terrain for passability and nothing can open the band.

```ts
interface WorldBounds {
  readonly minX: number; readonly minY: number;
  readonly maxX: number; readonly maxY: number;
  readonly style: "ocean" | "cliffs" | "mountains";
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
`cliffs` and `mountains`; for `ocean` it reads better still. Not
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
  readonly card?: CardBody;      // a full screen, for a turn dialogue cannot carry
}
```

Beats gate on flags. Quests complete through the existing verifier, so a beat
cannot wedge because an NPC forgot to call `completeQuest` — the failure mode
`quests.ts` was written to eliminate. Dialogue nodes carry `ActionResponse`
values, so a baked conversation can give items, open quests, adjust reputation
and set flags through zero new runtime machinery.

## The story on screen

Two panes read the arc, and both were thinner than the arc deserved.

**The quest pane** pins the main quest above the errand list, reachable without
moving a cursor, because the arc is not an errand: it has no bearing, it cannot be
completed by walking somewhere, and it is the thing a player most often wants
reminding of. `arcOutline(arc, state)` assembles it:

```
─ THE HOLLOW TITHE 1/3 ─────
Your sister took the warden's badge, walked the…
[x] Take the tally to Stonewait
[~] Timber for the mill
─ CLUES ────────────────────
• Ilse Marrow keeps her own count, and it is short…
```

It is deliberately **backwards-looking**. Steps already reached, the clues already
gathered, and a count of what remains — never *what* remains. The next step is
already the open errand below it with a bearing on the map; naming the beat after
that would hand over the plot in the first minute.

A step ticks `[x]` only once its errand is *finished*, and shows `[~]` while it is
still in hand. Ticking on the beat merely opening was visibly wrong: the outline
showed a step complete while that very errand sat open in the list underneath it.

Clues are read out of the journal **by source**, not stored twice, so a clue and
the entry reporting it cannot disagree. `beatEffects` tags its journal line with
`arc:<beatId>`; matching on prose would orphan every clue in an existing save the
first time an author edited a line.

**The journal** recorded only outcomes. An errand appeared in the log when it
finished and never when it was given, and a three-step errand left no trace at all
until the moment it closed — which made the log useless for remembering where you
had got to. It now records:

| When | Entry |
| --- | --- |
| a quest is created | `New errand: Take the tally to Stonewait.` |
| an objective ticks off, errand still open | `Take the tally to Stonewait: go to Stonewait — done.` |
| the errand finishes | `Completed: Take the tally to Stonewait.` |
| a beat opens | whatever the author wrote, tagged `arc:<beatId>` |
| a place is first entered | `Arrived in Bracken Cross.` |

Every entry carries a `source` — the quest id or the beat — so the log can be read
back by errand as well as by time. A finish is announced *once*: a single-objective
errand satisfies its last objective and completes in the same step, and reporting
both would put two lines in the log for one act.

`describeObjective` moved into `core/rules/quests.ts` for this. The pane and the log
now phrase an objective with the same words, and two copies would drift in a way the
player would see.

## Framing cards

The game used to drop the player onto a tile with a place name in the corner and
no statement of where they were, who they were, or why they had come. All three
facts existed already — in the lore, in the brief, in the arc premise — and none
were ever said out loud.

A `Card` is a full screen of prose, raised by a `DomainEffect` and shown *once*:

```ts
interface Card {
  readonly id: string;            // becomes `card:<id>` in the flags
  readonly title: string;
  readonly subtitle?: string;
  readonly sections: readonly { heading: string; body: string }[];
  readonly footer?: string;
}
```

Two properties earn it a place in state rather than in the UI.

**Anything that can change the game can raise one.** It is an effect, so a beat,
an arrival or a discovery can put one up without the UI knowing what occasions
exist. `beatEffects` emits it after the quest and the journal, so what the player
reads is already true of the game behind the card.

**It is read once, ever.** The id becomes a persisted flag, set in the same step
the card goes up. A beat re-applied after a partial save, or a world resumed from
a save that already read it, cannot show it twice — and the card itself is
dropped on load like `dialogue` and `notice`, so a save taken mid-read does not
come back blocking the first keypress.

Cards block movement, interaction and conversation while up (`CARD_BLOCKS` in
`reduce.ts`), because framing that can be walked out of unread is framing nobody
reads. Everything asynchronous stays live, so the world behind it is complete by
the time it comes down.

### The opening

`openingCard()` assembles three fixed headings — the questions a player has in
the first ten seconds, in the order they have them:

| Heading | Prebuilt | Live | Procedural |
| --- | --- | --- | --- |
| Where you are | artifact lore + region + town | model lore, once it lands | fallback lore + landscape |
| Who you are | `brief.protagonist` | `brief.protagonist` | a default line |
| What brought you here | `arc.premise` | `brief.storyline` | admits there is no errand |

Every part is optional and an empty part produces no heading, so the thinnest
case — procedural, unbriefed — still reads as deliberate rather than broken. It
never invents a motive: with no arc to hold the player to, there is no promise
worth making.

Timing is the one place the flavours differ. With no model the lore is already
known, so `buildSession` raises the card immediately. With one, `getLore()` would
answer with the deterministic fallback and the card would describe a world the
game is about to replace — so it waits for `onLore`, which the director always
fires, adopting its own fallback if the call fails.

## People indoors

Every interior was empty. You could walk into a house, read the furniture, search
a crate and leave, and the only people in a town of twenty buildings were the
three or four standing outdoors.

`residentsOf(seed, interiorId, kind, interior)` is pure, like everything else
about an interior, so a house always holds the same people without any of them
being stored. Ids are `npc:in:{interiorId}:{slot}` — namespaced away from a
site's `npc:{siteId}:{slot}`, since both halves are hashes and could otherwise
collide into one shared memory record.

The division of labour is deliberate. A town's **principals** come from the
director: three or four per town, named by a model, carrying what they know and
their part in the story. **Residents** are the other thirty, and a model call
each would cost ten times the whole world for people whose function is to be
somebody home when you knock. So the engine decides that a house holds a weaver
and a child, and the model earns its keep in the *dialogue* — a live world
improvises with them, a scenario falls back to the deterministic tree.

They present as `PlacedNpc` at every read site. `engine.personAt` and
`personById` promote a resident by filling in the two things that differ: their
position is interior-local, and their site is resolved **from the doorway**
(`inside.returnX/Y`) rather than from the player's own coordinates, which indoors
would answer about whatever town sits near the world origin. That promotion is
why a conversation with somebody's cooper works without the dialogue layer
knowing residents exist — and why a resident can tell you the town's hook.

## Content packs

Everything a world is *called* used to be a `const` table in the module that read
it: name syllables in `names.ts`, outdoor trades in `fallback.ts`, households and
their appearance lines in `residents.ts`. A timber-levy road and a drowned
archipelago want different registers, and the tables were the last thing in the
pipeline a scenario could not touch.

A `ContentPack` is those tables as data. Two rules keep it from becoming a
configuration language:

**Cosmetic only.** Nothing in a pack decides whether a tile is passable, what a
container holds, or what a shop stocks. So a world opened with the wrong pack looks
different but cannot become unplayable, and a quest can never start naming an item
that no longer generates.

**Owned by the world.** Names are *derived*, not stored — so adopting a different
pack mid-world would rename everybody the player had already met while keeping
their memories. A pack override travels in the save and in the artifact, exactly
like the brief, and a world with one of its own ignores whatever is offered.

| Table | What it changes |
| --- | --- |
| `names.given` / `family` | who people are called |
| `names.heads` / `tails` / `ruinTails` / `fortTails` / `regionTails` | how places and regions are named |
| `households` | who lives in each kind of building, and how many |
| `appearance` | the one telling detail the examine verb prints |
| `talksAbout` | what a resident will discuss, which the canned tree leans on |
| `outdoorRoles` | who stands outside each kind of building |
| `wanderers` | the people at the well and the bench |
| `lore` | the premise a world with no model runs on |
| `ambient` | flavour lines for a region nobody wrote |

### Merge rules

An override is partial, and the two rules differ on purpose:

- **Maps merge by key.** Changing one trade's appearance is one line; the other
  thirty keep the default. Restating thirty lines to change one is how a format
  stops being used.
- **Lists replace.** Supplying `given` means "these are the given names in my
  world". Appending would leave exactly the names the author was trying to remove.

### Where a pack comes from

```
CONTENT_PACK=thornwick npm start        # a shipped pack, by name
CONTENT_PACK=./my-pack.json npm start   # or a path, so one can live beside a draft
```

…or `"content": { … }` in a scenario draft, which is inlined into the artifact so
the scenario is self-contained: no file to install, nothing beside it to lose.

The baked default is **code** (`core/content/default.ts`), not a file, so the pure
generators always have a complete set of tables with no filesystem in the path —
`core` has to stay callable from a validator and a test. `assets/content/default.json`
is the same data as a file, for authors to copy, and a test pins the two together so
they cannot drift. A missing or invalid pack logs and falls back to the default
rather than refusing to start: a player asked to play, not to debug their JSON.

## Dialogue trees

```ts
interface DialogueChoice {
  readonly text: string;
  readonly goto: string | null;           // null ends the conversation
  readonly requires?: readonly string[];  // hidden until these flags are set
}

interface DialogueNode {
  readonly id: string;
  readonly speech: string;
  readonly requires?: readonly string[];  // eligibility as an opening
  readonly choices: readonly DialogueChoice[];
  readonly actions?: readonly ActionResponse[];
}

interface DialogueTree {
  readonly npcId: string;
  readonly entry: readonly string[];      // first meeting, most specific first
  readonly revisit?: readonly string[];   // every meeting after
  readonly nodes: Record<string, DialogueNode>;
}
```

State-sensitivity arrives two ways, and both are list-shaped rather than
single-valued: `entry`/`revisit` are ordered candidates so a character can greet
the player differently once the story has moved, and a choice can be hidden until
its flags are set so the same node offers different ground depending on what the
player knows.

The runtime cursor is a new `node?: string` on `NpcRecord`, moved by a
`SetNpcNode` effect. It belongs there because it is exactly what that record is
for — what an NPC remembers — and because it must survive ESC, a reload and chunk
eviction, all of which that record already does.

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

Testing it needed `test/harness/ink.tsx`. `ink-testing-library` cannot drive the
installed Ink: its fake stdin has no `ref`, which Ink calls to enable raw mode, and
in raw mode Ink reads with `readable`/`read()` while the library emits `data`. The
`ref` failure lands inside a `useEffect`, so the first frame is already committed
and correct and only the *next* one is an error message — which is why the existing
`app.test.tsx` passed while every render under it was throwing. The harness
implements both contracts, so a test can assert what a keypress does rather than
only what a screen looks like.

Saves gain `world.scenarioId?`, so resuming re-attaches the artifact: the save
carries the specs, but the trees, arc and bounds live only in the file. The field
is optional, so `SAVE_VERSION` does not move.

## Layout

| Path | What it is |
|---|---|
| `src/core/world/brief.ts` | `ScenarioBrief` and `Duration`, pure — it is saved state |
| `src/scenario/scenario.ts` | Artifact and arc types, `ARTIFACT_VERSION` |
| `src/scenario/schema.ts` | Zod schemas for the artifact |
| `src/scenario/repo.ts` | List, load, write and verify artifacts |
| `test/harness/ink.tsx` | Render an Ink tree and type at it |
| `src/scenario/arc.ts` | Beat → quest/flag lowering (pure) |
| `src/ai/dialogue/scripted.ts` | Tree walker and the scripted service |
| `src/ai/author/` | The offline pipeline and its prompts |
| `src/scenario/draft.ts` | The hand-authored format, and lowering it to an artifact |
| `src/tools/author.ts` | CLI entry point |
| `src/ui/launcher/` | The selector |
| `src/session.ts` | Session assembly, extracted from `main.tsx` |
| `src/core/gen/bounds.ts` | S9, pure — lives in `core` and imports nothing new |

## Phases

Each phase leaves the game playable.

| # | Lands |
|---|---|
| 1 | ✅ `ScenarioBrief`; brief-aware prompts; brief persisted; `SCENARIO_*` env. Promptable `live`, no new UI. |
| 2 | ✅ Launcher, selector, flavour picker, `session.ts` split. |
| 3 | ✅ Artifact format, repo, `prebuilt` loading of lore/regions/sites. A working pre-gen mode with canned conversation. |
| 3b | ✅ `bounds` in `GenContext`, S9, threading, seam tests. |
| 4 | ✅ The authoring tool and its validation pass, including the boundary solve. |
| 5 | ✅ The arc: baked quests, flags, journal. |
| 6 | ✅ Dialogue trees, authored and walked. |

All six have landed, plus a seventh way in that was not in the original plan:
**authoring by hand**. `npm run survey` prints the map for free and
`npm run assemble` takes a written draft, so a scenario can be produced with no API
key — by a person, or by an agent in an editor session via the `author-scenario`
skill. The draft format asks only for judgement and derives every mechanical part,
which is what makes a hand-written arc impossible to mis-wire.

Two things the implementation learned that the design did not know:

`generateSettlement` memoises by `(seed, siteId)`. That is right for a running
game — one town, generated once — and wrong for validation, which measures several
candidate rosters for the same site in one process and would otherwise report the
first layout for all of them. The pass drops the entry before generating.

Two mechanisms were reaching the same invariant by different means, and one of them
was wrong. The validator matched place names by *substring* while `verifyQuests`
matches on *significant words*, so `reach: "Thorn"` passed authoring against a town
called "Thornwick" and could never complete in play — authoring accepted a quest the
game refused, and the only symptom was an errand that never finished. Name resolution
now lives once in `core/rules/surroundings.ts` (`resolveObjectiveTarget`) and
obtainability once in `core/rules/obtainable.ts`, both called by the engine and the
validator; the engine's four sources for a fetchable item are no longer approximated
by a pattern over NPC roles. Assembly canonicalises `reach` and `talk` targets to the
world's own spelling, which is what the runtime already did for a quest an NPC opens.

The anchor check was also *wrong*, not merely weak, and stayed wrong until a real
draft ran through it. `pickAnchor` treats `yard` as `doorstep` and falls back to any
free anchor otherwise — its own comment says the placement is advisory — so an
unbuilt anchor relocates somebody rather than stranding them. As an error it would
have refused to install perfectly playable scenarios, including every one built from
the deterministic roster, which asks for a `yard` routinely.

Beyond that, the anchor check is weaker than hoped. A settlement of any size lays down
eight of the nine anchor kinds, so only `yard` is realistically ever missing from a
town, and the check earns its keep mainly on hamlets and camps. It stays because
the failure it catches — a named character standing nowhere — is invisible
otherwise.
