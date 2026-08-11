# Generation integrity, the working view, and picking a premise

Date: 2026-08-11
Branch context: `place-solver`

Three changes to how a world is written, designed together because they meet on one
screen — the one a player watches while a world is being written, and the one that tells
them what came out. They are independent to build.

- **A. The working view, always on.** The prompt-by-prompt transcript exists and is
  complete; it is gated behind an opt-in that defaults to off, and the debug log it was
  meant to sit beside never reaches the screen at all.
- **B. Picking a premise.** With no premise, the lore pass invents one silently four
  minutes in. Offer several premise/title/tone bundles before anything is paid for.
- **C. Generation integrity.** The placement solver knows when it has failed and nobody
  asks; the repair pass deletes story to make faults go away; and the two checks that
  would prove a world playable are CLI-only. Result: a player can be handed a world whose
  main story cannot be finished.

C is much the largest. A is self-contained and makes C's failures readable while C is
being built, so A lands first. C depends on B only for the reseed's "keep the bundle"
behaviour, and can be built against a brief that happens to carry no title.

---

## Part A — the working view, always on

### What is there now

- `src/ai/transcript.ts` records every model exchange: system prompt, prompt, answer or
  error, attempt number, tokens, cost. Capped at `TRANSCRIPT_LIMIT = 400`, dropping from
  the head.
- `src/ai/client.ts:91` `keep()` is called on every attempt of both `structured()` and
  `streamed()`, success and failure. These are the only two functions in the codebase that
  talk to a model, so the recording has no per-model or per-pass hole.
- `src/ui/launcher/generate-progress.tsx:158` — `D` opens a transcript reader during
  generation.
- `src/ui/app.tsx:94` — an in-game "working" tab, gated on `debugAi()`.

### Why it reads as missing

1. It is opt-in and defaults to off: the `Keep the working` row on the generate page
   (`generate-config.tsx:145`, `useState(false)`) or `DEBUG_AI=1`.
2. The detailed **logs** are not in the view at all. `logger` only appends to a file
   (`src/utils/log.ts:39`) because the TUI owns stdout, so debug lines exist only in
   `log.txt`. `setDebugAi` lowered the file's log level, which is not the same as showing
   anything.
3. Nothing survives the process. The transcript is in-memory, cleared per run, never
   persisted — so "the last world came out wrong, why?" only works if you never quit.
4. The in-game tab is absent for any world this process did not just generate.
5. A model-dependent eviction: with `escalateTo` and `DEFAULT_RETRIES = 2`, a flaky model
   produces up to 3 exchanges per call. A `long` world is ~120 calls, so >400 exchanges is
   easy, and `transcript.ts:127` drops from the **head** — evicting the shape, lore and
   region passes, which are the most interesting ones. (Inferred from the code, not
   reproduced.)

### Design

**Ungate.** `recordExchange` loses its `enabled` guard. Removed entirely: `setDebugAi`,
`debugAi()`, `CONFIG.debugAi`/`DEBUG_AI`, `GenerateRequest.debug`, and the
`Keep the working` row on the generate page. `clearTranscript` stays — a new run must not
open on the previous world's prompts.

**Split the log into two sinks.** `src/utils/log.ts` gains a bounded in-memory ring that
captures at **debug level always**; the *file* keeps obeying `LOG_LEVEL` (default `info`).
This is what `setDebugAi` was really for, without turning the file's level down globally
and without `log.txt` growing on every ordinary run.

- `LOG_RING_LIMIT = 2000` lines, dropping from the head.
- `logRing(): readonly LogLine[]` and `onLog(listener)`, mirroring `transcript()` /
  `onTranscript` so the UI subscribes to both the same way.
- `emit()` pushes to the ring unconditionally and writes to the file only above threshold.
- `setLogLevel` stays (it is still how `LOG_LEVEL=debug` works for the file).

**Size the transcript by duration.** `sizeTranscript(duration)` called once at the start of
a run: `tiny` 200, `short` 400, `medium` 800, `long` 1600. At roughly 8KB an exchange that
is ~13MB at the top end, held only while generating.

