# Game-Maker Architecture

**Status:** approved 2026-08-13. Umbrella design for the `game-maker` branch.

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

| # | Sub-project | Done when |
|---|---|---|
| 1 | The deletions above, then scenario format v2, phase composition, scene runtime | a hand-written scenario directory with a cutscene and two phases plays |
| 2 | The `craft` CLI — full vocabulary, `check`, `playtest`, `play --headless` | that same scenario can be built end to end by CLI alone |
| 3 | Skill, `docs/gamecraft/`, first authored world | an agent makes a playable world unattended |
| 4 | Review agent loop | review feedback demonstrably improves a world |

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
- **Elevation terraform is deferred**, so the first worlds cannot have authored rivers.
  Accepted.
