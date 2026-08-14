# Game-Maker Architecture

**Status:** approved 2026-08-13. **Built 2026-08-14** — all four sub-projects landed on the
`game-maker` branch. What follows is the design as approved; the deviations it took are recorded
at the end.

## The problem

A generated world was handed to a player in which people asked after a document that
did not exist anywhere in it. That is not a bug in one pass — it is the pipeline's
shape. Today a model writes prose about a world, and five passes afterwards try to
argue the world into agreement with the prose: `mend` adds missing conversations,
`repair` moves things that collide, `adjust` rewrites objectives the world cannot
satisfy, `fit` drops side quests that will not open, `polish` reads the result and
reports what it still cannot believe. Each pass is a negotiation between a story that
has already been written and a world that was never consulted.

The stories are also bland, and the two faults share a cause. A model asked to fill in
`premise`, `title` and `tone` writes to the slots.

## The inversion

**The only way to assert a fact about the world is to call a tool that makes it true.**

A story cannot mention a ledger unless a ledger exists — in a container, in a building,
in a named town, at real coordinates on the map. The tool call is the assertion. There
is nothing left to reconcile afterwards, because there was never a second copy of the
truth.

Everything below follows from that one rule.

## Who the agent is

A coding agent running in this repository — Claude Code or equivalent — steered by a
skill and calling a CLI. We build no agent harness.

This was considered and rejected in favour of the above: `ai@7`'s `ToolLoopAgent` would
work, but it means packaging the whole authoring vocabulary for end users, budgeting
every quality decision against a player's wallet, and making a 40-step loop survive ESC
inside an Ink app. Authoring is a dev-time activity whose output ships. The agent that
does it is the one already installed.

Consequences:

- No gateway key is needed to make a world.
- No `ai-sdk` upgrade is needed. `ai@5` stays for runtime dialogue.
- The agent gets ordinary filesystem access, subagents, and a skill — for free.
- Generation cost and time are unbounded and human-supervised, because it runs once.

## What is deleted

The branch does not preserve a working generator. It exists to see the end state of a
different structure.

**Deleted:**

- `src/ai/author/*` — author, prompts, schemas, shape, mend, polish, adjust, pitch,
  lower, reactions (~4.6k lines plus tests).
- `src/scenario/{draft,settle,fit,repair}.ts` — the repair-loop orchestration.
- Launcher generation: `generate-config.tsx`, `generate-progress.tsx`,
  `pick-premise.tsx`, `pick-launch.tsx`'s attempt loop, `src/scenario/generate.ts`.
- `src/tools/author.ts`, `assemble.ts`.
- Every existing `.scenarios/*.json`.

**Kept, repurposed as CLI commands.** These are pure functions over an artifact and are
exactly the validation vocabulary the new pipeline needs:

`validate.ts`, `invariants.ts`, `completeness.ts`, `wayfinding.ts`, `signposts.ts`,
`walk.ts`, `walker.ts`, `play.ts`, `survey.ts`, `passability.ts`, `flag-sources.ts`.

**Untouched:** the engine, the renderer, the world generator, `src/ai/dialogue`,
`src/ai/director`.

## The four sub-projects

Each gets its own spec and produces something testable on its own.

| # | Sub-project | Done when | |
|---|---|---|---|
| 1 | The deletions above, then scenario format v2, phase composition, scene runtime | a hand-written scenario directory with a cutscene and two phases plays | ✅ |
| 2 | The `craft` CLI — full vocabulary, `check`, `playtest`, `play --headless` | that same scenario can be built end to end by CLI alone | ✅ |
| 3 | Skill, `docs/gamecraft/`, first authored world | an agent makes a playable world unattended | ✅ |
| 4 | Review agent loop | review feedback demonstrably improves a world | ✅ |

**Deletion comes first, in sub-project 1.** It is not a matter of taste: the moment
`readScenario` loads directories instead of files, `generate.ts` — which writes single
files — no longer compiles against it, and every authoring pass downstream of it goes
with it. Trying to keep both alive would mean maintaining two artifact formats through
the riskiest part of the work. The branch exists precisely so there need not be a
playable game at every commit.

## 1. Scenario format v2

A directory with fixed filenames, so a tool call maps to a known file and a diff is
readable.