**Persist the working.** Both streams append to `.scenarios/.working/<id>.jsonl`, one JSON
object per line with a `kind: "exchange" | "log"` discriminator, appended as they land so a
run that dies badly still leaves a record. `listScenarios` reads only root-level `*.json`
(`repo.ts:100-101`), so this can never be mistaken for content.

Written for **every** run, including one whose artifact is discarded — it is diagnostics,
not a world. This is deliberately different from Part C's rule about not persisting a
broken artifact: the log of a failed run is exactly the log worth keeping.

On load, a scenario with a working file seeds the transcript from it, so the in-game tab is
useful for a world you did not just generate.

**UI.** `D` always works and is always advertised in the footer. Inside the transcript
screen, `L` toggles a log pane showing the ring, filtered to the window around the selected
exchange where that is meaningful and the tail otherwise. The in-game working tab is always
present.

### Testing

- `recordExchange` records with no setup (the current test asserts the opposite and must
  be inverted).
- The log ring captures a `logger.debug` line while the file threshold is `info`, and the
  file does not receive it.
- `sizeTranscript` bounds eviction at the configured size, still dropping from the head.
- A working file round-trips: written during a run, read back into a transcript on load.
- `listScenarios` ignores `.scenarios/.working/`.

---

## Part B — picking a premise

### What is there now

An empty premise reaches the **lore pass**, which invents `premise` as a field of the
world's lore (`schemas.ts:132`, `author.ts:799`) along with the title and tone. The player
finds out what their world is about after it has been paid for.

The premise also determines the filename and therefore the seed:
`freeScenarioId(premise)` → `resolveSeed(id)` (`generate.ts:131-134`). So the premise must
be settled before anything is surveyed — which makes a pre-generation picker natural.

### Design

**One call, four bundles.** New `src/ai/author/pitch.ts`:

```ts
suggestPitches(input: {
  duration: Duration;
  hint?: string;          // whatever the player has typed so far
  count?: number;         // default 4
  signal?: AbortSignal;
}): Promise<readonly Pitch[]>
```

`Pitch` is `{ title, tone, premise }`. One `structured` call on the **prose** model — the
player reads every word of these — with a new `CallKind: "pitch"` for telemetry and
pricing. New `PitchesSchema` in `schemas.ts`: `title` ≤ 60 chars, `tone` ≤ 24, `premise`
capped at 400 to match `LoreSchema.premise`, described as two to four sentences.

Failure returns an empty array; the page then says the suggestion could not be written and
leaves the player typing. Nothing about this is load-bearing.

**The brief carries it.** `ScenarioBrief` (`core/world/brief.ts`) gains `title?` and
`tone?`; `normalizeBrief` trims and drops empties like it does for `premise`.

**The page.** `ENTER` on the Premise row opens a three-way chooser: *type it myself* /
*suggest some for me* / *let the model choose*. "Suggest" shows a spinner during the call,
then the bundles as a list — title and tone on the row, premise as the body — with `ENTER`
to take one, `M` for another four, `ESC` back to typing.

This is the one place a model call happens inside the launcher's Ink app, which
`pick-launch.tsx:102-104` deliberately avoids. Justified because it is a single short call
rather than minutes, and abortable on `ESC`. A comment says so where the rule is bent.

**Binding is enforced, not requested.** The lore prompt is told to keep the given title and
tone, *and* `author.ts` overwrites `lore.title` and `lore.tone` from the brief after the
call. Asking a model to preserve a field and then trusting it is how the field gets
quietly rewritten. The lore pass still invents everything else — history, factions,
regions.

**The title names the file.** `freeScenarioId` prefers `brief.title` and falls back to
`brief.premise`, so `.scenarios` reads like a shelf of books rather than a list of
pitches. No title means today's behaviour exactly.

### Testing

- `suggestPitches` returns bundles from a stubbed `structured`, and an empty array when it
  returns `undefined`.
