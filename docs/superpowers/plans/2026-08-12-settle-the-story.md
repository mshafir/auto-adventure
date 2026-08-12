# Track C, part 2: The Main Line Is Sacred, and the Walk Fixes What It Finds

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the story walk on the generation path, where it fixes each main-line beat where it stands instead of reporting a fault for somebody else to read — and stop the repair pass from deleting a step of the main story to make a finding go away.

**Architecture:** Five moves. A session that never writes a save, so the walk can run on the generation path without leaving worlds in the Continue list. `mainLineBeats`, shared with the outline that already computes it. The walking primitives lifted out of `walkTheStory` into a `StoryWalker` that two callers share. Site growth lifted out of the survey so one site can be grown on demand. Then `settleTheStory`, which walks the main line, applies the narrowest fix at whatever will not open, and restarts only when the ground itself had to change.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Vitest, Biome. No model calls: every line is offline and deterministic.

## Why this is part 2 of three

Part 1 (`2026-08-11-solver-honesty-and-room.md`, landed) is C1–C3: the solver reports what did not fit, capacity is measured rather than estimated, sites are bigger and the survey grows the ones that are short.

This plan is **C4 and C5**. Part 3 is C6 (side-quest fitting), C7 (the story-adjustment call) and C8 (write-only-on-acceptance and the reseed offer).

**What this plan deliberately does not do:** it does not gate generation on the walk, and it does not offer a reseed. `settleTheStory` runs, fixes, and *reports*; the artifact is written exactly as it is today. The gate is C8, and putting it here would mean shipping a pass that can refuse to save a world before there is anything to offer the player instead. So part 2 is shippable on its own: a generated world arrives with its main line walked and its placement faults fixed, and a world that cannot be settled says so in the working record instead of surfacing as a stuck player twenty minutes in.

## Global Constraints

- Node floor `>=18`; ESM with explicit `.js` specifiers on every relative import.
- `exactOptionalPropertyTypes` is on — spread optionals conditionally (`...(x ? { x } : {})`).
- **Generation stays pure in `(seed, recipe)`.** Growth here works the way the survey's does: by adding an authored place to the recipe and re-deriving. No `Date.now()` or `Math.random()` inside anything that decides what the world contains. A wall-clock budget is allowed to decide *when to stop trying*, and must never decide what the world is.
- The codebase's validator rule (`invariants.ts:15-45`): measure what nothing else measures, or share the question something already asks. **Never ask the same question by two routes.** This plan is mostly an application of that rule — the walker, the main-line predicate and the growth pass each currently exist once and are about to have a second caller.
- Verify with `npm run check`. Single file: `npx vitest run <path>`.
- Test names finish the sentence "it …". Never write a test that cannot fail.

## What already exists (verified — do not re-derive)

- `walkTheStory(artifact, worldId?)` in `src/scenario/walk.ts:71` returns `WalkReport { opened, stuck, concessions, finished, absent, unfinished }`. It is ~250 lines, of which about 150 are movement primitives closed over `engine`: `readCards`, `face`, `step`, `leaveRoom`, `goTo`, `buildingsOf`, `enterBuilding`, `findIndoors`, `talkTo`, plus `roomOf` and `satisfy`. Each carries a comment recording a bug it exists to prevent. **Do not rewrite any of them.**
- `walk.test.ts` plays `thornwick-road` and `green-chapel` to their endings and asserts `absent`, `stuck`, `unfinished` all empty and `finished` true, with a 120s timeout. This is the safety net for the extraction in Task 3.
- `buildSession(choice, options)` (`src/session.ts:79`) constructs `new SaveRepository(options.saveDebounceMs ?? 2000)`. `SessionOptions` (`session.ts:51`) has exactly one field, `saveDebounceMs`.
- `SaveRepository.dispose()` (`save-repo.ts:186`) calls `flush()`, which writes. So `walkTheStory` writes a save under `walk-<id>` today, and `listSaves` (`save-repo.ts:72`) has no filter — it would appear in the Continue list. `walk.test.ts` and `tools/validate.ts` both work around this by pointing `AUTO_ADVENTURE_HOME` at a temp directory.
- `beat.optional` exists on `ScenarioBeat` (`arc.ts:75`). `arcOutline` (`arc.ts:419`) already computes `const mainLine = beats.filter((beat) => !beat.optional && !isBarredBranch(state, beat))`. `isBarredBranch` (`arc.ts:461`) is **private**.
- `repairUntilClean` (`repair.ts:92`) loops `MAX_ROUNDS = 2`, calls `repairArtifact`, re-`inspect`s, and throws the round away when `score(after) >= score(before)`. `score` is 10 per error, 1 per warning.
- `REPAIRS` (`repair.ts:170`) is nine functions in a fixed order. Their `Ground` (`repair.ts:62`) is `{ grid, sites, built }`, built by `survey()` (`repair.ts:185`), where `grid` is `buildPassability(artifact)` — a generation of the whole bounded world — and `built(siteId)` invalidates and regenerates one feature, memoised.
- **Only two of the four spatial repairs need `ground.grid`.** `standTheCastSomewhereReal` and `hideThingsWhereThereIsSomewhereToHideThem` use `ground.built` and `ground.sites` only; `spellObjectivesAsTheWorldDoes` and `dropErrandsForThingsThatDoNotExist` reach the grid through `surroundingsFor(..., terrainAt)`. This is what makes the fix tiers cheap.
- `artifactWorld(artifact)` is `worldSeed(artifact.seed, artifact.recipe)` (`artifact.ts:169`). So adding a place to `artifact.recipe.places` is the whole of growing a site in a written world.
- The feature cache is keyed `${worldKey(world)}:${kind.id}:${siteId}` (`registry.ts:116`) and `worldKey` is `${seed}:${rules.key}` where `rules.key` is a hash of the recipe as written (`recipe.ts:674`). **A grown recipe is therefore a different cache namespace, so growth needs no explicit invalidation** — the spec's fix-tier table says "invalidate that site's feature and overlapping chunks", and that turns out to be free. Chunks live on the session's `ChunkManager`, and growth restarts the walk with a new session.
- `growSites` in `src/scenario/survey.ts:240` is private, takes `(world, bounds, sites, neighbours)`, and grows every settlement short of `ambition(baselineRadius(...))`. Its helpers `baselineRadius`, `growthLimit`, `GROWTH_STEP`, `SIZE_LADDER` are private too. `overlapBy` and `GROWTH_CLEARANCE` are in `src/core/world/spacing.ts`.
- `authorScenario` (`author.ts`) runs: survey → lore/regions/sites/arc/dialogue → assemble `drafted` → signposts → **pass 6** `repairUntilClean(signed, say)` → **pass 7** `mendArtifact` (model rewrites, judged by `score`) → returns `{ artifact, calls, findings, repairs }`.

### Three findings that shape this plan

**1. The walker concedes items, so it cannot observe a mis-hidden one.** `satisfy` grants a `have` objective outright and records a concession (`walk.ts:372-382`), and `itemsRead` grants anything a beat's `opensOn` needs before visiting (`walk.ts:276-285`). A placement pointing at a building that was never built therefore never makes the walk fail. So `hideThingsWhereThereIsSomewhereToHideThem` cannot be a *reactive* fix tier the way the spec's table implies — a reactive-only design would leave that tier permanently unfired. It runs proactively instead, before the first beat, along with the other two artifact-only repairs. This is a deviation from the letter of C5's table and the reason is stated here rather than discovered later.

**2. A refused drop needs no new reporting channel — but it gets one anyway, and the difference matters.** When a dropping repair refuses to touch a main-line beat, the validator finding that motivated the repair simply persists, so the fault is already reported. What is *not* reported is that a repair deliberately declined, which reads identically to a repair that failed to notice. `RepairResult` gains `refused: readonly string[]` for that, surfaced as error findings by `repairUntilClean`.

**3. Collapsing the repair loop is what makes guarding drops safe.** Today a round whose score does not improve is discarded wholesale. A guard that deliberately leaves findings in place would make rounds look worse and get the *good* repairs in that round thrown away with the refusal. The single unjudged pass is not a tidy-up; it is a precondition.

---

## File Structure

**Created:**
- `src/scenario/walker.ts` — the movement and conversation primitives, lifted verbatim out of `walkTheStory` and closed over a session. One responsibility: knowing how a player does things. Its own file because two callers need it and because the knowledge in its comments is the most expensive knowledge in the repository.
- `src/scenario/walker.test.ts` — the primitives, exercised directly rather than only through a whole walk.
- `src/core/world/growth.ts` — growing one site. In `core/world` because both callers (`scenario/survey.ts`, `scenario/settle.ts`) sit above it and neither may depend on the other.
- `src/core/world/growth.test.ts`
- `src/scenario/settle.ts` — `settleTheStory`.
- `src/scenario/settle.test.ts`

**Modified:**
- `src/persist/save-repo.ts` — a repository that never writes.
- `src/session.ts` — `SessionOptions.persist`.
- `src/core/rules/arc.ts` — export `mainLineBeats`, and have `arcOutline` use it.
- `src/scenario/walk.ts` — use the walker; behaviour unchanged.
- `src/scenario/repair.ts` — `refused`, the main-line guard, the single pass, and the spatial repairs exported for the walk.
- `src/scenario/survey.ts` — use `core/world/growth.ts`.
- `src/ai/author/author.ts` — run `settleTheStory`, report it.
- `src/tools/validate.ts` — the ephemeral session.
- Existing tests: `src/scenario/walk.test.ts`, `src/scenario/repair.test.ts`, `src/core/rules/arc.test.ts`, `src/scenario/survey.test.ts`.

---

### Task 1: A session that leaves nothing behind