```
.scenarios/the-drowned-abbey/
  scenario.json      seed, recipe, bounds, spawn, packs, provenance
  story.md           the premise expanded: beginning, middle, end, cast, places
  world/
    sites.json       claimed settlements and their people
    terraform.json   authored tile and elevation edits
    placements.json  containers, items, signs, barriers
  phases/
    1-the-quiet-vale.json
    2-after-the-flood.json
  scenes/
    the-messenger-arrives.json
  trees/
    thornwick-3.json
```

**`story.md` is prose, not schema.** It is the agent's brief to itself and what a human
reads to judge whether the story is worth playing. The machine-readable beats — flags,
objectives, requirements — live in the phase files where the engine runs them, and the
CLI keeps the two in step. Schematising the whole story into typed fields is a
plausible cause of the blandness this redesign is meant to fix.

## 2. Phases

`world/` is phase 1. Each later phase is a **diff** — `add`, `remove`, `replace` over
placements, NPCs, trees, triggers and terraform. The runtime composes the base plus
every entered phase, in order.

**A phase is derived, never stored.** A phase is entered when its `when` condition
holds; the flag lives in `GameState` and the composition is recomputed on load. So a
save remains flags and deltas, and correcting a phase file corrects existing saves —
the property full snapshots would have cost.

## 3. Scenes

The one genuinely new engine subsystem, and the main source of the immersion the
current worlds lack.

`Trigger` already gives condition → effects. A scene adds a new `DomainEffect`,
`PlayScene`, plus a player for it: an ordered list of steps, where a step may hold
several actions that run together. Actors walk tile-by-tile using the real pathfinder,
the camera can pan or follow, text appears as banner or card, and input is locked until
the scene ends. There is no branching inside a scene — branching is what triggers and
phases are for.

`ShowCard` is folded in as a scene step. Full-screen text stops being its own thing.

Detailed design in `2026-08-13-scenario-v2-and-scenes-design.md`.

## 4. World authority

The generator still decides where settlements can exist. The agent works with the map
it is dealt, in a deliberate order of preference:

1. **Reseed** — free, and only before anything is claimed. The agent is told to shop
   for a map that already suits the story.
2. **Claim** a surveyed candidate cell, name it, populate it.
3. **Terraform** — authored edits in `world/terraform.json`, applied at chunk build.

> **Superseded 2026-08-14.** The generator no longer decides where settlements exist: an
> authored world settles nothing, the survey reports which *ground* will hold a place, and
> `craft found` puts one there. The order of preference is otherwise unchanged, and the
> reason for the change is in "The pass after the first play" below.

Terraform has two layers:

- **Tile stamps** — paths, bridges, clearings, walls. These land on machinery that
  already exists: `core/gen/features/terraform.ts` already carves streets and
  connections for towns, and chunks are composed from `FeaturePatch`es.
- **Elevation brushes** — a region and a delta, applied to the elevation field in
  `sampleFieldBuffer` *before* banding. Because biome, shore and the procedural
  `rivers.ts` all read that field, lowering a valley makes a river plausible rather
  than stamping water tiles onto a hillside. **Deferred to a later pass**; sub-project 1
  ships tile stamps only.

The skill tells the agent that reseeding is cheapest and terraform is a debt — it grows
the scenario and makes the world look hand-mangled. The story wins if it has to.

## 5. The CLI

One binary, `npm run craft -- <verb>`. The line is: **anything that must agree with the
generated world goes through the CLI; prose the agent edits directly.**

The CLI computes, validates and writes. So a chest inside a wall is not a mistake that
gets detected later — it is a call that fails.

```
craft new <id> --premise "..."          craft phase add <id> --after 1 --name ...
craft reseed <id>                       craft scene new <id> --at <site>
craft survey <id> [--radius N]          craft trigger add <id> --when ... --scene ...
craft claim <id> --cell x,y --name ...  craft beat add <id> --phase N ...
craft terraform <id> --path|--bridge
craft place <id> --chest|--item|--sign  craft check <id>
craft npc add <id> --site S [--live]    craft playtest <id>
        [--like <other-npc>]            craft play <id> --headless
craft tree <id> --npc N --init          craft render <id> --at <site>
```