- `normalizeBrief` keeps a title and tone, and drops whitespace-only ones.
- `freeScenarioId` prefers the title, falls back to the premise, and still de-duplicates.
- The lore result's title and tone equal the brief's when the brief has them, whatever the
  model returned.
- The picker page renders its list and reports the chosen bundle, with the call injected.

---

## Part C — generation integrity

### What is there now, and what is wrong with it

**The solver's failure signal is dead data.** `assignPlots` returns `unplaced` — the ids of
required structures no plot could satisfy (`plots.ts:76-90`). `buildSettlement` destructures
`assignments` and `blocked` and never reads it (`settlement.ts:305-313`). It is not logged,
surfaced or counted anywhere in `src/`.

**The failure is all-or-nothing.** When the backtracking search cannot place every required
building it reports *all* of them unplaced and clears the assignment map
(`plots.ts:252-265`), so a town that could not fit one required building gets filler for
all of them — precisely the substitution `plots.ts` was written to prevent.

**Capacity is estimated, not measured.** The roster the model is asked for is capped by
`buildingBudget` (`context.ts:56-66`), a closed-form function of `site.radius`
(`area/110`, clamped 2..14) that never runs the plot pass. Real plots come from a BSP over
a `radius * 1.56` square, keeping only leaves ≥5×5 that are *fully* on buildable ground and
clear of the plaza (`settlement.ts:206-260`). On a coastal, steep or river-cut site the
real count is far below what the model was told. `pruneUnreachable` can demolish more after
that.

**Nothing is spaced.** There is no minimum distance between neighbouring sites
(`macro.ts:131-148`): one site per macro cell, centre jittered to within `MACRO * 0.22`
≈ 14 tiles of the cell edge. Two adjacent centres can be ~28 tiles apart while a town
already reaches 35, so footprints can already overlap and nothing reports it.

**Repairs delete story.** `repairUntilClean` (`repair.ts:91`, ≤2 rounds, each kept only if
it lowers a score weighting errors 10×) drops objectives, errands, forks and conditions
from any beat, main line included. The list's own header states the omission: *"Notably
absent: trimming a roster that asked for more buildings than fit"* — the site is never
resized, so the quests are trimmed to fit the town instead.

**The proof of playability is CLI-only.** `walkTheStory` — the one check that plays the
story in the real engine and reports `stuck`, `absent`, `unfinished` — is explicitly not on
the generation path (`walk.ts:24`) and lives only in `src/tools/validate.ts`. Same for
`checkInvariants` (`checkStructuresBuilt`, `checkBuildingsReachable`), reachable only from
`src/tools/invariants.ts`.

**Nothing ever fails.** `generateScenario` reports findings and never gates
(`generate.ts:30-37`). An error-level finding still starts the world.

**A buildingless town passes site selection.** `buildsSomething` (`survey.ts:121`) accepts
any patch with an anchor, and `buildSettlement` always emits `square` + `well`, so a town
with no buildings gets named, populated and given story beats.

### C1. Solver honesty

`assignPlots` gains a greedy fallback: when the complete search fails, place required
requests most-constrained-first, taking the best plot that satisfies each one's relations
and isolation, skipping any that cannot be placed. `unplaced` then names only what
genuinely did not fit. The all-or-nothing branch and its `chosen.clear()` go away.

`FeaturePatch` (`features/patch.ts`) gains `unplaced: readonly string[]` — the structure
ids, using the same `ids` array `settlement.ts:279-290` already derives — and
`buildSettlement` sets it from the solution. Every consumer of a patch can then see it.

### C2. Measured capacity

Extract the footprint / BSP / plot-filter block out of `buildSettlement` into a shared
`sitePlots(world, site): readonly Rect[]` in `features/settlement.ts`, and have
`buildSettlement` call it. The extraction — not a reimplementation — is the point: a
capacity function that can disagree with the builder is worse than the estimate it
replaces, because it would be believed.