**Files:**
- Modify: `src/persist/save-repo.ts:139-190`
- Modify: `src/session.ts:51-80`
- Modify: `src/scenario/walk.ts:86-89`
- Modify: `src/tools/validate.ts:60-70`
- Test: `src/persist/persist.test.ts`, `src/scenario/walk.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `new SaveRepository(debounceMs, { persist: false })` never writes; `buildSession(choice, { persist: false })` passes it through. Task 5 builds every session this way.

- [ ] **Step 1: Write the failing test**

In `src/persist/persist.test.ts`:

```ts
	it("writes nothing at all when it was told not to persist", () => {
		// The opt-out has to live inside the repository rather than in a rule about not
		// calling dispose(), because dispose() flushes — so "remember not to dispose" is a
		// leak waiting for the first caller who tidies up properly.
		const repo = new SaveRepository(0, { persist: false });
		repo.schedule(newState("ephemeral"));
		repo.flush();
		repo.dispose();
		expect(existsSync(savePath("ephemeral"))).toBe(false);
		expect(listSaves().map((entry) => entry.worldId)).not.toContain("ephemeral");
	});

	it("still writes when it was not", () => {
		const repo = new SaveRepository(0);
		repo.schedule(newState("kept"));
		repo.flush();
		expect(existsSync(savePath("kept"))).toBe(true);
	});