Two flags carry design weight:

- `--like <other-npc>` shares another NPC's dialogue tree, so a town can be populated
  without thirty written conversations.
- `--live` marks who may improvise at runtime. Never anyone the story depends on, and
  `craft check` enforces that.

## 6. Live mode

Improvisation becomes authored rather than residual. The scenario marks which NPCs may
improvise; the launcher toggle then means something specific — "these people" rather
than "anyone the author forgot". Story-critical NPCs are never marked, so a live world
cannot derail its own plot.

The standalone live procedural world (director + improvised dialogue, no scenario) is
unaffected and stays.

## 7. Validation and review

Two instruments, answering different questions.

- **`craft playtest`** — the existing walker and solver. Mechanically proves every beat
  and quest can be reached and closed, and reports exactly where it stuck. Fast,
  deterministic, no model.
- **`craft play --headless`** — a real session an agent drives command by command,
  seeing what a player sees. This is what catches an NPC referencing a document the
  player has no way to find, and what can judge whether a world is dull.

The generation loop terminates on `playtest` passing *and* the review agent's sign-off —
not on a model deciding it has finished.

## 8. Accumulated know-how

`docs/gamecraft/*.md`, one file per topic: pacing, scenes, side quests, common
failures. The skill points the agent at the directory. At the end of a run the agent
proposes additions as ordinary file edits, reviewed with `git diff` and kept or dropped
like any other change. No approval queue — it is markdown in git, versioned alongside
the code it describes.

## 9. The agent's workflow

Encoded in the skill:

1. Expand the premise into `story.md` — a page: beginning, middle, end, cast and what
   they want, what each place means.
2. Shop for a world: survey, reseed until the map suits the story.
3. Claim and name places. Terraform only where the story requires it.
4. Per beat, until every beat is implemented: place what the beat needs, write the
   conversations, author the scene, wire the trigger, `craft check`.
5. Phase pass: what the world looks like after each turning point.
6. Side-quest pass per phase, conditioned on earlier resolutions. Place what each needs
   or delete it.
7. `craft playtest` until clean.
8. Dispatch a review subagent to play it; address the feedback.
9. Propose additions to `docs/gamecraft/`.

## 10. Risks

- **Scenes versus the reducer.** The engine is a pure reducer with an Ink loop on top;
  scenes introduce time. A `Tick`-driven state machine keeps it pure — `Tick` is already
  in the command alphabet — but this is the part most likely to need rework.
- **Nothing here forces good writing.** It forces *coherent* writing. `docs/gamecraft/`
  and the review agent are the only pressure on quality, and both need real runs before
  they are worth anything.
- **The agent may over-terraform**, producing worlds that look hand-mangled and
  scenarios that are large. Mitigated by guidance rather than by a limit, since the
  story is allowed to win.
- **Elevation terraform is deferred**, so the first worlds cannot have authored rivers. *(Built
  on 2026-08-14; see "The pass after the first play".)*
  Accepted.

---

## What it took that the design did not say

Recorded because each was a decision made against the spec rather than within it.

**The fixture is a typed builder, not committed JSON.** A committed blob cannot be
type-checked; the builder is verified against the artifact's own types at compile time and the
tests exercise the write-read round trip. `test/fixtures/two-phase.ts`.

**`ScenePoint` is its own union, not `PlacementSite`.** A placement's site spelling resolves
*inside* a building — its purpose, since stories hide things in chests — and a cutscene happens
in the square. Sharing the spelling sent the rider to the well and landed him in somebody's
pantry.

**Scenes needed their own clock.** `Tick` is an action counter driving the hour, the weather and
every NPC's schedule, so a three-second cutscene run off it would burn an hour of daylight.
`SceneFrame` is new. (`Tick` also turned out to be dead code.)

**Two things were already there.** `ChunkManager.invalidateRect` existed for late settlement
specs, so phase terraform was not new machinery; and `findPath` is a deterministic A*, which is
what let a scene be staged once and then advanced by a pure function.

**`--phase` rather than a second vocabulary.** Every mutating CLI verb takes the flag and routes
into a chapter's diff. There is no `craft phase place`.