`buildingBudget(world, site)` becomes `min(formula, sitePlots(world, site).length)`, with
the clamp raised from 14 to 24 to suit the larger radii below. It now needs a `world`,
which its one caller (`siteContext`, `context.ts:109`) already has.

This is the fix at source rather than a report after the fact: the budget reaches the model
as a hard instruction — `"Give exactly ${context.buildingBudget} structures"`
(`director/prompt.ts:181`) — so a measured capacity stops the roster over-asking in the
first place. Note the knock-on: `peopleWanted` is derived from the budget
(`prompt.ts:141-142`), so a site with fewer real plots is now also asked for fewer people,
and the larger radii of C3 mean more of both.

### C3. Bigger sites, and growth within reason

**Baselines rise.** `DEFAULT_RADIUS` (`recipe.ts:441`):

| kind | now | proposed | max @ importance 5 |
|---|---|---|---|
| town | 20 / 3 | 28 / 4 | 48 |
| village | 14 / 2 | 20 / 3 | 35 |
| castle | 18 / 2 | 24 / 3 | 39 |
| fort | 13 / 1 | 18 / 2 | 28 |
| docks | 12 / 1 | 16 / 2 | 26 |
| ruins | 10 / 1 | 14 / 2 | 24 |
| hamlet | 9 / 1 | 13 / 2 | 23 |
| camp | 6 | 9 | 9 |
| cave | 6 | 9 | 9 |
| landmark | 4 | 6 | 6 |

Well under the hard ceiling of `HALO * MACRO = 128` that `validate.ts:274` asserts. A town
goes from 2025 to 3721 patch tiles, roughly doubling its plots. Supporting evidence: the
one generated scenario with a model-authored recipe already chose `town: 26, village: 20,
hamlet: 12` — the model reaches for more room when allowed to.

**Existing artifacts are pinned.** `an-interesting-spin-on-the.json`, `green-chapel.json`
and `thornwick-road.json` carry no `sites.radius` and so inherit the defaults; two of them
have live tests asserting exact positions. Each gets an explicit `sites.radius` holding
today's numbers, so their worlds are unchanged and no test is re-baselined. They already
pin `places`; this makes the rest of the pinning explicit.

**Growth at survey time.** In `survey.ts`, for each settlement site: if
`sitePlots().length` is short of the target, grow the radius in +3 steps until capacity
suffices or a ceiling is reached.

The **target** differs by stage, because at survey time no roster has been written yet:

- At survey time it is the unclamped `buildingBudget` formula — what we are about to tell
  the model it may ask for. Growing to meet it is how the promise in the prompt becomes
  true.
- At repair time (C4) it is the *authored* roster's required structures for that site,
  which is a smaller and more specific number.

The **ceiling** is `min(next size up on the ladder, 1.5 × the site's computed radius)`,
where "computed radius" is `base + perImportance × importance` — the same shape as
`growthCeiling` (`survey.ts:281-287`) and for the same reason: a hamlet that has to reach
village size has stopped being the thing it was. The ladder is `hamlet → village → town`,
those being the three kinds that differ only in size. Every other kind — `fort`, `castle`,
`docks`, `ruins`, `camp`, `cave`, `landmark` — has no next size up and so is capped at
1.5× alone. (`isSettlement` is `hamlet | village | town | fort`, so the ladder is
deliberately *not* that predicate: a fort is a settlement but not a bigger village.)

Two hard constraints override the ceiling in the restrictive direction:

1. The grown footprint must stay well inside the boundary band (`isWellInside`, and the
   existing "would be clipped by the band" check).
2. It must keep a ≥4-tile gap from every neighbouring site's footprint. This is new and
   also closes the pre-existing overlap hole; it applies to *growth only*, so existing
   overlaps are reported rather than retrospectively forbidden.