```

Both go inside the existing `describe("SaveRepository")`. `newState(id)` is the file's own fixture (`persist.test.ts:29`); `existsSync`, `savePath`, `listSaves` and `SaveRepository` are already imported, and the `beforeEach`/`afterEach` pointing `AUTO_ADVENTURE_HOME` at a temp directory are at the top of the file.

And in `src/scenario/walk.test.ts`, the claim that matters on the generation path:

```ts
	it("leaves no world behind for the launcher to offer", async () => {
		// The walk used to write a save under `walk-<id>`, and `listSaves` has no filter — so
		// a checked scenario appeared in Continue as a half-played world nobody started. That
		// was tolerable while this was a tool and is not once generation walks every story.
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		expect(artifact).toBeDefined();
		if (!artifact) return;

		await walkTheStory(artifact, "walk-test-ephemeral");
		expect(listSaves().map((entry) => entry.worldId)).not.toContain("walk-test-ephemeral");
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/persist/persist.test.ts
npx vitest run src/scenario/walk.test.ts -t "leaves no world behind"
```

Expected: the first fails to compile (`SaveRepository` takes one argument); the second fails because the save is written.

- [ ] **Step 3: Make the repository able to hold its tongue**

In `src/persist/save-repo.ts`, on the class:

```ts
export interface SaveOptions {
	/**
	 * Whether to write anything at all.
	 *
	 * Off for a session built to ask a question rather than to be played: the story walk,
	 * the validator, the settling pass. It lives here rather than in a rule about not
	 * calling `dispose` because `dispose` *flushes* — so a caller who tidied up correctly
	 * would leave a world behind, and `listSaves` has no filter to hide it from the
	 * Continue list.
	 */
	readonly persist?: boolean;
}

export class SaveRepository {
	private dirty = false;
	private timer: NodeJS.Timeout | undefined;
	private latest: GameState | undefined;
	private readonly persist: boolean;

	constructor(
		private readonly debounceMs = 2000,
		options: SaveOptions = {},
	) {
		this.persist = options.persist ?? true;
	}
```

`schedule` returns early rather than `flush`, so nothing is ever held pending:

```ts
	schedule(state: GameState): void {
		if (!this.persist) return;
		this.latest = state;
		…
	}
```

Leave `flush` as it is: with nothing scheduled it has nothing to write, and a second guard inside it would be a second answer to the same question.

In `src/session.ts`:

```ts
export interface SessionOptions {
	readonly saveDebounceMs?: number;
	/**
	 * Whether this session may write a save. Default yes.
	 *
	 * A session built to answer a question — walking a story, validating a scenario,
	 * settling one — must not leave a world in the launcher's Continue list.
	 */
	readonly persist?: boolean;
}
```

and

```ts
	const saves = new SaveRepository(options.saveDebounceMs ?? 2000, {
		...(options.persist === false ? { persist: false } : {}),
	});
```

In `src/scenario/walk.ts`, the session:

```ts
	const session = buildSession(
		{ worldId, seed: artifact.seed, flavour: "prebuilt", scenario: artifact },
		{ saveDebounceMs: 0, persist: false },
	);
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/persist/persist.test.ts src/scenario/walk.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Update the two stale comments the fix invalidates**

`walk.test.ts:24-26` and `tools/validate.ts:64` both say the temp home is "somewhere to put the saves a walk writes". Keep the temp home — a test that reads the real home is a test that depends on the machine it runs on — and say what it is now for:

```ts
	// A home of its own, so nothing here can read or write the player's real saves. The
	// walk itself no longer writes one (`persist: false`), and the test above pins that;
	// this is the belt to that braces.
```

Also pass `persist: false` where `tools/validate.ts` builds its own session, if it builds one; if it only calls `walkTheStory`, note that in the commit rather than inventing a change.

- [ ] **Step 6: Commit**

```bash
git add src/persist/save-repo.ts src/session.ts src/scenario/walk.ts src/persist/persist.test.ts src/scenario/walk.test.ts src/tools/validate.ts
git commit -m "Let a session answer a question without leaving a world behind

Walking a story built a session, and dispose() flushes, so every walk wrote a save
under walk-<id>. listSaves has no filter, so it would have appeared in Continue as
a half-played world nobody started. Tolerable while walking was a tool somebody
ran by hand; not once generation walks every story it writes.

The opt-out is inside the repository rather than a rule about not calling dispose,
because dispose is exactly what a caller who tidies up properly calls.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The main line, named once

**Files:**
- Modify: `src/core/rules/arc.ts:419-461`
- Test: `src/core/rules/arc.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `mainLineBeats(arc: ScenarioArc, state?: GameState): readonly ScenarioBeat[]` — beats in `orderedBeats` order, with optional ones dropped and, when `state` is given, arms of a fork that went the other way dropped too. Tasks 4 and 5 use it; `arcOutline` uses it with state.

- [ ] **Step 1: Write the failing test**

In `src/core/rules/arc.test.ts`:

```ts
describe("mainLineBeats", () => {
	it("leaves out the side errands", () => {
		const story = arc([
			beat({ id: "a", order: 1 }),
			beat({ id: "side", order: 2, optional: true }),
			beat({ id: "b", order: 3 }),
		]);
		expect(mainLineBeats(story).map((entry) => entry.id)).toEqual(["a", "b"]);
	});

	it("keeps both arms of a fork until the story says which was taken", () => {
		// Without state there is no answer to "which arm" — and guessing would make the
		// repair pass treat one arm of every fork as deletable side content.
		const story = arc([
			beat({ id: "left", order: 1, branch: "which" }),
			beat({ id: "right", order: 2, branch: "which" }),
		]);
		expect(mainLineBeats(story).map((entry) => entry.id)).toEqual(["left", "right"]);
	});

	it("drops the arm the player did not take, once it knows", () => {
		const story = arc([
			beat({ id: "left", order: 1, branch: "which" }),
			beat({ id: "right", order: 2, branch: "which" }),
		]);
		expect(
			mainLineBeats(story, stateWith({ [branchKey("which")]: "left" })).map((entry) => entry.id),
		).toEqual(["left"]);
	});

	it("is what the outline counts, rather than a second opinion about it", () => {
		// The whole reason this is exported. `arcOutline` computed this set inline, and a
		// repair pass with its own idea of which beats are sacred would disagree with the
		// pane the player is reading. `remaining` is `mainLine.length - mainOpened.length`
		// (arc.ts:453), so on a state where nothing has opened it is the size of the set —
		// which is what makes this comparable at all.
		const story = arc([
			beat({ id: "a", order: 1 }),
			beat({ id: "side", order: 2, optional: true }),
		]);
		const state = stateWith({});
		expect(arcOutline(story, state)?.remaining).toBe(mainLineBeats(story, state).length);
	});
});
```

The fixtures are the file's own: `beat(overrides)` at `arc.test.ts:27`, `arc(beats)` at `:39`, `stateWith(flags)` at `:44`. `branchKey` and `arcOutline` are already imported there. Note the local name `story` for the arc, because `arc` is the fixture function.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/rules/arc.test.ts`

Expected: FAIL — `mainLineBeats` is not exported.

- [ ] **Step 3: Lift the predicate out of the outline**

In `src/core/rules/arc.ts`, above `arcOutline`:

```ts
/**
 * The beats the main story is actually made of.
 *
 * Two exclusions, and both are the difference between "3/3, and am I done?" and an answer.
 * Optional beats are side errands and were never part of the count. Arms of a fork the
 * player did not take can never open — `requirementsMet` bars them permanently — so
 * counting them would leave the story one step short of finished forever, which is the same
 * silent dead-end the outline exists to prevent.
 *
 * Exported because two other passes need the same set and must not each decide it for
 * themselves: the repair pass, which may not delete a beat that is in it, and the settling
 * walk, which walks exactly it. A repair working from its own idea of which beats are
 * sacred would disagree with the pane the player is reading.
 *
 * `state` is optional and the barred filter is what needs it. Without it both arms of a
 * fork are main line, which is the right answer for a caller reasoning about the artifact
 * rather than about a playthrough — and the conservative one, since the alternative is a
 * pass that treats an arm as deletable because it could not tell.
 */
export function mainLineBeats(arc: ScenarioArc, state?: GameState): readonly ScenarioBeat[] {
	return orderedBeats(arc).filter(
		(beat) => !beat.optional && !(state && isBarredBranch(state, beat)),
	);
}
```

Then in `arcOutline`, replace the inline filter with a call, keeping the surrounding lines exactly as they are:

```ts
	const mainLine = mainLineBeats(arc, state);
```

Move `isBarredBranch` above `mainLineBeats` if the file's ordering requires it; it stays private.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/rules && npm run typecheck`

Expected: PASS, and every existing `arcOutline` test unchanged — the set is the same set.

- [ ] **Step 5: Commit**

```bash
git add src/core/rules/arc.ts src/core/rules/arc.test.ts
git commit -m "Name the main line once, where two more passes can ask for it

arcOutline computed the set of beats that count — not optional, not the arm of a
fork that went the other way — inline. The repair pass is about to need it, to
refuse to delete anything in it, and the settling walk is about to walk exactly
it. Three spellings of "which beats are sacred" would drift, and the drift would
be a repair deleting a step the pane still counts.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The walker, lifted out where two callers can share it

The riskiest task, and the one with the best safety net. `walk.test.ts` plays both shipped scenarios to their endings; if it still passes, the extraction is faithful. **This is a pure refactor: no behaviour changes, no new fields, no reordering of engine commands.**

**Files:**
- Create: `src/scenario/walker.ts`
- Create: `src/scenario/walker.test.ts`
- Modify: `src/scenario/walk.ts`

**Interfaces:**
- Consumes: `persist: false` (Task 1).
- Produces:

```ts
export interface StoryWalker {
	readonly readCards: () => void;
	readonly goTo: (site: MacroSite) => void;
	readonly buildingsOf: (siteId: number, structureName?: string) => BuildingPlacement[];
	readonly findIndoors: (id: string, siteId: number, structure?: string) => Person | undefined;
	readonly talkTo: (
		id: string,
		indoors?: { readonly siteId: number; readonly structure?: string },
	) => Promise<boolean>;
	readonly roomOf: (
		siteId: number,
		slot: number,
	) => { readonly siteId: number; readonly structure?: string } | undefined;
	/** Ids the walk asked for and the engine had nowhere to put. */
	readonly absent: ReadonlySet<string>;
}

export function storyWalker(
	artifact: ScenarioArtifact,
	engine: GameEngine,
	sites: ReadonlyMap<number, MacroSite>,
): StoryWalker;
```

Task 5 calls `storyWalker`. `Person` is whatever `engine.personById` returns — read its type rather than inventing one; if it is not exported under a usable name, type `talkTo`'s internals locally and keep `findIndoors`'s return as `ReturnType<GameEngine["personById"]>`.

- [ ] **Step 1: Move the primitives, unchanged**

Create `src/scenario/walker.ts` containing, **copied verbatim including every comment**: `readCards`, `face`, `step`, `leaveRoom`, `goTo`, `buildingsOf`, `enterBuilding`, `findIndoors`, `talkTo`, and `roomOf`. `face` and `step`, `leaveRoom` and `enterBuilding` stay private to the module — only the six fields above are returned.

The module's own doc comment:

```ts
/**
 * How a player does things, for a harness that is not one.
 *
 * Lifted out of `walkTheStory` when a second caller appeared. Every function here carries a
 * comment recording a bug it exists to prevent — a door opened with the wrong key, a room
 * with no way out, a card nobody read, a teleport that left the player believing they were
 * still indoors — and every one of those was found by a real walk failing in a way that
 * looked like the scenario's fault. That is the whole argument for this file existing
 * rather than the primitives being written twice: the second copy would relearn them.
 *
 * `absent` is collected here rather than returned per call because it is the same fact for
 * every caller: somebody the story names and the engine put nowhere.
 */
```

Then in `walk.ts`, delete those definitions and destructure the walker:

```ts
	const walker = storyWalker(artifact, engine, sites);
	const { readCards, goTo, talkTo, roomOf } = walker;
```

`satisfy` stays in `walk.ts` — it is the *walker as a player of errands*, which is `walkTheStory`'s policy and not a primitive. It closes over `sites`, `artifact`, `apply` and `concessions`; leave it exactly where it is. `absent` becomes `walker.absent`, so the report line becomes `absent: [...walker.absent]`.

- [ ] **Step 2: Run the safety net**

```bash
npx vitest run src/scenario/walk.test.ts
```

Expected: PASS, both scenarios, unchanged. **If either fails, the extraction changed behaviour — find what moved rather than adjusting the test.** The likely culprits: a primitive that closed over `state()` now closing over a stale value, or `absent` no longer being populated because `talkTo` writes to a different set than the report reads.

- [ ] **Step 3: Write the tests the primitives never had**

Create `src/scenario/walker.test.ts`. These are the properties whose absence cost the bugs the comments describe, asserted directly rather than only through a whole story:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSession } from "../session.js";
import { readScenarioFile, scenarioPath } from "./repo.js";
import { siteIndex } from "./validate.js";
import { storyWalker } from "./walker.js";

/**
 * The primitives, on their own.
 *
 * `walk.test.ts` asserts that two shipped stories reach their endings, which is the claim
 * worth having and a poor way to find out *which* primitive broke: every one of them fails
 * as "a beat never opened". These are the two properties that were learned the hard way.
 */

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-walker-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

function walkerFor(name: string) {
	const artifact = readScenarioFile(scenarioPath(name));
	if (!artifact) throw new Error(`${name} did not load`);
	const session = buildSession(
		{ worldId: `walker-${name}`, seed: artifact.seed, flavour: "prebuilt", scenario: artifact },
		{ saveDebounceMs: 0, persist: false },
	);
	session.engine.dispatch({ t: "DismissCard" });
	return { artifact, session, walker: storyWalker(artifact, session.engine, siteIndex(artifact)) };
}

describe("the story walker", { timeout: 60_000 }, () => {
	it("stands the player in the town it was sent to, out of doors", () => {
		// The failure this pins is silent and total: indoors the player's coordinates are
		// interior-local and the reducer asks which place they are in about the doorstep they
		// came in by, so a walker that teleports without leaving is reported as standing in
		// the last town it was inside, forever.
		const { artifact, session, walker } = walkerFor("thornwick-road");
		const sites = [...siteIndex(artifact).values()];
		const first = sites.find((site) => artifact.sites[String(site.id)]);
		expect(first).toBeDefined();
		if (!first) return;

		walker.goTo(first);
		expect(session.state).toBeDefined();
		expect(session.engine.getState().player.inside).toBeUndefined();
		expect(
			Math.hypot(
				session.engine.getState().player.x - first.site.x,
				session.engine.getState().player.y - first.site.y,
			),
		).toBeLessThan(2);
		session.dispose();
	});

	it("finds somebody the scenario put in a room, by going in and looking", async () => {
		// An indoor character resolves only while the player stands in their building, so a
		// walker that never opens a door reports every one of them as missing.
		const { artifact, session, walker } = walkerFor("green-chapel");
		const indoors = Object.values(artifact.sites).flatMap((spec) =>
			spec.npcs.filter((npc) => npc.indoors).map((npc) => ({ spec, npc })),
		);
		const wanted = indoors[0];
		expect(wanted, "green-chapel has nobody indoors, so this test proves nothing").toBeDefined();
		if (!wanted) return;

		const site = siteIndex(artifact).get(wanted.spec.siteId);
		expect(site).toBeDefined();
		if (!site) return;
		walker.goTo(site);
		const spoke = await walker.talkTo(
			`npc:${wanted.spec.siteId >>> 0}:${wanted.npc.slot}`,
			walker.roomOf(wanted.spec.siteId, wanted.npc.slot),
		);
		expect(spoke, `${wanted.npc.name} could not be found indoors`).toBe(true);
		expect(walker.absent.has(`npc:${wanted.spec.siteId >>> 0}:${wanted.npc.slot}`)).toBe(false);
		session.dispose();
	});
});
```

Both tests pick their subject out of the artifact rather than hard-coding an id, and both assert the subject exists before asserting anything about it — a fixture that silently found nobody would make either of them unfailable.

- [ ] **Step 4: Run everything**

```bash
npx vitest run src/scenario/walker.test.ts src/scenario/walk.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scenario/walker.ts src/scenario/walker.test.ts src/scenario/walk.ts
git commit -m "Lift the walking out of the walk, for the second caller

Every primitive in here carries a comment recording a bug it exists to prevent: a
door opened with the wrong key, a room with no way out, a card nobody read, a
teleport that left the player believing they were still indoors. Each was found by
a real walk failing in a way that looked like the scenario's fault. That is the
argument for one copy rather than two — the second copy would relearn all of it.

A pure move: walk.test.ts plays both shipped scenarios to their endings unchanged,
which is what says so. What is new is two tests on the primitives themselves,
because every one of them fails through a whole walk as "a beat never opened".

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Growing one site, on demand

**Files:**
- Create: `src/core/world/growth.ts`
- Create: `src/core/world/growth.test.ts`
- Modify: `src/scenario/survey.ts:200-310`
- Test: `src/scenario/survey.test.ts` (unchanged assertions must still pass)

**Interfaces:**
- Consumes: `sitePlots`, `ambition`, `overlapBy`, `GROWTH_CLEARANCE` (all landed in part 1).
- Produces:

```ts
export interface GrowthRequest {
	readonly world: WorldSeed;
	readonly site: MacroSite;
	readonly bounds: WorldBounds;
	/** Everything a grown footprint could run into, the site itself included or not. */
	readonly neighbours: readonly MacroSite[];
	/** How many plots the site has to end up with. */
	readonly wanted: number;
}

/** The recipe entry that makes this site big enough, or nothing if it cannot be. */
export function growSite(request: GrowthRequest): PlaceRecipe | undefined;

/** How many plots a site of this kind and importance is worth asking for. */
export function rosterTarget(world: WorldSeed, site: MacroSite): number;
```

Task 5 calls `growSite` with `wanted` derived from `unplaced`; `survey.ts` calls it with `wanted = rosterTarget(...)`.

- [ ] **Step 1: Write the failing test**

Create `src/core/world/growth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sitePlots } from "../gen/features/settlement.js";
import { hashString } from "../rand/hash.js";
import { growSite, rosterTarget } from "./growth.js";
import { isSettlement, macroSite } from "./macro.js";
import { worldSeed } from "./recipe.js";
import { overlapBy } from "./spacing.js";

/**
 * Making a site big enough for what it will be asked to hold.
 *
 * The survey grows every settlement that is short before a token is spent; the settling
 * walk grows one site when a required building turns out to have had nowhere to stand. Both
 * ask this, and they must not answer it separately: two growth rules would mean a world the
 * survey called big enough and the walk grew anyway, on the same seed.
 */

/** A rectangle large enough that the boundary is never the reason growth is refused. */
const ROOMY = { minX: -2048, minY: -2048, maxX: 2048, maxY: 2048, style: "cliffs" as const, thickness: 8 };

function settlementsOf(seedName: string, reach = 5) {
	const world = worldSeed(hashString(seedName));
	const sites = [];
	for (let my = -reach; my <= reach; my++) {
		for (let mx = -reach; mx <= reach; mx++) {
			const site = macroSite(world, mx, my);
			if (isSettlement(site.kind)) sites.push(site);
		}
	}
	return { world, sites };
}

describe("growing a site", () => {
	it("makes it hold what it was asked for, when the ground allows", () => {
		const { world, sites } = settlementsOf("grow-one");
		const short = sites.find((site) => sitePlots(world, site).length < rosterTarget(world, site));
		expect(short, "no site in this seed is short, so this test proves nothing").toBeDefined();
		if (!short) return;

		const grown = growSite({
			world,
			site: short,
			bounds: ROOMY,
			neighbours: sites,
			wanted: rosterTarget(world, short),
		});
		expect(grown).toBeDefined();
		expect(grown?.radius ?? 0).toBeGreaterThan(short.radius);
		expect(sitePlots(world, { ...short, radius: grown?.radius ?? short.radius }).length).toBeGreaterThan(
			sitePlots(world, short).length,
		);
	});

	it("refuses to grow into a neighbour", () => {
		// A grown site is pinned as an authored place, which is exactly what validate.ts
		// warns about overlapping a rolled one. A generator that produced worlds its own
		// checker complains about would be worse than one that never grew anything.
		const { world, sites } = settlementsOf("grow-one");
		for (const site of sites) {
			const grown = growSite({
				world,
				site,
				bounds: ROOMY,
				neighbours: sites,
				wanted: rosterTarget(world, site),
			});
			if (!grown) continue;
			for (const other of sites) {
				if (other.id === site.id) continue;
				expect(
					overlapBy({ at: site.site, radius: grown.radius ?? 0 }, { at: other.site, radius: other.radius }),
					`grew ${site.kind} ${site.id} into ${other.kind} ${other.id}`,
				).toBeLessThanOrEqual(0);
			}
		}
	});

	it("refuses to grow past the boundary band", () => {
		const { world, sites } = settlementsOf("grow-one");
		const site = sites[0];
		expect(site).toBeDefined();
		if (!site) return;
		// A rectangle whose edge is barely clear of the site as it stands: any growth at all
		// puts the footprint in the band.
		const tight = {
			minX: site.site.x - site.radius - 2,
			minY: site.site.y - site.radius - 2,
			maxX: site.site.x + site.radius + 2,
			maxY: site.site.y + site.radius + 2,
			style: "cliffs" as const,
			thickness: 8,
		};
		expect(
			growSite({ world, site, bounds: tight, neighbours: [site], wanted: 999 }),
		).toBeUndefined();
	});

	it("gives back nothing when it is already big enough", () => {
		const { world, sites } = settlementsOf("grow-one");
		const site = sites.find((entry) => sitePlots(world, entry).length > 0);
		expect(site).toBeDefined();
		if (!site) return;
		expect(growSite({ world, site, bounds: ROOMY, neighbours: sites, wanted: 1 })).toBeUndefined();
	});

	it("does not grow a place somebody chose the size of", () => {
		// The recipe is the one thing here with an opinion.
		const { world, sites } = settlementsOf("grow-one");
		const site = sites[0];
		expect(site).toBeDefined();
		if (!site) return;
		expect(
			growSite({
				world,
				site: { ...site, authored: true },
				bounds: ROOMY,
				neighbours: sites,
				wanted: 999,
			}),
		).toBeUndefined();
	});
});
```

`WorldBounds` is `{ minX, minY, maxX, maxY, style, thickness }` (`bounds.ts:29-43`), so `ROOMY` above is the right shape.

`"grow-one"` must be a seed whose sample genuinely contains a short site. Part 1 measured 70 of 80 settlements short across eight seeds, so almost any seed will do — but **run the first test and confirm the `expect(short).toBeDefined()` guard passes** rather than assuming, and if it does not, try another name and pin the one that works.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/world/growth.test.ts`

Expected: FAIL — `./growth.js` does not resolve.

- [ ] **Step 3: Move the growth rule out of the survey**

Create `src/core/world/growth.ts` holding, moved from `src/scenario/survey.ts`: `GROWTH_STEP`, `SIZE_LADDER`, `baselineRadius`, `growthLimit`, and the body of `growSites`'s per-site loop. Keep every comment — in particular the two that explain why the ceiling and the target are measured against the recipe's size and not the current one, which is the whole of why growing is idempotent.

```ts
/**
 * How many plots a site of this kind and importance is worth asking for.
 *
 * Measured at the size the *recipe* gives the kind, never at whatever size the site is now,
 * and both halves matter. At the recipe's size it is a fixed point, so surveying an
 * already-grown world asks for the same thing and stops — where a target read off the
 * current radius would rise every time the site grew and each pass would grow it again. And
 * it has to be the recipe's size rather than a constant because `ambition` goes as the
 * square of the radius while plots go roughly linearly with it: a target that moved with the
 * footprint would outrun the ground it was chasing.
 */
export function rosterTarget(world: WorldSeed, site: MacroSite): number {
	const kind = site.kind;
	if (kind === "none" || !isSettlement(kind)) return 0;
	return ambition({ ...site, radius: baselineRadius(world, site, kind) });
}

export function growSite(request: GrowthRequest): PlaceRecipe | undefined {
	const { world, site, bounds, neighbours, wanted } = request;
	const kind = site.kind;
	// `isSettlement` already excludes "none", but narrowing through it does not reach the
	// recipe's radius table, which is keyed by the kinds a place can actually be.
	if (kind === "none" || !isSettlement(kind)) return undefined;
	// An authored place is a size somebody chose. Growing it would be the generator
	// overruling the recipe, and the recipe is the one thing here with an opinion.
	if (site.authored) return undefined;
	if (sitePlots(world, site).length >= wanted) return undefined;

	const limit = growthLimit(world, site, kind);
	const clear = (radius: number): boolean =>
		neighbours.every(
			(other) =>
				other.id === site.id ||
				overlapBy({ at: site.site, radius }, { at: other.site, radius: other.radius }) <=
					GROWTH_CLEARANCE,
		);
	const fits = (radius: number): boolean =>
		[
			{ x: site.site.x - radius, y: site.site.y },
			{ x: site.site.x + radius, y: site.site.y },
			{ x: site.site.x, y: site.site.y - radius },
			{ x: site.site.x, y: site.site.y + radius },
		].every((point) => isWellInside(bounds, point.x, point.y));

	let chosen: number | undefined;
	for (let radius = site.radius + GROWTH_STEP; radius <= limit; radius += GROWTH_STEP) {
		// Both tests only get harder as the radius rises, so the first refusal is the last
		// word rather than something to try again beyond.
		if (!fits(radius) || !clear(radius)) break;
		chosen = radius;
		// The smallest size that holds the roster wins. Taking the ceiling regardless would
		// spend the map's spare ground on sites that did not need it.
		if (sitePlots(world, { ...site, radius }).length >= wanted) break;
	}
	if (chosen === undefined) return undefined;
	return { at: site.site, kind, importance: site.importance, radius: chosen };
}
```

Then in `src/scenario/survey.ts`, `growSites` becomes the loop and nothing else:

```ts
function growSites(
	world: WorldSeed,
	bounds: WorldBounds,
	sites: readonly MacroSite[],
	neighbours: readonly MacroSite[],
): { readonly places: readonly PlaceRecipe[]; readonly grown: Record<string, number> } {
	const places: PlaceRecipe[] = [];
	const grown: Record<string, number> = {};
	for (const site of sites) {
		const place = growSite({
			world,
			site,
			bounds,
			neighbours,
			wanted: rosterTarget(world, site),
		});
		if (!place || place.radius === undefined) continue;
		grown[String(site.id)] = place.radius;
		places.push(place);
	}
	return { places, grown };
}
```

Delete the now-unused imports from `survey.ts` (`ambition`, `sitePlots`, `overlapBy`, `GROWTH_CLEARANCE`, and the moved constants) — but check first: `survey.test.ts` imports `sitePlots` itself, and `buildsSomething` may still need others.

- [ ] **Step 4: Run everything**

```bash
npx vitest run src/core/world/growth.test.ts src/scenario/survey.test.ts
npm run check
```

Expected: PASS, with `survey.test.ts` **completely unchanged** — including its idempotence test. That test surveys twice and expects the second pass to grow nothing, and it is the one that proves the move preserved the fixed point. If it fails, `rosterTarget` is being measured against the wrong radius.

- [ ] **Step 5: Commit**

```bash
git add src/core/world/growth.ts src/core/world/growth.test.ts src/scenario/survey.ts
git commit -m "Move growing a site to where two passes can ask for it

The survey grows every settlement that is short before a token is spent. The
settling walk is about to grow one, when a required building turns out to have had
nowhere to stand. Two growth rules would mean a world the survey called big enough
and the walk grew anyway on the same seed, and the ceiling and target are subtle
enough — both measured against the recipe's size rather than the current one, which
is the whole of why growing is idempotent — that a second copy would get one of
them wrong.

survey.test.ts is untouched, idempotence test included, which is what says the move
preserved the fixed point.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `settleTheStory`

**Files:**
- Create: `src/scenario/settle.ts`
- Create: `src/scenario/settle.test.ts`
- Modify: `src/scenario/repair.ts` — export the three spatial repairs and their `Ground` builder.

**Interfaces:**
- Consumes: `mainLineBeats` (Task 2), `storyWalker` (Task 3), `growSite`/`rosterTarget` (Task 4), `persist: false` (Task 1).
- Produces:

```ts
export interface SettleReport {
	/** The artifact as it ended up, fixes and growth folded in. */
	readonly artifact: ScenarioArtifact;
	/** Main-line beats that opened, in the order they opened. */
	readonly opened: readonly string[];
	/** The beat the pass gave up on, if it gave up. */
	readonly stuck?: {
		readonly beat: string;
		readonly why: string;
		/** Every fix tried on it, in words, in the order they were tried. */
		readonly tried: readonly string[];
	};
	/** What was changed to get here, in words. */
	readonly fixes: readonly string[];
	/** Sites made bigger, id to new radius. */
	readonly grown: Readonly<Record<string, number>>;
	/** What had to be given rather than earned. Recorded, never gated on. */
	readonly concessions: readonly string[];
	/** True when every main-line beat opened. */
	readonly settled: boolean;
}

export async function settleTheStory(
	artifact: ScenarioArtifact,
	onProgress?: (message: string) => void,
): Promise<SettleReport>;
```

- [ ] **Step 1: Export what the fix tiers need from `repair.ts`**

Three of the four spatial repairs become the walk's artifact-only fix tiers. They stay in `repair.ts` — they are repairs — and gain exports:

```ts
export { standTheCastSomewhereReal, hideThingsWhereThereIsSomewhereToHideThem, spellObjectivesAsTheWorldDoes };
```

`Ground` and `survey` need exporting too, under a name that says what it is from outside:

```ts
export type { Ground as RepairGround };
export { survey as groundFor };
```

Add to `survey`'s doc comment the fact the settling pass depends on:

```ts
/**
 * …
 * `grid` is the expensive half — one generation of the whole bounded world — and only two of
 * the repairs need it (`spellObjectivesAsTheWorldDoes` and
 * `dropErrandsForThingsThatDoNotExist`, both through `surroundingsFor`). `built` is memoised
 * per site and hits the feature cache, so a caller that only moves people and hidden things
 * about pays nothing for the grid. `settle.ts` relies on that: it builds this lazily, on the
 * first beat that will not open.
 */
```

Make `grid` lazy so that claim is true rather than aspirational:

```ts
interface Ground {
	/** The bounded world's passability. Generated on first use: it is the expensive half. */
	readonly grid: PassabilityGrid;
	readonly sites: Map<number, MacroSite>;
	/** What the generator actually built at a site, or undefined where it built nothing. */
	readonly built: (siteId: number) => FeaturePatch | undefined;
}
```

The cheapest honest way to make it lazy without changing nine call sites is a getter on the returned object:

```ts
	let grid: PassabilityGrid | undefined;
	return {
		get grid() {
			grid ??= buildPassability(artifact);
			return grid;
		},
		sites,
		built: …,
	};
```

- [ ] **Step 2: Write the failing test**

Create `src/scenario/settle.test.ts`. The shipped scenarios are the honest subjects: they are known-good, so settling them must change nothing and must succeed — which is the property most likely to break, and the one that says the pass is not just rewriting worlds for the sake of it.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mainLineBeats } from "../core/rules/arc.js";
import { listSaves } from "../persist/save-repo.js";
import { readScenarioFile, scenarioPath } from "./repo.js";
import { settleTheStory } from "./settle.js";

/**
 * Making a story work, rather than reporting that it does not.
 *
 * The shipped scenarios are the subjects because they are known good: settling one must
 * succeed and must change nothing. A pass that "fixed" a working world would be rewriting
 * stories for the sake of having run, and that failure is silent — every test about faults
 * would still pass.
 */

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-settle-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("settleTheStory", { timeout: 180_000 }, () => {
	for (const name of ["thornwick-road", "green-chapel"]) {
		it(`settles ${name} without changing it`, async () => {
			const artifact = readScenarioFile(scenarioPath(name));
			expect(artifact, `${name} did not load`).toBeDefined();
			if (!artifact) return;

			const arc = artifact.arc;
			expect(arc, `${name} has no arc, so this test proves nothing`).toBeDefined();
			if (!arc) return;

			const report = await settleTheStory(artifact);
			expect(report.stuck, "a main-line beat could not be settled").toBeUndefined();
			expect(report.settled).toBe(true);
			expect(report.fixes, "a known-good world was rewritten").toEqual([]);
			expect(report.grown, "a known-good world was regrown").toEqual({});
			// Every main-line beat, and the count is taken from the arc rather than written
			// down, so an arc that gains a beat does not make this pass for the wrong reason.
			expect(report.opened.length).toBe(mainLineBeats(arc).length);
			expect(report.artifact).toBe(artifact);
		});
	}

	it("says a world with no story is settled, without building one", async () => {
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		if (!artifact) return;
		const { arc: _arc, ...storyless } = artifact;
		const report = await settleTheStory(storyless);
		expect(report.settled).toBe(true);
		expect(report.opened).toEqual([]);
	});

	it("leaves no world behind for the launcher to offer", async () => {
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		if (!artifact) return;
		await settleTheStory(artifact);
		expect(listSaves()).toEqual([]);
	});

	it("moves somebody standing in a building the ground never built, and carries on", async () => {
		// The fault the walk exists to catch, injected. An indoor NPC in a building nothing
		// here has leaves them nowhere at all — not somewhere else, nowhere — so the beat
		// they anchor is unreachable while every offline check passes.
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		if (!artifact) return;
		const arc = artifact.arc;
		if (!arc) return;
		const beat = mainLineBeats(arc)[0];
		expect(beat).toBeDefined();
		if (!beat) return;

		const spec = artifact.sites[String(beat.siteId)];
		expect(spec).toBeDefined();
		if (!spec) return;
		const broken = {
			...artifact,
			sites: {
				...artifact.sites,
				[String(beat.siteId)]: {
					...spec,
					npcs: spec.npcs.map((npc) =>
						npc.slot === beat.npcSlot
							? { ...npc, indoors: true, structureName: "The Nonexistent Counting House" }
							: npc,
					),
				},
			},
		};

		const report = await settleTheStory(broken);
		expect(report.fixes.length, "nothing was fixed").toBeGreaterThan(0);
		expect(report.settled, `still stuck: ${report.stuck?.why ?? ""}`).toBe(true);
		expect(report.artifact).not.toBe(broken);
	});
});
```

The last test is the one that can go wrong in an interesting way: `standTheCastSomewhereReal` may fix it *proactively*, before the walk starts, in which case `fixes` is non-empty and `opened` is complete — which is a pass. **If it turns out the walk never needed to react, say so in the commit rather than contriving a fault that only the reactive path can fix.** A world where the proactive pass catches everything is the world we want; the reactive path exists for what it misses.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/scenario/settle.test.ts`

Expected: FAIL — `./settle.js` does not resolve.

- [ ] **Step 4: Write `settleTheStory`**

Create `src/scenario/settle.ts`:

```ts
/**
 * Make the main line work, beat by beat, in the engine it will be played in.
 *
 * The pass that turns "this world validates" into "this story has been played". Everything
 * before it reasons *about* the artifact; this walks the main line in a real session — real
 * chunks, real settlement patches, real NPC placement, the real reducer settling after every
 * command — and where a beat will not open it fixes what it can and tries again.
 *
 * Forward, and fixing in place, rather than checking the whole world and starting over. Each
 * round of the static repair loop generates the bounded world twice (`repair.ts:71-76`); a
 * walk visits only the sites the story actually uses, and after a fix that does not touch the
 * map every untouched site's patch is still cached. So this is both stronger than the offline
 * checks and cheaper than the loop it stands beside.
 *
 * **The main line only.** Optional beats are fitted afterwards, under stricter rules, because
 * a side errand must never be the reason a site is regrown. And there is deliberately no
 * "drop it and carry on" branch here: a main-line beat that cannot be settled stops the pass
 * and is reported. Deleting a step of the main story to make a fault go away is the thing the
 * whole track exists to prevent.
 *
 * **Concessions are not failures.** A walker cannot search a crate it has no reason to look
 * in or work out which conversation hands over a ring, so where an objective can only be
 * satisfied by being given, it is given and recorded. Gating on that would be measuring the
 * walker rather than the world.
 */
```

The shape, with the three constants the spec fixes:

```ts
/** Fix attempts per beat, before the pass admits the beat is the problem. */
const MAX_FIXES_PER_BEAT = 3;

/**
 * How long the whole pass may take before it stops and says where it got to.
 *
 * A wall clock, which is the one place a clock is allowed near generation: it decides when
 * to stop *trying*, never what the world contains. A pass cut short reports the beat it was
 * on, and the artifact it hands back is the one it had already settled — which is a
 * deterministic function of the walk, whatever the clock did.
 */
const BUDGET_MS = 60_000;
```

The loop:

```ts
export async function settleTheStory(
	artifact: ScenarioArtifact,
	onProgress: (message: string) => void = () => undefined,
): Promise<SettleReport> {
	const started = Date.now();
	const arc = artifact.arc;
	if (!arc || arc.beats.length === 0)
		return {
			artifact,
			opened: [],
			fixes: [],
			grown: {},
			concessions: [],
			settled: true,
		};

	let current = artifact;
	const fixes: string[] = [];
	const grown: Record<string, number> = {};
	const concessions: string[] = [];
	// Growth is the only fix that restarts the walk, so it is the only one that needs a
	// budget of its own: the cap is the number of story sites, because a site is grown at
	// most once and there is nothing else to grow.
	const growthBudget = mainLineBeats(arc).length;
	let growths = 0;

	for (;;) {
		// Fix what can be known without walking, first. Three of the four spatial repairs
		// re-derive their own conditions, so on a world with nothing wrong they change
		// nothing — and one of them cannot be reached reactively at all, because the walker
		// grants items rather than finding them and so never trips over one hidden in a
		// building that was never built.
		const before = current;
		current = applySpatialFixes(current, fixes);
		if (current !== before) onProgress(`fixed ${fixes.length} placement fault(s) before walking`);

		const attempt = await walkMainLine(current, { onProgress, deadline: started + BUDGET_MS });
		concessions.push(...attempt.concessions);
		if (!attempt.stuck) {
			return {
				artifact: current,
				opened: attempt.opened,
				fixes,
				grown,
				concessions,
				settled: true,
			};
		}

		// The ground itself: a required structure that no plot could take. This is C1's
		// `unplaced`, which is why part 1 had to land first — before it, the only evidence
		// that the story's counting house had become a shack was the shack.
		const room =
			growths < growthBudget
				? makeRoomAt(current, attempt.stuck.siteId)
				: undefined;
		if (room) {
			growths++;
			grown[String(attempt.stuck.siteId)] = room.radius;
			current = room.artifact;
			fixes.push(room.said);
			onProgress(room.said);
			// From the first beat, not from this one. Replaying to beat N-1 costs exactly what
			// walking to it cost, so resuming saves nothing — and a fresh session is provably
			// right where splicing a regrown site under a live one works until it does not.
			continue;
		}

		return {
			artifact: current,
			opened: attempt.opened,
			stuck: { beat: attempt.stuck.beat, why: attempt.stuck.why, tried: attempt.stuck.tried },
			fixes,
			grown,
			concessions,
			settled: false,
		};
	}
}
```

The two helpers `settleTheStory` leans on. First the artifact-only fixes, which are the three repairs with a name that says why they are grouped:

```ts
/**
 * The fixes that change what the artifact *says* about where things are.
 *
 * Three repairs, run together because they answer one question — "is this thing somewhere
 * that exists" — and because none of them touches the map, so the walk carries on from
 * where it was rather than starting again. Each re-derives its own condition (`repair.ts`'s
 * first rule), so on a world with nothing wrong they change nothing and this is free.
 *
 * `Ground` is built once and handed to all three: `built` is memoised per site and hits the
 * feature cache the walk has already warmed, and `grid` is lazy, so the two that need it
 * pay for it only if the first one did not already fix the fault.
 */
function applySpatialFixes(artifact: ScenarioArtifact, fixes: string[]): ScenarioArtifact {
	const ground = groundFor(artifact);
	let current = artifact;
	for (const fix of [
		standTheCastSomewhereReal,
		hideThingsWhereThereIsSomewhereToHideThem,
		spellObjectivesAsTheWorldDoes,
	]) {
		const result = fix(current, ground);
		if (result.artifact === current) continue;
		current = result.artifact;
		fixes.push(...result.repairs);
	}
	return current;
}
```

If Task 6's decision is to keep `spellObjectivesAsTheWorldDoes` in the static list (the recommendation), drop it from that array and say so in the commit — the point is that it appears in exactly one of the two places.

Then the walk itself:

```ts
interface Attempt {
	readonly opened: readonly string[];
	readonly concessions: readonly string[];
	readonly stuck?: {
		readonly beat: string;
		readonly siteId: number;
		readonly why: string;
		readonly tried: readonly string[];
	};
}

async function walkMainLine(
	artifact: ScenarioArtifact,
	options: { readonly onProgress: (message: string) => void; readonly deadline: number },
): Promise<Attempt> {
	const arc = artifact.arc;
	if (!arc) return { opened: [], concessions: [] };

	const sites = siteIndex(artifact);
	const session = buildSession(
		{
			worldId: `settle-${artifact.id}`,
			seed: artifact.seed,
			flavour: "prebuilt",
			scenario: artifact,
		},
		{ saveDebounceMs: 0, persist: false },
	);
	const { engine } = session;
	engine.dispatch({ t: "DismissCard" });
	const walker = storyWalker(artifact, engine, sites);
	const state = () => engine.getState();

	const opened: string[] = [];
	const concessions: string[] = [];
	try {
		for (const beat of mainLineBeats(arc)) {
			const site = sites.get(beat.siteId);
			// A beat at a site the bounded world does not contain is not something a fix can
			// reach: the arc names somewhere that is not in this world at all.
			if (!site) {
				return {
					opened,
					concessions,
					stuck: {
						beat: beat.id,
						siteId: beat.siteId,
						why: `site ${beat.siteId} is not in this world`,
						tried: [],
					},
				};
			}

			// A beat gated on carrying something opens the moment the player has it, and
			// finding it is not something a walker can do. Granted before the visit, so the
			// scene plays as it would for a player who had already found it.
			for (const item of itemsRead(asCondition(beat.opensOn))) {
				if (state().inventory.some((entry) => entry.name === item)) continue;
				engine.dispatch({
					t: "ApplyEffects",
					effects: [
						{ t: "GrantItem", name: item, description: "Given, to settle the story.", quantity: 1 },
					],
				});
				concessions.push(`gave "${item}" so beat ${beat.id} could open`);
			}

			walker.goTo(site);
			if (!state().flags[beat.setsFlag]) {
				await walker.talkTo(beatNpcId(beat), walker.roomOf(beat.siteId, beat.npcSlot));
			}
			if (state().flags[beat.setsFlag]) {
				opened.push(beat.id);
				continue;
			}

			// It did not open. Whatever is wrong is wrong here, so stop and say so: the caller
			// decides whether a fix is available, because only it knows what it has already
			// tried and how much of its budget is left.
			return {
				opened,
				concessions,
				stuck: {
					beat: beat.id,
					siteId: beat.siteId,
					why: whyStuck(artifact, walker, beat, site),
					tried: [],
				},
			};
		}
		return { opened, concessions };
	} finally {
		// Runs on every path, including the early returns above. A session left undisposed
		// holds a debounce timer, and this pass may build several.
		session.dispose();
	}
}
```

The deadline is checked at the top of the beat loop — `if (Date.now() > options.deadline) return { opened, concessions, stuck: { …, why: "the settling budget ran out here" } }` — and that is the only reading of the clock in the pass. It decides when to stop trying and never what the world contains.

`tried` comes back empty from here and is filled in by the caller, which is the only place that knows what it attempted. Retrying is the caller's job too: `settleTheStory`'s loop re-applies `applySpatialFixes` and walks again, up to `MAX_FIXES_PER_BEAT` times for the same beat id, pushing each fix's words onto `tried`. **Stop retrying the moment `applySpatialFixes` returns the same artifact** — a fix that changed nothing will change nothing next time, and the attempt counter would otherwise burn three walks to learn it once.

`whyStuck` diagnoses from what the walk saw, cheapest first, each answer excluding the ones after it:

```ts
function whyStuck(
	artifact: ScenarioArtifact,
	walker: StoryWalker,
	beat: ScenarioBeat,
	site: MacroSite,
): string {
	if (walker.absent.has(beatNpcId(beat))) {
		return `${beatNpcId(beat)} opens it and the engine put them nowhere`;
	}
	// The only world sweep in the pass, and only on a beat that has already failed.
	const grid = buildPassability(artifact);
	if (!canReach(grid, reachableFrom(grid, artifact.spawn), site.site)) {
		return "there is no way to walk there from the start";
	}
	// Honest about whose limit this is. A walker cannot work out which conversation hands
	// over a ring, and reporting that as the world's fault would send somebody looking for a
	// fault that is not there.
	return `${beatNpcId(beat)} was standing there and the beat did not open`;
}
```

Check `reachableFrom`'s and `canReach`'s real signatures in `src/scenario/passability.ts` before writing this — `walkableSites` in `survey.ts:374-382` calls both and is the working example to copy.

`makeRoomAt(artifact, siteId)` is the growth tier:

```ts
/**
 * Give a site the room the story needed it to have.
 *
 * Asked only of a beat that would not open, and only where the ground is the reason: the
 * site's patch reports structures the roster required and no plot could take. That report is
 * `FeaturePatch.unplaced`, computed by the placement solver for years and read by nothing
 * until it was carried out of the builder — this is what it was for.
 *
 * Growth is written into the recipe rather than held aside, because `artifactWorld` is
 * `worldSeed(seed, recipe)` and the recipe is what a reload will read. That also makes
 * invalidation free: the feature cache is keyed on a hash of the recipe as written, so a
 * grown world is a different namespace and cannot serve a patch from the ungrown one.
 */
function makeRoomAt(
	artifact: ScenarioArtifact,
	siteId: number,
): { artifact: ScenarioArtifact; radius: number; said: string } | undefined
```

It resolves the site through `siteIndex(artifact)`, regenerates its patch to read `unplaced`, and calls

```ts
	growSite({
		world,
		site,
		bounds: artifact.bounds,
		neighbours: [...siteIndex(artifact).values()],
		// Enough plots for what the roster asked for and could not have. One structure needs
		// one plot, so this is arithmetic rather than a guess — and it is the *story's* target
		// rather than the survey's, which is why it is not `rosterTarget`: the survey grows a
		// site to hold the roster it will be offered, and this grows one to hold the buildings
		// the story has already been written against.
		wanted: sitePlots(world, site).length + patch.unplaced.length,
	})
```

and returns the artifact with the place appended to `recipe.places` — **appended, never merged**: `mergeRecipe` lets one recipe's `places` replace another's, and part 1 learned that the hard way when growth deleted green-chapel's two castles, its cave and its harbour.

If `unplaced` is empty, or `growSite` returns nothing, return `undefined` — there is no room to be made and the beat is a real failure.

- [ ] **Step 5: Run the tests**

```bash
npx vitest run src/scenario/settle.test.ts
npm run check
```

Expected: PASS. **Record how long settling each shipped scenario takes** — `npx vitest run src/scenario/settle.test.ts --reporter=verbose` prints per-test durations. That number is what Task 6 has to justify adding to every generation, and it belongs in the commit message rather than in a guess.

- [ ] **Step 6: Commit**

```bash
git add src/scenario/settle.ts src/scenario/settle.test.ts src/scenario/repair.ts
git commit -m "Walk the main line, and fix each beat where it stands

Everything before this reasons about the artifact. This plays it: a real session,
real chunks, real settlement patches, real NPC placement, the real reducer settling
after every command — and where a beat will not open it fixes what it can and tries
again. Forward and in place, rather than checking the whole world and starting over:
a repair round generates the bounded world twice, while a walk visits only the sites
the story uses and leaves every untouched patch cached.

Three of the four spatial repairs run before the first beat rather than reactively,
and one of them could not be reactive at all: the walker grants items rather than
finding them, so it never trips over a thing hidden in a building that was never
built. Reacting only would have left that tier permanently unfired.

Growth is the one fix that restarts, because it is the one that changes the map. It
reads FeaturePatch.unplaced — the solver's verdict, computed for years and read by
nothing until part 1 carried it out of the builder. This is what it was for.

There is no drop-it-and-carry-on branch. A main-line beat that cannot be settled
stops the pass and is reported, because deleting a step of the main story to make a
fault go away is the thing this whole track exists to prevent.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The main line is sacred, and the repair loop stops second-guessing itself

Last, and in one commit with the pipeline change, because the three changes here are only safe together: guarding drops leaves findings in place, which would make a judged round look worse and throw the good repairs out with the refusal; and moving the spatial repairs out of the static list is only safe once something else does them.

**Files:**
- Modify: `src/scenario/repair.ts:50-183`
- Modify: `src/ai/author/author.ts:558-604`
- Test: `src/scenario/repair.test.ts`

**Interfaces:**
- Consumes: `mainLineBeats` (Task 2), `settleTheStory` (Task 5).
- Produces: `RepairResult.refused: readonly string[]`; `repairUntilClean` runs one pass and returns `refused` folded into `findings` as errors; `REPAIRS` holds five functions.

- [ ] **Step 1: Write the failing tests**

In `src/scenario/repair.test.ts`:

```ts
	it("refuses to drop an objective from a beat the story needs", () => {
		// The rule the whole track rests on: a main-line beat is not deletable. An errand
		// waiting on a flag nothing sets is a real fault and dropping the objective is a real
		// fix — for a side errand. On the main line it is a step of the story removed to make
		// a finding go away, and the finding was the more useful of the two.
		const artifact = demoArtifact({
			arc: arcWith([
				beat({
					id: "spine",
					order: 1,
					setsFlag: "arc:spine",
					quest: {
						id: "q",
						name: "The Tally",
						description: "Settle it.",
						objectives: [
							{ kind: "flag", target: "nothing:writes:this", done: false },
							{ kind: "reach", target: "Aldermoor", done: false },
						],
					},
				}),
			]),
		});

		const result = repairArtifact(artifact);
		const objectives = result.artifact.arc?.beats[0]?.quest?.objectives ?? [];
		expect(objectives.map((objective) => objective.target)).toContain("nothing:writes:this");
		expect(result.refused.join(" ")).toContain("spine");
	});

	it("still drops it from a side errand", () => {
		const artifact = demoArtifact({
			arc: arcWith([
				beat({
					id: "errand",
					order: 1,
					optional: true,
					setsFlag: "arc:errand",
					quest: {
						id: "q",
						name: "A Favour",
						description: "If you like.",
						objectives: [
							{ kind: "flag", target: "nothing:writes:this", done: false },
							{ kind: "reach", target: "Aldermoor", done: false },
						],
					},
				}),
			]),
		});

		const result = repairArtifact(artifact);
		const objectives = result.artifact.arc?.beats[0]?.quest?.objectives ?? [];
		expect(objectives.map((objective) => objective.target)).not.toContain("nothing:writes:this");
		expect(result.refused).toEqual([]);
	});

	it("runs the repairs once, rather than judging a second round", () => {
		// The loop existed because static findings were the only available measure of
		// "better". The walk is that check now, and a far stronger one — and a judged round
		// would throw a deliberate refusal out along with every good repair beside it.
		const artifact = demoArtifact();
		const spy: string[] = [];
		repairUntilClean(artifact, (message) => spy.push(message));
		expect(spy.filter((line) => line.includes("made nothing better"))).toEqual([]);
	});
```

The fixtures are `demoArtifact` and `demoSiteSpec` from `test/fixtures/scenario.js`, plus the file's own `beat(id, order, rest)` at `repair.test.ts:62` and `difference(broken)` at `:45`, which returns `{ gone, added, fixed, repairs }` — the diff of the validator's messages either side of a repair. Use `beat(...)` and build the arc as `{ title, premise, beats }` the way the tests at `:166` and `:227` do; the `arcWith(...)` above is a sketch, not a name that exists. `difference` is the better tool for the first two tests if you want the finding as well as the artifact.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/scenario/repair.test.ts`

Expected: FAIL — `refused` is not on `RepairResult`, and the objective is dropped from the main-line beat.

- [ ] **Step 3: Guard the drops**

`RepairResult` gains the channel:

```ts
export interface RepairResult {
	readonly artifact: ScenarioArtifact;
	/** What was changed, in the words of the fault removed. Empty when nothing was. */
	readonly repairs: readonly string[];
	/**
	 * Faults a repair declined to fix because fixing meant deleting main-line story.
	 *
	 * Reported rather than merely skipped. The validator finding that motivated the repair
	 * persists either way, so the *fault* is already visible — what is not is that a repair
	 * looked at it and deliberately left it, which reads exactly like a repair that failed
	 * to notice.
	 */
	readonly refused: readonly string[];
}
```

Every one of the nine repairs returns `refused: []` unless it is one of the two guarded ones. The two guarded ones — `dropObjectivesNothingCanTick` and `dropErrandsForThingsThatDoNotExist` — take the main line and check the beat before filtering:

```ts
function dropObjectivesNothingCanTick(artifact: ScenarioArtifact): RepairResult {
	const arc = artifact.arc;
	if (!arc) return { artifact, repairs: [], refused: [] };
	const written = flagsWritten(artifact);
	// No state, so both arms of a fork count as main line. Deliberately the conservative
	// answer: the alternative is deleting an arm because this pass could not tell which one
	// the player will take.
	const sacred = new Set(mainLineBeats(arc).map((beat) => beat.id));
	const repairs: string[] = [];
	const refused: string[] = [];

	const beats = arc.beats.map((beat) => {
		if (!beat.quest) return beat;
		const dead = beat.quest.objectives.filter((objective) => !tickable(objective, written));
		if (dead.length === 0) return beat;
		if (dead.length === beat.quest.objectives.length) return beat;
		if (sacred.has(beat.id)) {
			for (const objective of dead) {
				refused.push(
					`"${beat.quest.name}" waits for "${objective.target}" and nothing sets it; beat ${beat.id} is on the main line, so it was left alone rather than shortened`,
				);
			}
			return beat;
		}
		for (const objective of dead) {
			repairs.push(
				`"${beat.quest.name}" waited for "${objective.target}" to be set and nothing sets it; dropped that objective`,
			);
		}
		return {
			...beat,
			quest: {
				...beat.quest,
				objectives: beat.quest.objectives.filter((objective) => tickable(objective, written)),
			},
		};
	});

	return beats.some((beat, index) => beat !== arc.beats[index])
		? { artifact: { ...artifact, arc: { ...arc, beats } }, repairs, refused }
		: { artifact, repairs: [], refused };
}
```

Two things to notice in that tail. The `repairs` wording is the existing message verbatim — a repair's message is what the working record shows, and rewording one that has not changed meaning makes a diff look like a behaviour change. And the return keeps `refused` even on the unchanged branch: a pass that refused everything changes nothing, and dropping the refusals there is exactly how the refusal would become invisible.

`dropErrandsForThingsThatDoNotExist` takes the same shape: build `missing` as it does today, return early where `objectives.length === beat.quest.objectives.length` or `=== 0`, then branch on `sacred.has(beat.id)` with

```ts
				refused.push(
					`"${beat.quest.name}" asks for "${objective.target}", which nothing here produces; beat ${beat.id} is on the main line, so the errand was left alone rather than shortened`,
				);
```

`dropOneArmedForks` stays unguarded and gains a note saying why:

```ts
 * Unguarded by the main line, unlike the other two dropping repairs, and for a reason
 * rather than an oversight: this removes the *branch*, not the beat. A lone arm is not a
 * choice, and dropping the group leaves the beat exactly as it plays.
```

`repairArtifact` collects both lists, and `repairUntilClean` becomes one pass:

```ts
/**
 * Repair once, then check.
 *
 * This used to loop twice and throw away any round whose findings did not improve, because
 * static findings were the only available measure of "better" and a repair with an
 * unforeseen consequence had to be caught somehow. `settleTheStory` is that check now, and a
 * far stronger one — it plays the story rather than reading it.
 *
 * Collapsing the loop is also what makes refusing a main-line drop safe. A round that
 * deliberately leaves findings in place scores worse than one that deleted the story to
 * clear them, so a judged round would have thrown the refusal out along with every good
 * repair standing beside it.
 */
export function repairUntilClean(
	artifact: ScenarioArtifact,
	onProgress: (message: string) => void = () => undefined,
): {
	artifact: ScenarioArtifact;
	findings: readonly Finding[];
	repairs: readonly string[];
	refused: readonly string[];
} {
	const attempt = repairArtifact(artifact);
	const findings = [
		...inspect(attempt.artifact),
		...attempt.refused.map((message) => ({ severity: "error" as const, message })),
	];
	if (attempt.repairs.length > 0) onProgress(`repaired ${attempt.repairs.length}, ${describe(findings)} left`);
	for (const message of attempt.refused) onProgress(message);
	return { artifact: attempt.artifact, findings, repairs: attempt.repairs, refused: attempt.refused };
}
```

`MAX_ROUNDS` and `score` lose their only caller here. **Do not delete `score`** — `author.ts` pass 7 judges the model mends with it. Delete `MAX_ROUNDS` and its comment.

Then take the three now-reactive repairs out of the static list, leaving:

```ts
/**
 * Repairs in the order they must run.
 *
 * What is *not* here any more: the three that answer "where is this thing", which
 * `settleTheStory` now applies with a live world in front of it. Running them in both
 * places would be two answers to one question, and the walk's answer is the better one
 * because it can tell whether the fix worked.
 *
 * `dropErrandsForThingsThatDoNotExist` stays, and its position still matters: an item it
 * would delete for not existing may simply have been written in the wrong words, and
 * respelling now happens before this list runs rather than inside it.
 */
const REPAIRS: readonly ((artifact: ScenarioArtifact, ground: Ground) => RepairResult)[] = [
	dropErrandsForThingsThatDoNotExist,
	dropObjectivesNothingCanTick,
	dropOneArmedForks,
	forgetPeopleWhoAreNotHere,
	gateTheCastOnTheirOwnScene,
	sayWhereToGoNext,
];
```

**The ordering comment above is now a lie unless respelling really does run first.** `settleTheStory`'s proactive pass runs `spellObjectivesAsTheWorldDoes`, and in `author.ts` it runs *after* `repairUntilClean`. Fix it by ordering the pipeline in Step 4 so settling comes first, or keep `spellObjectivesAsTheWorldDoes` in the static list as well and drop it from settle's proactive set. **Choose one and say which in the commit; do not leave both.** The recommendation: keep respelling in the static list — it is the one spatial repair that changes only words, it needs the grid either way, and `dropErrandsForThingsThatDoNotExist` depends on it having run.

- [ ] **Step 4: Settle, on the generation path**

In `src/ai/author/author.ts`, after pass 7 (the model mends) and before the closing report — the walk should see the artifact that will actually be written, and a mend that rewrites a conversation after the walk would make the walk's claim stale:

```ts
	// --- pass 8: play it ------------------------------------------------------
	// The only pass that makes a claim rather than an inspection: every beat of the main line
	// opened and closed in a real session. It fixes what it can as it goes — somebody standing
	// in a building that was never built, a thing hidden in a room that does not exist, a site
	// with no room for the buildings the story was written against — and where it cannot, it
	// says which beat and what it tried.
	//
	// Nothing is gated on it yet. Offering the player a reseed is the next piece of work, and
	// a pass that could refuse to save a world before there is anything to offer instead would
	// be a worse outcome than the fault it caught.
	say("playing the story through");
	const settled = await settleTheStory(artifact, say);
	artifact = settled.artifact;
	repairs.push(...settled.fixes);
	if (Object.keys(settled.grown).length > 0) {
		say(`made room in ${Object.keys(settled.grown).length} place(s) the story had outgrown`);
	}
	if (settled.settled) {
		say(`walked ${settled.opened.length} beat(s) of the main line to the end`);
	} else {
		say(
			`beat ${settled.stuck?.beat} could not be settled: ${settled.stuck?.why}` +
				(settled.stuck?.tried.length ? ` (tried ${settled.stuck.tried.join("; ")})` : ""),
		);
	}
	for (const concession of settled.concessions) say(`given: ${concession}`);
	// Re-checked, because settling may have changed the artifact — and a finding the fixes
	// removed should not still be reported at the end of the run.
	if (settled.artifact !== mechanical.artifact) findings = inspect(artifact);
```

`AuthorResult` does not change: `repairs` is already carried and already printed by `generate.ts:88`, so pushing settling's fixes into it is enough to surface them.

- [ ] **Step 5: Run everything**

```bash
npm run check
```

Expected: PASS. Two things checked in advance so they are not surprises:

- `repair.test.ts:372`, "hands back what it could not fix, and does not re-check it twice", sounds like it pins the loop and does not: it asserts that the findings returned are the repaired world's rather than the broken one's, which is as true of one pass as of two. It should pass untouched. If it fails, the single pass is returning findings from the wrong artifact.
- Any test asserting `repairUntilClean`'s whole result with `toEqual` will now need `refused`. Destructuring callers are unaffected.
- `AuthorResult` (`author.ts:177`) carries `findings` and `repairs`, both of which `generate.ts` reads (`:76`, `:88-89`). Settling's fixes are pushed into `repairs`, so they surface through the existing path with no new field. Leave `AuthorResult` alone.

- [ ] **Step 6: Commit**

```bash
git add src/scenario/repair.ts src/scenario/repair.test.ts src/ai/author/author.ts
git commit -m "Stop deleting the main story to make a finding go away

A dropping repair now asks whether the beat is on the main line, and for one that
is it reports instead of shortening it. An errand waiting on a flag nothing sets is
a real fault and dropping the objective is a real fix — for a side errand. On the
main line it is a step of the story removed to clear a finding, and the finding was
the more useful of the two.

The loop collapses to one unjudged pass, and that is a precondition rather than a
tidy-up: a round that deliberately leaves findings in place scores worse than one
that deleted the story to clear them, so the old judging would have thrown the
refusal out along with every good repair beside it. settleTheStory is the check now,
and it plays the story rather than reading it.

The three repairs that answer "where is this thing" move into the walk, which can
tell whether the fix worked. Respelling stays here, because
dropErrandsForThingsThatDoNotExist depends on having run after it.

Nothing is gated on the walk yet. The reseed offer is the next piece of work, and a
pass that could refuse to save a world before there is anything to offer instead
would be worse than the fault it caught.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (C4, C5).**

C4: `mainLine` → Task 2, as `mainLineBeats` in `arc.ts` rather than `repair.ts`, because `arcOutline` already computed the set and the rule against asking one question by two routes outranks the spec's suggested home. Guarded dropping repairs → Task 6. The four repairs that stay static → Task 6, except `spellObjectivesAsTheWorldDoes`, which the spec moves into the walk and this plan keeps static — reasoned in Task 6 Step 3 and flagged as a decision to state in the commit. Single unjudged pass → Task 6. The note that re-layout is safe for the cast because `placement` and `structureName` resolve at runtime is why the fix tiers are allowed to re-point people at all; it needs no code.

C5: `settleTheStory` over the main line → Task 5. Ephemeral session and the save-writing bug → Task 1. Fix tiers → Task 5, with the item tier proactive rather than reactive and the reason recorded (the walker concedes items, so it cannot observe that fault). Growth restarting from the first beat → Task 5. The three termination guards → Task 5. Concessions recorded, never gated → Task 5. Determinism → Task 5's `BUDGET_MS` comment, which is the only clock in the pass and decides when to stop trying rather than what the world is. What it reports → `SettleReport`. `invariants.ts` staying tool-only → nothing to do.

**Deferred to part 3, tracked here so nothing is lost:** C6 side-quest fitting, C7 the adjustment call, C8 write-on-acceptance and the reseed loop. This plan's `SettleReport` is the input C8 needs, which is why it carries `stuck.tried` rather than only a boolean.

**Type consistency.** `mainLineBeats(arc, state?)` is defined in Task 2 and called in Tasks 5 and 6 under that name. `storyWalker(artifact, engine, sites)` is defined in Task 3 and called in Task 5. `growSite(request)` and `rosterTarget(world, site)` are defined in Task 4 and called in Tasks 4 and 5. `RepairResult.refused` is added in Task 6 and every one of the nine repairs is updated there. `SessionOptions.persist` is added in Task 1 and used in Tasks 1, 3 and 5.

**Five things the implementer must not paper over:**

1. **Task 3 is a pure move.** `walk.test.ts` plays both shipped scenarios to their endings; if it fails, something in the extraction changed behaviour. Find what moved. Do not adjust the test.
2. **Task 4's idempotence.** `survey.test.ts` surveys twice and expects the second pass to grow nothing. That test must pass unchanged, and it is the only thing standing between this and a world that grows a little every time it is opened.
3. **Task 6's ordering decision.** The comment on `dropErrandsForThingsThatDoNotExist` claims respelling has already run. Either keep respelling in the static list (recommended) or order the pipeline so settling precedes the static pass — but the comment and the code must agree, and the commit must say which was chosen.
4. **Use the fixtures each test file already has.** They are named in each task — `newState` in `persist.test.ts`, `beat`/`arc`/`stateWith` in `arc.test.ts`, `demoArtifact`/`beat`/`difference` in `repair.test.ts`. A second `demoArtifact` beside the existing one is how two tests come to disagree about what a demo artifact is.
5. **Task 5's cost is a number, not a hope.** Record how long settling each shipped scenario takes and put it in the commit. This pass is about to run on every generation, and "it should be cheap because the caches are warm" is an argument, not a measurement.