**Improvisation became opt-in per person.** The spec said the scenario marks who may improvise;
implementing it meant inverting the runtime rule, because "anyone the author did not write a
conversation for" made a model the default for everybody not yet reached — so a half-written town
was full of people inventing facts about a story nobody had told them.

## The pass after the first play (2026-08-14)

The world was played and five things came back. Two were bugs, one was a lie the map told,
and two were the design being wrong rather than the code.

**A refused terminal write killed the game and the terminal with it.** Node reports a failed
asynchronous write by destroying the stream, and a destroyed stream with nobody listening
emits the error globally — so one `EIO` became an uncaught exception, and the handler meant to
restore the screen wrote through the very stream that had just been destroyed. Nothing took
stdin out of raw mode either. `restoreTerminal` writes the escapes to the file descriptor with
`writeSync` and drops raw mode first; every exit path now goes through one `leave()`.

**The cutscene was over before it registered.** Three faults at once: the pan lived in the
renderer, so the scene treated aiming the camera as instantaneous and ran on regardless — and
the view memoised the interpolation on a target that by definition does not change during a
pan, so the camera moved one tile and stopped. `fast` walking covered two tiles a frame,
twenty-two tiles a second. And the scene itself was written with `"hold": 3` throughout, which
reads as three beats and is a quarter of a second. The pan is the machine's now and a step
waits for it; nobody covers more than a tile a frame; and `craft check` warns when a step
changes what is on screen and then moves straight on.

**The minimap drew no boundary**, so a finite world looked infinite — and because a chunk is
marked discovered when it is *built*, which runs a chunk ahead of the player, ground past the
wall counted as found and `macroSite` cheerfully reported settlements out there. The edge is
drawn before the discovered check, deliberately: a finite world's shape is not a spoiler, and
hiding the walls is what made the far side look reachable.

**Generation is land only now.** A seed scattered eight villages across a short world, a story
used two, and the rest were places with names, houses and nobody with anything to say.
`craft new` writes `LAND_ONLY` into the recipe and `claim` becomes `found`, which writes the
recipe entry and the spec together. The engine's default is untouched, so the launcher's
unwritten world — where there is no author to place anything — still settles itself.

**Elevation terraform is built**, so authored rivers are possible. It is a zone with an
`elevation` term, reversing a documented decision: the hazard it was excluded for is real, so
it is guarded rather than ignored. See the commit and `gamecraft/shopping-for-a-world.md`.

## The bugs the work found

Each was silent, and each is now covered by a test.

| Where | What |
|---|---|
| `WorldView` | Memoised the last chunk *object*, so the first tile read after a chapter relaid the ground came from the copy just thrown away |
| `reduce` | `DismissCard` was swallowed during a scene, so a card raised by a scene's own `Card` step could never be put down |
| `save-repo` | A playing scene would have been persisted, which resumes a half-applied cutscene |
| `listScenarioDirs` | Counted the `.working` authoring record as a scenario |
| `two-phase.test.ts` | Wrote into the repository's own `.scenarios/`, because `writeScenario` goes to the configured root and nothing had redirected it |
| `craft play` | Fabricated a `DialogueTurn` to answer a choice; that command *commits* a turn, so every reply in the game came back as "nothing more to say" |
| `craft play` | Routed straight through people, then stopped dead at them; and reported the route's length rather than the distance walked |
| `craft story` | A condition reader returned on its first match, leaving later flags unread — and an unread flag is refused as unknown |
| `craft new` | Stubbed the world's era with a placeholder, which `openingCard` puts on the first screen of the game |
| `main.tsx` | A failed stdout write was fatal by default, and the crash handler's own writes went through the stream that had just been destroyed |
| `app.tsx` | A scene's camera pan was memoised on its target, which does not change during a pan — so every pan moved one tile and stopped |
| `scene.ts` | A step containing a pan finished immediately, so a rider could arrive and speak over a camera still travelling |
| `minimap-data.ts` | Drew settlements past the world's edge as places to go, because chunks are discovered when built and `macroSite` knows nothing about bounds |
| `survey.ts` | The growth loop widened the boundary hunting for settlements a land-only world cannot have, taking every scenario to its largest size |
| `validate.ts` | The radius rule was written twice, so the generator and its own validator could disagree about how close two places may be |