Growth is recorded on the survey and emitted as recipe `places` entries — `{ at, kind,
importance, radius }` for the grown cell — so it persists on the artifact
(`ScenarioArtifact.recipe`), reaches `macroSite` through `authored.radius ?? …`
(`macro.ts:86`), is folded into the halo by `maxFeatureRadius` (`macro.ts:206`), and
survives save and reload. Growing a *rolled* site therefore means pinning it: the places
entry names its current position and kind, which is what `macroSite` already does for
authored places.

**Buildingless sites are dropped.** `buildsSomething` is tightened to require at least one
building for kinds the settlement builder claims, rather than accepting the `square` and
`well` every settlement emits. This is the `todo.txt` item about Wodedesert and Wain Keep.
A site that cannot reach one plot even at its ceiling is dropped from the survey, so
nothing downstream names it, peoples it or hangs a beat on it.

### C4. Repair policy: the main line is sacred

`mainLine(artifact): ReadonlySet<string>` — the ids of non-optional beats — added to
`repair.ts`. Every dropping repair takes it:

- `dropObjectivesNothingCanTick`, `dropErrandsForThingsThatDoNotExist`,
  `forgetPeopleWhoAreNotHere`: skip main-line beats and emit an error-severity finding
  instead of deleting. Optional beats keep today's behaviour exactly.
- `dropOneArmedForks` is unchanged: a lone arm is not a choice, and dropping the branch
  leaves the beat exactly as it plays.

New repair `growSitesForTheStory`, ordered **before** the droppers: given a main-line
fault naming a site whose required structure went unplaced (now visible via C1's
`unplaced`) or whose named building was not built, grow that site's radius on the
artifact's recipe and re-stamp. Bounded by the same ceiling and the same two hard
constraints as C3.

Re-layout is safe for the cast: `NpcSpec.placement` is an anchor *kind* and
`structureName` is a name, both resolved at runtime, so a changed layout re-places people
rather than orphaning them.

One consequence to watch in implementation: forbidding a drop leaves its finding standing,
and `repairUntilClean` throws away a round whose score did not improve — including the good
repairs in it. So `growSitesForTheStory` has to be able to improve the score on its own,
and the round-scoring needs a test that a grow-only round is kept.

### C5. Structural gate, inside the loop

`inspect()` (`repair.ts:118`) gains:

- `checkStructuresBuilt` and `checkBuildingsReachable`, moved from tool-only reach.
- New `checkKeyPlacements`: every main-line beat's NPC resolves to somebody the world
  places, and every main-line `have` objective resolves to something the world contains.
  This is the "after item/NPC placement, make sure all the key ones are placed" check.

  It asks the item half through the *same* resolver `dropErrandsForThingsThatDoNotExist`
  uses — `surroundingsFor` plus `resolveObjectiveTarget` — rather than a second route, so
  the check and the repair cannot disagree about whether a thing exists. That matters more
  than usual here: under C4 the repair is now forbidden from deleting the objective, so its
  answer and this check's answer are the same fact reported to two audiences.

These generate settlement patches, and so does `checkPlaces`. Patch generation is shared
across the round rather than repeated per check — three independent `invalidateFeature` +
`generateSettlement` sweeps per round would triple the most expensive thing in the
pipeline and could disagree about what was built.

Scope discipline from `invariants.ts:15-45` still holds: measure what nothing else
measures, or share a question already asked. Nothing here re-asks a `validate.ts` question
by a second route.

### C6. The playability gate

After the repair loop, in `generateScenario`: run `walkTheStory`. It **fails** on any of

- a main-line beat in `stuck`,
- `finished === false`,
- a main-line beat's NPC in `absent`,
- a main-line objective in `unfinished`.

Concessions on main-line beats are reported, not failures — a walker that cannot guess
which conversation hands over a ring is a limit of the walker.

On failure, its findings feed exactly **one** more grow+repair round, then it walks again.
Optional-beat failures never gate; they are reported on the review screen.

### C7. Write only on acceptance, and reseed

`generateScenario` stops writing unconditionally (`generate.ts:191`). Instead:

- **Gate passed** → write, review screen, play. Today's flow.
- **Gate failed** → write nothing. Return the artifact and a gate report in the outcome.

`generateAndLaunch` becomes a loop over attempts. On failure it shows an unplayable screen
listing the gate errors, with:

- `R` — discard this artifact and start attempt *n+1*. Same premise, title, tone, length,
  model and packs; **id unchanged**; seed salted as `resolveSeed(`${id}#${attempt}`)` for
  attempt > 1. No cap: each attempt is an explicit keypress and the estimated cost is on
  the screen before it is spent.
- `P` — write it, then play it. The only path by which a world that failed the gate reaches
  the disk, and it is the player's decision.
- `ESC` — abandon. Nothing is written.

Because the id no longer determines the seed after a reseed, the "same name always names
the same country" property (`generate.ts:132`) no longer holds for reseeded worlds. A kept
world is still exactly reproducible — `artifact.seed` is authoritative and is what a save
records — so what is lost is only guessing a seed from a filename. Stated in a comment
where the salt is applied.

The working file from Part A is written for the discarded attempt too, so a failure can be
diagnosed after the fact even though its artifact is gone.

### Testing

Everything below runs offline with no key.

- **`sitePlots` agrees with the builder.** The load-bearing test: for a spread of seeds and
  site kinds, every rect `sitePlots` returns is a plot `buildSettlement` actually used, and
  the counts match. If these drift, capacity lies and the rest of C rests on it.
- **Solver partial failure.** A context where one of three required requests cannot fit
  places the other two and reports exactly one id in `unplaced`.
- **`unplaced` reaches the patch.** `buildSettlement` surfaces it rather than dropping it.
- **Growth.** Stops at the kind ceiling; refuses to cross the boundary band; refuses to
  come within 4 tiles of a neighbour; stops as soon as capacity suffices.
- **Buildingless site.** A fixture where the ground yields no plots is dropped by
  `buildsSomething` — the test the current `buildsSomething` cannot fail.
- **Repair policy.** A main-line objective survives a repair round that would have dropped
  it, and the finding is present with `error` severity; the equivalent optional objective
  is still dropped.
- **Grow-only round is kept.** `repairUntilClean` does not discard a round whose only
  change was growing a site.
- **`checkKeyPlacements`.** An artifact whose main-line NPC names an unbuilt building is
  reported; one whose optional-beat NPC does is not.
- **The gate.** A deliberately-broken fixture fails and writes nothing; a good one passes
  and writes. `walkTheStory` already has coverage to build on.
- **Reseed.** Attempt 2 keeps the id and the brief and produces a different seed.

### Risks

1. **The `sitePlots` extraction** is the highest-risk change in the set. Mitigated by
   `buildSettlement` calling the extracted function rather than a parallel copy, and by the
   agreement test above.
2. **Bigger radii churn the golden tests.** `golden.test.ts`, `coherence.test.ts` and
   `seam.test.ts` will all change. Expected and accepted; pinning the four existing
   artifacts keeps the *scenario* tests still.
3. **Generation gets slower.** ~1.8× the tiles per settlement patch (cached per site, so
   once each), plus seconds for the walk, plus possibly one extra repair round which
   generates the bounded world twice. Worst case roughly +30s on a medium world.
4. **Clearance refuses growth in dense regions**, which is correct but means some sites
   keep a short roster and report it rather than being fixed.
5. **Forbidding drops can strand a round.** Covered by the grow-only-round test, but the
   interaction between the new findings and `score()` is the subtlest part of C4 and
   deserves attention during implementation rather than at review.

---

## Out of scope

- Reducing the site jitter (`inset = MACRO * 0.22`) to buy spacing for free. It would move
  every site in every existing world and break the two hand-authored scenarios' positions.
- Retrospectively forbidding overlaps that today's seeds already produce. Reported, not
  fixed.
- Any change to what the walker can do. Its concessions stay concessions.
- Persisting the transcript for a *live* (unbounded, non-scenario) world. Part A's
  persistence is keyed to a scenario id.
