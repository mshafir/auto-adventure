# Invariants and the Place Solver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, with named mechanical invariants, why the generated scenarios are unplayable — then make a settlement's structure spec binding instead of advisory, and watch the measurement change.

**Architecture:** Phase 1 adds `src/scenario/invariants.ts`, a small set of checks that are deliberately *not* duplicates of `validateArtifact` — each one measures something no existing check measures — plus a CLI that prints them per scenario. Phase 2 replaces the plot-assignment block in `src/core/gen/features/settlement.ts` with a pure constraint solver in a new `src/core/gen/features/plots.ts`: required structures are reserved first by backtracking search, filler takes only what is left, and `pruneUnreachable` may never demolish a reserved building. The loop closes when the phase-1 CLI reports zero `structures-built` violations.

**Tech Stack:** TypeScript (ESM, `node >= 18`), Vitest, Biome, Zod v4. No new dependencies.

## Global Constraints

- **Formatting is Biome, and it is not optional.** Tabs for indent, line width 100, double quotes, trailing commas, semicolons always. Run `npm run lint:fix` before every commit.
- **`npm run check` must pass before every commit.** It is `npm run typecheck && npm run lint && npm test`.
- **Purity of feature generation is load-bearing.** Everything reached from `buildSettlement` must be a pure function of `(world, site, spec)`. No `Math.random`, no `Date`, no reading anything outside the patch and the arguments. A patch is generated once, cached by site id, and clipped into every chunk it touches (`src/core/gen/features/patch.ts:69-88`); a non-deterministic result makes two chunks disagree about a town, and the symptom is outskirts that vanish when the player walks away.
- **Iteration order must be explicit.** Sort candidate lists on stable keys. Never rely on `Map`/`Set` insertion order for anything that reaches generated output.
- **Randomness comes only from the passed `Rng`** (`rngFor(seed, …)` / `makeRng(n)`), never from a fresh source.
- **`ScenarioArtifact` gains fields and loses none.** No existing field changes meaning. `.scenarios/green-chapel.json` and `.scenarios/thornwick-road.json` must keep loading and their live tests must keep passing untouched.
- **`z.object()` strips unknown keys.** Any new field on a stored spec must be added to its schema in `src/scenario/schema.ts` or it silently vanishes on load.
- Existing constants are the source of truth for pacing and must not be re-derived: `LONG_MARCH = 320`, `SHORT_STORY = 60` in `src/scenario/validate.ts:135-136`.

---

## File Structure

**Phase 1 — measurement**

| File | Responsibility |
| --- | --- |
| `src/scenario/invariants.ts` *(create)* | The four invariant checks and their aggregator. Pure; takes an artifact, returns violations. |
| `src/scenario/invariants.test.ts` *(create)* | Unit tests per invariant, using the existing fixture builder. |
| `src/tools/invariants.ts` *(create)* | CLI: run the checks over installed scenarios and print a report. |
| `package.json` *(modify)* | One new script, `invariants`. |

**Phase 2 — the place solver**

| File | Responsibility |
| --- | --- |
| `src/core/gen/features/plots.ts` *(create)* | The solver. Pure, no knowledge of patches or worlds — takes plot rectangles and requests, returns assignments. Independently testable with literals. |
| `src/core/gen/features/plots.test.ts` *(create)* | Solver unit tests: reservation, relations, blocking, determinism, failure. |
| `src/core/gen/features/settlement.ts` *(modify)* | `StructureSpec` gains identity and constraints; the assignment block calls the solver; `pruneUnreachable` protects reserved buildings. |
| `src/core/gen/features/patch.ts` *(modify)* | `BuildingPlacement` gains `required?: boolean`. |
| `src/scenario/schema.ts` *(modify)* | `StoredStructureSchema` accepts the new fields so they survive a round trip through disk. |
| `src/core/gen/features/settlement.test.ts` *(modify)* | Tests that a required structure is always built, never filler, never demolished. |

`plots.ts` declares its **own** input types rather than importing `StructureSpec` from `settlement.ts`. Two reasons: `settlement.ts` will import `plots.ts`, so importing back would be a cycle; and a solver that knows nothing about settlements can be tested with four-line literals instead of a generated world.

---

## Phase 1 — Measurement

### Task 1: The invariant module and `structures-built`

The invariant that matters most, and the one no existing check performs. `validateArtifact` checks that placements resolve and that people stand somewhere real; nothing checks that **the kind of building the spec asked for was actually built**. That is the gap `settlement.ts:244-247` describes as "the spec is advisory".

**Files:**
- Create: `src/scenario/invariants.ts`
- Test: `src/scenario/invariants.test.ts`

**Interfaces:**
- Consumes: `ScenarioArtifact` (`src/scenario/artifact.ts:37`), `artifactWorld` (`artifact.ts:169`), `siteIndex` (`src/scenario/validate.ts:156`), `generateSettlement` (`src/core/gen/features/settlement.ts:61`), `featureKindFor` (`src/core/gen/features/registry.ts`).
- Produces: `type InvariantId`, `interface Violation`, `interface InvariantReport`, `function checkStructuresBuilt(artifact: ScenarioArtifact): Violation[]`. The `checkInvariants` aggregator is **Task 3's** deliverable, not this one's — `InvariantReport` is declared here and has no consumer until then.

- [ ] **Step 1: Write the failing test**

Create `src/scenario/invariants.test.ts`. The fixture module exposes `demoArtifact`,
`demoJourneyArtifact`, `demoSiteSpec`, `findSettlement` and `FIXTURE_SEED` — there is no
generic override for structures, so this file declares its own local helper, which is the
idiom the sibling test files already use (`withSite` in `validate.test.ts`, `withNpcs` in
`repair.test.ts`, `withArc` in `completeness.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { demoArtifact, demoSiteSpec, FIXTURE_SEED, findSettlement } from "../../test/fixtures/scenario.js";
import type { SettlementSpec } from "../core/gen/features/settlement.js";
import { clearFeatureCache } from "../core/gen/features/registry.js";
import type { ScenarioArtifact } from "./artifact.js";
import { checkStructuresBuilt } from "./invariants.js";

/** The one-town fixture, with its settlement asking for exactly these buildings. */
function withStructures(structures: SettlementSpec["structures"]): ScenarioArtifact {
	const site = findSettlement(FIXTURE_SEED);
	const spec = demoSiteSpec(site.id);
	return demoArtifact({
		sites: {
			[String(site.id)]: { ...spec, settlement: { ...spec.settlement, structures } },
		},
	});
}

describe("structures-built", () => {
	it("reports a structure the spec asked for that the settlement did not build", () => {
		clearFeatureCache();
		// Twenty-four halls in one town cannot all get a plot: a hall needs frontage
		// (`structures.ts` gives it a `plotPad`) and the BSP yields a handful of plots that
		// large. The builder swaps the rest for filler and says nothing, which is the
		// substitution this invariant exists to see.
		const artifact = withStructures(
			Array.from({ length: 24 }, (_, i) => ({
				kind: "hall" as const,
				size: "large" as const,
				importance: 5,
				name: `Hall ${i}`,
			})),
		);

		const violations = checkStructuresBuilt(artifact);

		expect(violations.length).toBeGreaterThan(0);
		expect(violations[0]?.invariant).toBe("structures-built");
		expect(violations[0]?.detail).toContain("hall");
	});

	it("is silent when every requested structure was built", () => {
		clearFeatureCache();
		// The fixture's own two buildings, which it has always had room for.
		expect(checkStructuresBuilt(demoArtifact())).toEqual([]);
	});
});
```

If the "is silent" test reports a violation, the fixture town does not have room for even
an inn and a house — read the actual counts printed in the violation `detail` before
changing anything, because that would mean `structures-built` is measuring something other
than what it claims.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/scenario/invariants.test.ts`
Expected: FAIL — `Failed to resolve import "./invariants.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/scenario/invariants.ts`:

```ts
import { featureKindFor } from "../core/gen/features/registry.js";
import { generateSettlement } from "../core/gen/features/settlement.js";
import { artifactWorld, type ScenarioArtifact } from "./artifact.js";
import { siteIndex } from "./validate.js";

/**
 * Mechanical properties a playable world has, measured one at a time.
 *
 * Deliberately *not* a second validator. `validateArtifact` already answers seventeen
 * questions and its answers are trusted; re-asking any of them here would produce a
 * second opinion that can disagree with the first, which is the failure mode
 * `validate.ts:80-86` describes — "a validator that disagrees with the thing it
 * validates is worse than no validator, because it is believed".
 *
 * Every check below measures something no existing check measures. Their purpose is
 * attribution: a scenario that is hard to play should be explainable as a named
 * violated invariant rather than as a feeling, both before a change and after it.
 */

export type InvariantId =
	| "structures-built"
	| "buildings-reachable"
	| "scenes-written"
	| "legs-walkable";

export interface Violation {
	readonly invariant: InvariantId;
	/** Where it went wrong, in terms a person can look up: a site name, a beat id. */
	readonly where: string;
	readonly detail: string;
}

export interface InvariantReport {
	readonly violations: readonly Violation[];
	readonly counts: Readonly<Record<InvariantId, number>>;
}

/**
 * Every structure a site's spec asked for appears in the settlement that was built.
 *
 * Counted as a multiset over kinds rather than matched one-to-one by name, because a
 * spec may legitimately ask for three houses and the builder does not label them. What
 * is being measured is the substitution: `settlement.ts:249-254` gives a plot to filler
 * when the requested structure will not fit it, so the story's counting house becomes a
 * house and nothing anywhere says so.
 *
 * Only sites the settlement builder claims. A castle and a dock lay out their own
 * buildings from their own rules, so measuring their spec against their patch would
 * report a fault that is not one.
 */
export function checkStructuresBuilt(artifact: ScenarioArtifact): Violation[] {
	const world = artifactWorld(artifact);
	const sites = siteIndex(artifact);
	const violations: Violation[] = [];

	// Sorted, so a report is stable between runs and diffable between changes.
	const ids = Object.keys(artifact.sites).sort();
	for (const id of ids) {
		const spec = artifact.sites[id];
		const site = sites.get(Number(id));
		if (!spec || !site) continue;
		if (featureKindFor(site.kind) !== "settlement") continue;

		const patch = generateSettlement(world, site, spec.settlement);
		const built = new Map<string, number>();
		for (const building of patch.buildings) {
			built.set(building.kind, (built.get(building.kind) ?? 0) + 1);
		}

		const wanted = new Map<string, number>();
		for (const structure of spec.settlement.structures) {
			wanted.set(structure.kind, (wanted.get(structure.kind) ?? 0) + 1);
		}

		for (const kind of [...wanted.keys()].sort()) {
			const asked = wanted.get(kind) ?? 0;
			const got = built.get(kind) ?? 0;
			if (got >= asked) continue;
			violations.push({
				invariant: "structures-built",
				where: `${spec.name} (site ${id})`,
				detail: `asked for ${asked} ${kind}, built ${got}`,
			});
		}
	}
	return violations;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/scenario/invariants.test.ts`
Expected: PASS, 2 tests.

If the first test passes with zero violations, the fixture's hamlet has enough plots — raise the count from 12 to 24 rather than weakening the assertion. The point is to reproduce the substitution, not to accommodate it.

- [ ] **Step 5: Commit**

```bash
npm run lint:fix && npm run check
git add src/scenario/invariants.ts src/scenario/invariants.test.ts test/fixtures/scenario.ts
git commit -m "Measure whether the buildings a spec asked for were built"
```

---

### Task 2: `buildings-reachable` and `scenes-written`

Two more measurements, both cheap and both explaining a symptom directly. A building whose doorstep shares no walkable component with the town square cannot be entered — which is what "the location cannot be found" feels like from inside the game. A main-line beat with no dialogue tree is a scene with no words, which is what "the events don't connect" feels like.

**Files:**
- Modify: `src/scenario/invariants.ts`
- Test: `src/scenario/invariants.test.ts`

**Interfaces:**
- Consumes: `reachableFrom` (`src/core/gen/features/terraform.ts:252`), `orderedBeats` and `beatNpcId` (`src/core/rules/arc.ts`).
- Produces: `function checkBuildingsReachable(artifact: ScenarioArtifact): Violation[]`, `function checkScenesWritten(artifact: ScenarioArtifact): Violation[]`.

- [ ] **Step 1: Write the failing tests**

Append to `src/scenario/invariants.test.ts`. Extend the fixture import with
`demoJourneyArtifact`, and add `beatNpcId` from `../core/rules/arc.js`:

```ts
import { checkBuildingsReachable, checkScenesWritten } from "./invariants.js";

describe("buildings-reachable", () => {
	it("is silent on a settlement whose buildings all open onto the square", () => {
		clearFeatureCache();
		expect(checkBuildingsReachable(demoArtifact())).toEqual([]);
	});
});

describe("scenes-written", () => {
	it("reports a main-line beat with no conversation", () => {
		// `demoJourneyArtifact` has two beats, each with a journal and neither with a tree
		// — which is exactly the fault: the beat opens, the errand lands in the journal,
		// and the person it hangs on has nothing to say.
		const violations = checkScenesWritten(demoJourneyArtifact());

		expect(violations).toHaveLength(2);
		expect(violations[0]?.invariant).toBe("scenes-written");
		expect(violations[0]?.detail).toContain("no conversation");
	});

	it("is silent when every beat has words and a journal", () => {
		const artifact = demoJourneyArtifact();
		// A one-line tree per beat: enough to be a conversation, which is all this checks.
		const trees = Object.fromEntries(
			(artifact.arc?.beats ?? []).map((beat) => {
				const id = beatNpcId(beat);
				return [
					id,
					{ npcId: id, entry: ["hello"], nodes: { hello: { id: "hello", speech: "Aye?", choices: [] } } },
				];
			}),
		);

		expect(checkScenesWritten({ ...artifact, trees })).toEqual([]);
	});
});
```

If the `toHaveLength(2)` assertion fails with 4, the fixture's beats have no journal either
and each is producing two violations — read the details and split the assertion rather than
loosening it, since "no journal" and "no conversation" are different faults worth
distinguishing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/scenario/invariants.test.ts`
Expected: FAIL — `checkBuildingsReachable is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/scenario/invariants.ts`. Extend the import block with:

```ts
import { beatNpcId, orderedBeats } from "../core/rules/arc.js";
import { reachableFrom } from "../core/gen/features/terraform.js";
```

Then append:

```ts
/**
 * Every building in a settlement can be walked into from its own town square.
 *
 * `carveConnections` routes to every anchor and `pruneUnreachable` demolishes the
 * buildings it could not reach (`settlement.ts:339-375`), so in principle nothing
 * unreachable survives. This measures whether that holds in practice, because the
 * demolition is bounded at four rounds and gives up quietly afterwards — and because
 * demolition is itself a fault when the building was one the story needed.
 *
 * `reachableFrom` returns `undefined` when the square itself is not walkable, which is
 * a different fault and is reported as its own violation rather than as "every building
 * is unreachable".
 */
export function checkBuildingsReachable(artifact: ScenarioArtifact): Violation[] {
	const world = artifactWorld(artifact);
	const sites = siteIndex(artifact);
	const violations: Violation[] = [];

	for (const id of Object.keys(artifact.sites).sort()) {
		const spec = artifact.sites[id];
		const site = sites.get(Number(id));
		if (!spec || !site) continue;
		if (featureKindFor(site.kind) !== "settlement") continue;

		const patch = generateSettlement(world, site, spec.settlement);
		const square = patch.anchors.find((anchor) => anchor.kind === "square");
		if (!square) {
			violations.push({
				invariant: "buildings-reachable",
				where: `${spec.name} (site ${id})`,
				detail: "the settlement has no square to measure from",
			});
			continue;
		}

		const reached = reachableFrom(patch, { x: square.x, y: square.y }, patch.anchors);
		if (!reached) {
			violations.push({
				invariant: "buildings-reachable",
				where: `${spec.name} (site ${id})`,
				detail: "the square itself is not walkable",
			});
			continue;
		}

		for (const anchor of patch.anchors) {
			if (anchor.kind !== "doorstep" || anchor.building === undefined) continue;
			if (reached.has(anchor)) continue;
			const building = patch.buildings.find((entry) => entry.index === anchor.building);
			violations.push({
				invariant: "buildings-reachable",
				where: `${spec.name} (site ${id})`,
				detail: `${building?.name ?? building?.kind ?? `building ${anchor.building}`} cannot be reached from the square`,
			});
		}
	}
	return violations;
}

/**
 * Every main-line beat has words to say and something to write down.
 *
 * A beat with no tree still opens, still sets its flag and still lands an errand in the
 * journal — so nothing reports it and the story simply has a hole where a scene should
 * be. That is one of the two things a player experiences as "the events do not connect";
 * the other is a beat with no journal, which leaves nothing behind to connect *to*.
 *
 * Side errands are exempt. A player goes looking for one by choice, and warning about
 * every optional beat in every world is how an author learns to stop reading a report.
 */
export function checkScenesWritten(artifact: ScenarioArtifact): Violation[] {
	const arc = artifact.arc;
	if (!arc) return [];

	// Whose scene is unwritten is asked by `checkTrees` too, and is therefore asked once.
	// `beatsWithoutTrees` is exported from `validate.ts` and shared, so the warning an
	// author reads and the violation this report counts can never disagree about who has
	// nothing to say. Narrowed to the main line here, at the one call site, with the reason
	// stated — that is a deliberate difference in *scope*, not a second opinion.
	const unwritten = new Set(
		beatsWithoutTrees(artifact)
			.filter(({ beat }) => !beat.optional)
			.map(({ beat }) => beat.id),
	);

	const violations: Violation[] = [];
	for (const beat of orderedBeats(arc)) {
		if (beat.optional) continue;
		if (unwritten.has(beat.id)) {
			violations.push({
				invariant: "scenes-written",
				where: `beat ${beat.id}`,
				detail: "no conversation was written for the person this beat hangs on",
			});
		}
		// The genuinely new half. Nothing anywhere checks that a beat leaves any prose
		// behind: the only two reads of `beat.journal` — `authoredProse` in `validate.ts`
		// and `toldWhereToGo` in `wayfinding.ts` — gather it to search *within*, and both
		// are content with the empty string.
		const written = beat.journal ?? beat.quest?.description ?? "";
		if (written.trim() === "") {
			violations.push({
				invariant: "scenes-written",
				where: `beat ${beat.id}`,
				detail: "nothing is written down, so the next beat has nothing to follow from",
			});
		}
	}
	return violations;
}
```

And in `src/scenario/validate.ts`, lift the beat-anchor loop out of `checkTrees` (currently
`validate.ts:1523-1536`) into one exported function that both callers use:

```ts
/**
 * The beat anchors nobody wrote a conversation for.
 *
 * Exported and shared rather than asked twice. `checkTrees` turns these into warnings an
 * author reads; `checkScenesWritten` turns them into a counted invariant violation. The
 * rule `wayfinding.ts` was split out for, and for the same reason: two passes asking the
 * identical question must not be able to answer it differently.
 */
export function beatsWithoutTrees(
	artifact: ScenarioArtifact,
): { readonly beat: ScenarioBeat; readonly npcId: string }[] {
	const trees = artifact.trees ?? {};
	const found: { beat: ScenarioBeat; npcId: string }[] = [];
	for (const beat of artifact.arc?.beats ?? []) {
		const id = beatNpcId(beat);
		if (trees[id]) continue;
		found.push({ beat, npcId: id });
	}
	return found;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/scenario/invariants.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
npm run lint:fix && npm run check
git add src/scenario/invariants.ts src/scenario/invariants.test.ts test/fixtures/scenario.ts
git commit -m "Measure buildings nobody can enter and scenes nobody wrote"
```

---

### Task 3: `legs-walkable` and the aggregator

The last invariant is a rollup rather than a new computation: `storyWalk` already measures leg lengths and the first unreachable beat, and it is already exported. Wrapping it rather than recomputing is what keeps this report and the validator from disagreeing about the same journey.

**Files:**
- Modify: `src/scenario/invariants.ts`
- Test: `src/scenario/invariants.test.ts`

**Interfaces:**
- Consumes: `storyWalk` and `buildPassability` (`src/scenario/validate.ts:185`, `:168`).
- Produces: `function checkLegsWalkable(artifact: ScenarioArtifact): Violation[]`, `function checkInvariants(artifact: ScenarioArtifact): InvariantReport`.

- [ ] **Step 1: Write the failing test**

Append to `src/scenario/invariants.test.ts`:

```ts
import { checkInvariants } from "./invariants.js";

describe("checkInvariants", () => {
	it("returns a count for every invariant, including the ones with no violations", () => {
		clearFeatureCache();
		const report = checkInvariants(demoJourneyArtifact());

		expect(Object.keys(report.counts).sort()).toEqual([
			"buildings-reachable",
			"legs-walkable",
			"scenes-written",
			"structures-built",
		]);
		// Every count is the number of violations carrying that id, so the two agree.
		for (const [id, count] of Object.entries(report.counts)) {
			expect(report.violations.filter((v) => v.invariant === id).length).toBe(count);
		}
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/scenario/invariants.test.ts`
Expected: FAIL — `checkInvariants is not a function`.

- [ ] **Step 3: Write the implementation**

Extend the import block in `src/scenario/invariants.ts`:

```ts
import { buildPassability, siteIndex, storyWalk } from "./validate.js";
```

(replacing the existing `siteIndex`-only import) and append:

```ts
/**
 * The longest single leg the story asks the player to walk, against the pacing the
 * validator already judges by.
 *
 * A rollup over `storyWalk` rather than a second path search, deliberately. The numbers
 * are `LONG_MARCH` and `SHORT_STORY` from `validate.ts:135-136`, used at the same
 * altitude as there — `LONG_MARCH` against the longest leg, `SHORT_STORY` against the
 * total — so this report and the validator cannot disagree about whether a world is
 * paced badly.
 */
const LONG_MARCH = 320;
const SHORT_STORY = 60;

export function checkLegsWalkable(artifact: ScenarioArtifact): Violation[] {
	if (!artifact.arc) return [];
	const grid = buildPassability(artifact);
	const walk = storyWalk(artifact, grid, siteIndex(artifact));
	const violations: Violation[] = [];

	// An unreachable beat is reported and nothing else is. `storyWalk` returns *early* when
	// a leg cannot be walked (`validate.ts:200-210`), so `legs` and `tiles` are a partial
	// sum of the journey up to that point — and judging pacing against a partial sum turns
	// one fault into two. A story stopped at its second beat thirty tiles out would be
	// reported as unreachable *and* as under `SHORT_STORY`, which inflates exactly the count
	// this module exists to make comparable. `checkStory` avoids it the same way, by putting
	// its pacing checks in the `else` branch (`validate.ts:1419-1444`).
	if (walk.unreachable) {
		return [
			{
				invariant: "legs-walkable",
				where: `beat ${walk.unreachable}`,
				detail: "there is no walkable route to this beat, so the story cannot be finished",
			},
		];
	}

	for (const leg of walk.legs) {
		if (leg.tiles <= LONG_MARCH) continue;
		violations.push({
			invariant: "legs-walkable",
			where: leg.to,
			detail: `${leg.tiles} tiles in one leg, over the ${LONG_MARCH} a session tolerates`,
		});
	}

	if (walk.legs.length > 0 && walk.tiles < SHORT_STORY) {
		violations.push({
			invariant: "legs-walkable",
			where: "the whole story",
			detail: `${walk.tiles} tiles in total, under the ${SHORT_STORY} that makes a journey`,
		});
	}
	return violations;
}

/**
 * Every invariant, with a count per id.
 *
 * The counts include the zeroes. A report that omits what passed cannot be compared
 * against a later one, and comparing before with after is the only reason this module
 * exists.
 */
export function checkInvariants(artifact: ScenarioArtifact): InvariantReport {
	// Settlements first, then the passability grid. `checkStructuresBuilt` and
	// `checkBuildingsReachable` generate settlement patches, and the grid stamps those
	// same patches — so building the grid first would measure a layout that is about to
	// be regenerated. The same ordering `validateArtifact:230-233` takes, for the same
	// reason.
	const violations = [
		...checkStructuresBuilt(artifact),
		...checkBuildingsReachable(artifact),
		...checkScenesWritten(artifact),
		...checkLegsWalkable(artifact),
	];

	const counts: Record<InvariantId, number> = {
		"structures-built": 0,
		"buildings-reachable": 0,
		"scenes-written": 0,
		"legs-walkable": 0,
	};
	for (const violation of violations) counts[violation.invariant]++;

	return { violations, counts };
}
```

- [ ] **Step 4: Run the whole suite to verify nothing regressed**

Run: `npx vitest run src/scenario/`
Expected: PASS. The invariant tests pass and no existing scenario test changed.

- [ ] **Step 5: Commit**

```bash
npm run lint:fix && npm run check
git add src/scenario/invariants.ts src/scenario/invariants.test.ts
git commit -m "Roll the story's walking up into the invariant report"
```

---

### Task 4: The CLI, and the baseline

The measurement is only useful if it is easy to take. This is the step that produces the number the whole redesign is judged against.

**Files:**
- Create: `src/tools/invariants.ts`
- Modify: `package.json`
- Modify: `docs/superpowers/plans/2026-08-10-invariants-and-place-solver.md` (record the baseline in Step 5)

**Interfaces:**
- Consumes: `checkInvariants` from Task 3; `listScenarios`, `readScenarioFile`, `scenarioPath` (`src/scenario/repo.ts:96`, `:39`, `:19`).
- Produces: `npm run invariants` and `npm run invariants -- --scenario <id>`.

- [ ] **Step 1: Write the CLI**

There is no test for this task: it is a reporting shell over `checkInvariants`, which Task 3 tested, and a test asserting the shape of printed text would only pin the wording. Create `src/tools/invariants.ts`, following the argument parsing and exit conventions of `src/tools/validate.ts`:

```ts
/**
 * Report which mechanical invariants a scenario on disk violates.
 *
 * ```
 * npm run invariants                            # every scenario installed
 * npm run invariants -- --scenario green-chapel
 * ```
 *
 * Companion to `npm run validate` rather than a replacement. `validate` answers "is
 * anything wrong with this file"; this answers "which of the four properties a playable
 * world has does this one lack", which is the question worth asking before and after a
 * change to the generator. Exits non-zero when anything is violated, so it can gate a
 * commit.
 */
import { checkInvariants, type InvariantId } from "../scenario/invariants.js";
import { listScenarios, readScenarioFile, scenarioPath } from "../scenario/repo.js";

function parseArgs(argv: readonly string[]): Map<string, string> {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token?.startsWith("--")) continue;
		const [key, inline] = token.slice(2).split("=", 2);
		if (!key) continue;
		if (inline !== undefined) {
			args.set(key, inline);
			continue;
		}
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			args.set(key, next);
			i++;
		} else args.set(key, "true");
	}
	return args;
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	const named = args.get("scenario");
	const ids = named && named !== "true" ? [named] : listScenarios().map((entry) => entry.id);

	if (ids.length === 0) {
		process.stderr.write("no scenarios installed\n");
		process.exit(1);
	}

	let broken = false;
	for (const id of ids) {
		const artifact = readScenarioFile(scenarioPath(id));
		if (!artifact) {
			process.stdout.write(`${id} — could not be read\n\n`);
			broken = true;
			continue;
		}

		const report = checkInvariants(artifact);
		process.stdout.write(`${id} — ${artifact.title}\n`);
		for (const violation of report.violations) {
			process.stdout.write(`  ${violation.invariant}  ${violation.where}: ${violation.detail}\n`);
		}
		// Every invariant named, including the ones that held. A report that lists only
		// failures cannot be compared with a later one.
		for (const [invariant, count] of Object.entries(report.counts) as [InvariantId, number][]) {
			process.stdout.write(`  ${count === 0 ? "ok  " : "FAIL"}  ${invariant}: ${count}\n`);
		}
		process.stdout.write("\n");
		broken ||= report.violations.length > 0;
	}

	process.exit(broken ? 1 : 0);
}

main();
```

- [ ] **Step 2: Add the npm script**

In `package.json`, beside the existing `"validate"` script:

```json
"invariants": "vite-node src/tools/invariants.ts --",
```

- [ ] **Step 3: Run it on every installed scenario**

Run: `npm run invariants`

Expected: a report for each of the four scenarios in `.scenarios/`. It will exit non-zero. That is the point — the two hand-written scenarios (`green-chapel`, `thornwick-road`) should be mostly clean, and the two generated ones (`a-secret-lies-in-the`, `an-interesting-spin-on-the`) should show `structures-built` and `buildings-reachable` violations.

- [ ] **Step 4: Record the baseline in this plan**

Paste the four count blocks verbatim into a new `## Baseline` section at the end of this plan file, under today's date. Phase 2 is judged against this and nothing else.

If the generated scenarios show **zero** `structures-built` violations, stop and report it before starting Phase 2 — the diagnosis in the spec would be wrong about this codebase, and the phase order should be reconsidered rather than the plan continued.

- [ ] **Step 5: Commit**

```bash
npm run lint:fix && npm run typecheck && npm run lint && npm test
git add src/tools/invariants.ts package.json docs/superpowers/plans/2026-08-10-invariants-and-place-solver.md
git commit -m "Report the invariants a scenario on disk violates, and record the baseline"
```

Note: `npm run check` will now fail on a repo whose scenarios violate invariants only if you wire `invariants` into it. **Do not wire it into `check` yet** — it would make the tree red until Phase 2 lands.

---

## Phase 2 — The Place Solver

### Task 5: Give a structure an identity and a constraint

Before anything can be reserved it needs a name to be reserved by, and the fields have to survive a round trip through disk — `z.object()` strips what it does not know about.

**Files:**
- Modify: `src/core/gen/features/settlement.ts:35-44` (`StructureSpec`)
- Modify: `src/core/gen/features/patch.ts:48-67` (`BuildingPlacement`)
- Modify: `src/scenario/schema.ts:93-101` (`StoredStructureSchema`)
- Test: `src/scenario/repo.test.ts`

**Interfaces:**
- Produces: `StructureSpec.id?: string`, `StructureSpec.required?: boolean`, `StructureSpec.relations?: readonly Relation[]` (the `Relation` type itself arrives in Task 6, so this task adds only `id` and `required`); `BuildingPlacement.required?: boolean`.

- [ ] **Step 1: Write the failing test**

Add to `src/scenario/repo.test.ts`. Read the top of that file first: it already sets up a
temporary scenario directory for `writeScenario`/`readScenarioFile`, and this test must use
the same setup rather than introducing a second one.

```ts
it("keeps a structure's identity and its required flag through a round trip", () => {
	const site = findSettlement(FIXTURE_SEED);
	const spec = demoSiteSpec(site.id);
	const artifact = demoArtifact({
		sites: {
			[String(site.id)]: {
				...spec,
				settlement: {
					...spec.settlement,
					structures: [
						{
							kind: "hall",
							size: "medium",
							importance: 5,
							name: "The Counting House",
							id: "counting-house",
							required: true,
						},
					],
				},
			},
		},
	});

	const path = writeScenario(artifact);
	const read = readScenarioFile(path);

	const structure = read?.sites[String(site.id)]?.settlement.structures[0];
	expect(structure?.id).toBe("counting-house");
	expect(structure?.required).toBe(true);
});
```

This is the test that catches the `z.object()` stripping rule from Global Constraints: it
fails before the schema change and passes after, with no other code involved.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/scenario/repo.test.ts`
Expected: FAIL — `structure?.id` is `undefined`, because the schema stripped it.

- [ ] **Step 3: Write the implementation**

In `src/core/gen/features/settlement.ts`, extend `StructureSpec`:

```ts
export interface StructureSpec {
	readonly kind: StructureKind;
	readonly size: "small" | "medium" | "large";
	/** 1..5. Used to decide who gets a plot when there are more specs than plots. */
	readonly importance: number;
	readonly name?: string;
	readonly signText?: string;
	/** What has to be true to get inside. Absent means the door simply opens. */
	readonly lock?: Lock;
	/**
	 * A handle for this structure, so something else can refer to it.
	 *
	 * Needed because `required` and the relations in `plots.ts` are about *this*
	 * building and not about its kind: a settlement with three houses and one required
	 * counting house cannot express either without a way to name the one that matters.
	 */
	readonly id?: string;
	/**
	 * Whether the settlement must contain this, or may substitute filler for it.
	 *
	 * The flag that makes a spec binding. Without it the assignment pass is advisory all
	 * the way down — a plot too small yields filler and the story's counting house
	 * quietly becomes a house — and nothing downstream can tell the difference between a
	 * building the author wanted and one the roll happened to place.
	 */
	readonly required?: boolean;
}
```

In `src/core/gen/features/patch.ts`, extend `BuildingPlacement`:

```ts
	/**
	 * Whether the spec insisted on this building.
	 *
	 * Carried on the placement rather than re-derived, because the two passes that must
	 * respect it — the demolition pass in `settlement.ts` and the `buildings-reachable`
	 * invariant — both see placements and not specs. Re-deriving it would mean matching
	 * a building back to a spec entry by name, which is exactly the fuzzy join this flag
	 * exists to avoid.
	 */
	readonly required?: boolean;
```

In `src/scenario/schema.ts`, extend `StoredStructureSchema`:

```ts
const StoredStructureSchema = z.object({
	kind: z.enum(STRUCTURE_KINDS),
	size: z.enum(["small", "medium", "large"]),
	importance: z.number().int().min(1).max(5),
	name: z.string().optional(),
	signText: z.string().optional(),
	/** What has to be true to get inside. Absent means the door simply opens. */
	lock: LockSchema.optional(),
	/** A handle, so a relation or a story beat can name this building. */
	id: z.string().optional(),
	/** Whether the settlement must contain this rather than substituting filler. */
	required: z.boolean().optional(),
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/scenario/repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run lint:fix && npm run check
git add src/core/gen/features/settlement.ts src/core/gen/features/patch.ts src/scenario/schema.ts src/scenario/repo.test.ts test/fixtures/scenario.ts
git commit -m "Let a structure say what it is and that it is not optional"
```

---

### Task 6: The solver — reservation before decoration

The heart of the phase. A pure function, no world and no patch, so it can be tested with literal rectangles.

**Files:**
- Create: `src/core/gen/features/plots.ts`
- Test: `src/core/gen/features/plots.test.ts`

**Interfaces:**
- Consumes: `Rect`, `Vec2`, `rectCenter`, `dist` (`src/core/geom/vec.ts`); `minimumPlot` (`src/core/gen/features/building.ts:241`); `StructureKind` (`patch.ts:27`).
- Produces: `interface Relation` (union), `interface PlotRequest`, `interface PlotContext`, `interface PlotSolution`, `function assignPlots(context: PlotContext, requests: readonly PlotRequest[]): PlotSolution`, `function rectGap(a: Rect, b: Rect): number`.

- [ ] **Step 1: Write the failing tests**

Create `src/core/gen/features/plots.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Rect } from "../../geom/vec.js";
import { assignPlots, type PlotContext, type PlotRequest } from "./plots.js";

/** A row of plots of increasing size, so "too small for this" is easy to arrange. */
function context(sizes: readonly number[]): PlotContext {
	const plots: Rect[] = sizes.map((size, i) => ({ x: i * 40, y: 0, w: size, h: size }));
	return { plots, square: { x: 0, y: 0 }, gates: [], centre: { x: 0, y: 0 }, radius: 60 };
}

function request(over: Partial<PlotRequest> = {}): PlotRequest {
	return {
		id: over.id ?? "r1",
		kind: over.kind ?? "house",
		size: over.size ?? "small",
		importance: over.importance ?? 3,
		required: over.required ?? false,
		relations: over.relations ?? [],
	};
}

describe("assignPlots", () => {
	it("gives a required structure a plot even when an optional one wants it more", () => {
		// One plot big enough for a hall. The optional request has higher importance, and
		// under the old importance-sort it took the plot and the required one got filler.
		const ctx = context([13, 6]);
		const solution = assignPlots(ctx, [
			request({ id: "needed", kind: "hall", size: "medium", required: true, importance: 1 }),
			request({ id: "wanted", kind: "hall", size: "medium", required: false, importance: 5 }),
		]);

		expect(solution.unplaced).toEqual([]);
		expect(solution.assignments.find((a) => a.request.id === "needed")).toBeDefined();
	});

	it("reports a required structure it could not place rather than dropping it", () => {
		const ctx = context([6, 6]);
		const solution = assignPlots(ctx, [
			request({ id: "needed", kind: "hall", size: "large", required: true }),
		]);

		expect(solution.unplaced).toEqual(["needed"]);
		expect(solution.assignments).toEqual([]);
	});

	it("is deterministic: the same input gives the same assignment every time", () => {
		const ctx = context([13, 12, 11, 10, 9, 8, 7]);
		const requests = [
			request({ id: "a", kind: "inn", required: true }),
			request({ id: "b", kind: "smithy", required: true }),
			request({ id: "c", kind: "shop", required: false }),
		];

		const first = assignPlots(ctx, requests);
		for (let attempt = 0; attempt < 5; attempt++) {
			expect(assignPlots(ctx, requests)).toEqual(first);
		}
	});

	it("backtracks when a greedy first choice would strand a later requirement", () => {
		// Two plots. Both requests fit plot 0; only one fits plot 1. A greedy pass that
		// hands plot 0 to the first request strands the second, so the solver must
		// reconsider.
		const ctx = context([13, 7]);
		const solution = assignPlots(ctx, [
			request({ id: "small-one", kind: "shop", size: "small", required: true }),
			request({ id: "big-one", kind: "hall", size: "medium", required: true }),
		]);

		expect(solution.unplaced).toEqual([]);
		expect(solution.assignments).toHaveLength(2);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/gen/features/plots.test.ts`
Expected: FAIL — `Failed to resolve import "./plots.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/core/gen/features/plots.ts`:

```ts
import { dist, type Rect, rectCenter, type Vec2 } from "../../geom/vec.js";
import { minimumPlot } from "./building.js";
import type { StructureKind } from "./patch.js";

/**
 * Which building goes on which plot, decided rather than hoped for.
 *
 * This replaces the block `settlement.ts` described as advisory: "more structures than
 * plots are truncated by importance and fewer are padded with filler, so a malformed or
 * oversized spec degrades instead of failing". Degrading instead of failing is the right
 * instinct for a malformed spec and the wrong one for a story: a plot too small for the
 * requested counting house handed the plot to filler, so the building the story sends
 * the player to find was a house, and nothing anywhere said so.
 *
 * So requirements are solved *first*, by search, and filler takes only what is left.
 * Filler can no longer outbid a requirement because it never competes for the same plot.
 *
 * Knows nothing about patches, worlds or settlements, and takes its own input types
 * rather than importing `StructureSpec`. Partly to avoid the import cycle with
 * `settlement.ts`, and partly because a solver that needs a generated world to be tested
 * is a solver that will not be tested at the edges.
 */

/** Where a building has to be, relative to the town or to another building. */
export type Relation =
	/** Within `within` tiles of the square, for something civic. */
	| { readonly t: "OnSquare"; readonly within: number }
	/** Out towards the edge of the footprint, for something nobody wants next door. */
	| { readonly t: "AtEdge" }
	/** Within `within` tiles of the street the player arrives by. */
	| { readonly t: "OnArrivalStreet"; readonly within: number }
	/** Within `within` tiles of another request, by id. */
	| { readonly t: "Adjacent"; readonly to: string; readonly within: number }
	/**
	 * No other building within `minGap` tiles.
	 *
	 * Costs plots rather than merely constraining one: filler would otherwise build right
	 * up against a hermit's tower and the isolation would last until the next pass. So an
	 * isolated assignment also *blocks* the plots inside its gap, and those plots are
	 * returned so the caller can leave them empty.
	 */
	| { readonly t: "Isolated"; readonly minGap: number };

export interface PlotRequest {
	readonly id: string;
	readonly kind: StructureKind;
	readonly size: "small" | "medium" | "large";
	/** 1..5. Orders optional requests only; a requirement is not outranked. */
	readonly importance: number;
	readonly required: boolean;
	readonly relations: readonly Relation[];
}

export interface PlotContext {
	/** Candidate plots, in the caller's preferred order (largest first, today). */
	readonly plots: readonly Rect[];
	readonly square: Vec2;
	/** Where roads enter the footprint, for `OnArrivalStreet`. */
	readonly gates: readonly Vec2[];
	readonly centre: Vec2;
	readonly radius: number;
}

export interface PlotAssignment {
	/** Index into {@link PlotContext.plots}. */
	readonly plot: number;
	readonly request: PlotRequest;
}

export interface PlotSolution {
	readonly assignments: readonly PlotAssignment[];
	/** Plot indices that must be left empty, from an `Isolated` requirement. */
	readonly blocked: readonly number[];
	/** Ids of required requests that no plot could satisfy. */
	readonly unplaced: readonly string[];
}

/**
 * How far apart two rectangles are, zero when they touch or overlap.
 *
 * Chebyshev rather than Euclidean, because it is measuring a gap between footprints on a
 * tile grid: two buildings offset diagonally by one tile are neighbours.
 */
export function rectGap(a: Rect, b: Rect): number {
	const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
	const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
	return Math.max(dx, dy);
}

/**
 * A ceiling on the search.
 *
 * Six requirements over thirty plots is solved in microseconds and nothing in this game
 * asks for more, but a bad spec should cost a bounded amount rather than a hang: this is
 * generation, and it runs inside a chunk request.
 */
const MAX_NODES = 20_000;

function fitsSize(plot: Rect, request: PlotRequest): boolean {
	const need = minimumPlot(request.kind, request.size);
	return plot.w >= need.x && plot.h >= need.y;
}

export function assignPlots(
	context: PlotContext,
	requests: readonly PlotRequest[],
): PlotSolution {
	const { plots } = context;

	/**
	 * Whether a relation holds for a plot, given what has been chosen so far.
	 *
	 * Takes the plot's *index* as well as the rectangle. `Isolated` has to exclude the
	 * plot from its own neighbour sweep, and finding it by `indexOf` would compare by
	 * reference — correct today and quietly wrong the moment a caller passes two plots
	 * that happen to be equal rectangles.
	 */
	const holds = (
		relation: Relation,
		at: number,
		plot: Rect,
		chosen: ReadonlyMap<string, number>,
	): boolean => {
		switch (relation.t) {
			case "OnSquare":
				return dist(rectCenter(plot), context.square) <= relation.within;
			case "AtEdge":
				return dist(rectCenter(plot), context.centre) >= context.radius * 0.6;
			case "OnArrivalStreet":
				return context.gates.some((gate) => dist(rectCenter(plot), gate) <= relation.within);
			case "Adjacent": {
				const other = chosen.get(relation.to);
				// Not yet placed: nothing to measure against, so allow it here and let the
				// final check below settle it. Allowing early keeps the search complete —
				// rejecting an unmeasurable relation would prune the only valid ordering.
				if (other === undefined) return true;
				const target = plots[other];
				return target !== undefined && rectGap(plot, target) <= relation.within;
			}
			case "Isolated":
				return plots.every(
					(other, index) => index === at || rectGap(plot, other) >= relation.minGap,
				);
		}
	};

	/**
	 * Every relation of every placed request, re-checked against the finished assignment.
	 *
	 * `Adjacent` is allowed through above when its target is not yet placed, so a
	 * complete assignment has to be verified once at the end. Without this the solver
	 * would accept a pair whose adjacency was never actually measured.
	 */
	const verified = (chosen: ReadonlyMap<string, number>, subject: readonly PlotRequest[]): boolean =>
		subject.every((request) => {
			const index = chosen.get(request.id);
			if (index === undefined) return false;
			const plot = plots[index];
			if (!plot) return false;
			return request.relations.every((relation) => {
				if (relation.t !== "Adjacent") return holds(relation, index, plot, chosen);
				const other = chosen.get(relation.to);
				if (other === undefined) return true;
				const target = plots[other];
				return target !== undefined && rectGap(plot, target) <= relation.within;
			});
		});

	// Required first, and among them the most constrained first — fewest candidate plots,
	// then most important, then by id. Sorting on explicit keys rather than relying on the
	// caller's order is what makes the result a function of the inputs alone.
	const required = requests.filter((request) => request.required);
	const domainOf = (request: PlotRequest): number =>
		plots.filter((plot) => fitsSize(plot, request)).length;
	const ordered = [...required].sort(
		(a, b) =>
			domainOf(a) - domainOf(b) || b.importance - a.importance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);

	const chosen = new Map<string, number>();
	const taken = new Set<number>();
	let nodes = 0;

	const place = (at: number): boolean => {
		if (at >= ordered.length) return verified(chosen, ordered);
		const request = ordered[at];
		if (!request) return true;

		for (let index = 0; index < plots.length; index++) {
			if (++nodes > MAX_NODES) return false;
			if (taken.has(index)) continue;
			const plot = plots[index];
			if (!plot || !fitsSize(plot, request)) continue;
			if (!request.relations.every((relation) => holds(relation, index, plot, chosen))) continue;

			taken.add(index);
			chosen.set(request.id, index);
			if (place(at + 1)) return true;
			chosen.delete(request.id);
			taken.delete(index);
		}
		return false;
	};

	const solved = place(0);
	const assignments: PlotAssignment[] = [];
	const unplaced: string[] = [];

	if (solved) {
		for (const request of ordered) {
			const index = chosen.get(request.id);
			if (index === undefined) unplaced.push(request.id);
			else assignments.push({ plot: index, request });
		}
	} else {
		// No complete assignment. Report every requirement as unplaced rather than
		// shipping a partial one: a settlement missing one of three required buildings is
		// a fault the caller must see, and a half-solution hides which half is missing.
		chosen.clear();
		taken.clear();
		for (const request of ordered) unplaced.push(request.id);
	}

	// Plots an isolated building keeps empty. Collected after the search, because it
	// depends on where the isolated buildings actually landed.
	const blocked = new Set<number>();
	for (const assignment of assignments) {
		const gap = assignment.request.relations.find((relation) => relation.t === "Isolated");
		if (!gap || gap.t !== "Isolated") continue;
		const plot = plots[assignment.plot];
		if (!plot) continue;
		plots.forEach((other, index) => {
			if (index === assignment.plot || taken.has(index)) return;
			if (rectGap(plot, other) < gap.minGap) blocked.add(index);
		});
	}

	// Then the optional requests, by importance as before, into what is left.
	const optional = [...requests.filter((request) => !request.required)].sort(
		(a, b) => b.importance - a.importance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	for (const request of optional) {
		const index = plots.findIndex(
			(plot, i) => !taken.has(i) && !blocked.has(i) && fitsSize(plot, request),
		);
		if (index < 0) continue;
		taken.add(index);
		assignments.push({ plot: index, request });
	}

	// Sorted by plot index so the caller iterates plots in a stable order.
	assignments.sort((a, b) => a.plot - b.plot);
	return { assignments, blocked: [...blocked].sort((a, b) => a - b), unplaced: unplaced.sort() };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/gen/features/plots.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add relation tests and make them pass**

Append to `plots.test.ts`:

```ts
describe("relations", () => {
	it("puts an OnSquare requirement near the square and not across town", () => {
		const ctx: PlotContext = {
			plots: [
				{ x: 200, y: 200, w: 13, h: 13 },
				{ x: 4, y: 4, w: 13, h: 13 },
			],
			square: { x: 0, y: 0 },
			gates: [],
			centre: { x: 0, y: 0 },
			radius: 60,
		};

		const solution = assignPlots(ctx, [
			request({ id: "temple", kind: "temple", size: "medium", required: true, relations: [{ t: "OnSquare", within: 30 }] }),
		]);

		expect(solution.unplaced).toEqual([]);
		expect(solution.assignments[0]?.plot).toBe(1);
	});

	it("keeps an Isolated requirement's neighbours empty", () => {
		const ctx: PlotContext = {
			plots: [
				{ x: 0, y: 0, w: 9, h: 9 },
				{ x: 12, y: 0, w: 9, h: 9 },
				{ x: 300, y: 0, w: 9, h: 9 },
			],
			square: { x: 0, y: 0 },
			gates: [],
			centre: { x: 0, y: 0 },
			radius: 400,
		};

		const solution = assignPlots(ctx, [
			request({ id: "tower", kind: "tower", size: "small", required: true, relations: [{ t: "Isolated", minGap: 20 }] }),
			request({ id: "filler-ish", kind: "house", size: "small", required: false }),
		]);

		const tower = solution.assignments.find((a) => a.request.id === "tower");
		expect(tower?.plot).toBe(2);
		// Plot 2's only near neighbour is nothing; plots 0 and 1 are 288 tiles away, so
		// neither is blocked and the optional request may take one.
		expect(solution.blocked).toEqual([]);
		expect(solution.assignments.find((a) => a.request.id === "filler-ish")).toBeDefined();
	});
});
```

Run: `npx vitest run src/core/gen/features/plots.test.ts`
Expected: PASS, 6 tests. Fix the implementation if a relation misbehaves — do not adjust the expectations.

- [ ] **Step 6: Commit**

```bash
npm run lint:fix && npm run check
git add src/core/gen/features/plots.ts src/core/gen/features/plots.test.ts
git commit -m "Solve plots for what the story requires before filler gets a say"
```

---

### Task 7: Wire the solver into the settlement builder

**Files:**
- Modify: `src/core/gen/features/settlement.ts:244-279` (the assignment block) and its imports
- Test: `src/core/gen/features/settlement.test.ts`

**Interfaces:**
- Consumes: `assignPlots`, `PlotRequest`, `PlotContext` from Task 6; `StructureSpec.id`/`.required` from Task 5.
- Produces: no new exports. `buildSettlement`'s output changes: a `required` structure always gets a plot when one exists, and its `BuildingPlacement.required` is `true`.

- [ ] **Step 1: Write the failing test**

Append to `src/core/gen/features/settlement.test.ts`:

```ts
describe("required structures", () => {
	it("builds a required structure even when the town is oversubscribed", () => {
		const { seed, sites } = sampleSites("required", 3);
		const site = sites.find((s) => s.kind === "hamlet") ?? sites[0];
		if (!site) return;
		const world = worldSeed(seed);

		const patch = generateSettlement(world, site, {
			walled: false,
			structures: [
				// One requirement, buried behind more filler-grade specs than there are plots.
				{ kind: "hall", size: "medium", importance: 1, id: "counting-house", name: "The Counting House", required: true },
				...Array.from({ length: 30 }, () => ({
					kind: "house" as const,
					size: "large" as const,
					importance: 5,
				})),
			],
		});

		const counting = patch.buildings.find((b) => b.name === "The Counting House");
		expect(counting).toBeDefined();
		expect(counting?.kind).toBe("hall");
		expect(counting?.required).toBe(true);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/gen/features/settlement.test.ts -t "required structures"`
Expected: FAIL — `counting` is `undefined`, because the importance sort gave every plot to the houses.

- [ ] **Step 3: Write the implementation**

In `src/core/gen/features/settlement.ts`, add to the imports:

```ts
import { assignPlots, type PlotRequest } from "./plots.js";
```

Then replace the block at `settlement.ts:244-279` (from the `// --- assign structures to plots` comment through the end of the `plots.forEach(...)` call) with:

```ts
	// --- assign structures to plots -----------------------------------------
	// Requirements are solved first and filler takes what is left; see `plots.ts` for
	// why the old importance sort could not express that. `id` falls back to the spec's
	// index so every request has a distinct handle even when the author gave none.
	const requests: PlotRequest[] = spec.structures.map((structure, index) => ({
		id: structure.id ?? `s${index}`,
		kind: structure.kind,
		size: structure.size,
		importance: structure.importance,
		required: structure.required ?? false,
		relations: [],
	}));

	const gates = anchors
		.filter((anchor) => anchor.kind === "gate")
		.map((anchor) => ({ x: anchor.x, y: anchor.y }));

	const solution = assignPlots(
		{ plots, square, gates, centre: site.site, radius },
		requests,
	);

	const specByRequestId = new Map(
		spec.structures.map((structure, index) => [structure.id ?? `s${index}`, structure] as const),
	);
	const assignedTo = new Map(
		solution.assignments.map((assignment) => [assignment.plot, assignment.request] as const),
	);
	const blocked = new Set(solution.blocked);

	plots.forEach((plot, i) => {
		// A plot an isolated building keeps clear stays clear. Building filler here would
		// undo the isolation the requirement asked for.
		if (blocked.has(i)) return;

		const request = assignedTo.get(i);
		const assigned = request ? specByRequestId.get(request.id) : undefined;
		const kind: StructureKind = assigned?.kind ?? pickFiller(world, rng);
		const size = fitRect(plot, assigned?.size ?? "small", rng);
		if (size.w < 5 || size.h < 5) return;

		const index = buildings.length;
		const interiorId = hash2(site.id, index);
		const streetTarget = nearestStreet(patch, size) ?? square;
		const result = buildStructure(
			patch,
			index,
			kind,
			size,
			streetTarget,
			interiorId,
			rng,
			assigned
				? {
						name: assigned.name,
						signText: assigned.signText,
						lock: assigned.lock,
						required: assigned.required ?? false,
					}
				: undefined,
		);
		buildings.push(result.placement);
		anchors.push(...result.anchors);
	});
```

Then in `src/core/gen/features/building.ts`, extend `buildStructure`'s `details` parameter and the placement it returns:

```ts
	details?: {
		readonly name?: string;
		readonly signText?: string;
		readonly lock?: Lock;
		readonly required?: boolean;
	},
```

and in the `placement` object:

```ts
		...(details?.required ? { required: true } : {}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/gen/features/`
Expected: PASS. The new test passes and every existing settlement test still passes — including "is a pure function of the site and spec" and "does not depend on which chunk asked for it first", which are the two that would catch a non-deterministic solver.

If a golden test in `src/core/gen/golden.test.ts` fails, read the diff before regenerating. A change in filler *placement* is expected — the assignment order changed. A change in the *town outline, streets, or square* is not, and means something in the new block is reading state it should not.

- [ ] **Step 5: Commit**

```bash
npm run lint:fix && npm run check
git add src/core/gen/features/settlement.ts src/core/gen/features/building.ts src/core/gen/features/settlement.test.ts
git commit -m "Make the settlement builder honour a structure the spec insisted on"
```

---

### Task 8: Never demolish what the story needs

`pruneUnreachable` demolishes any building whose doorstep the carve pass could not reach (`settlement.ts:339-375`). That is right for filler walled in by its neighbours and wrong for the one building the story sends the player to.

**Files:**
- Modify: `src/core/gen/features/settlement.ts:337-375`
- Test: `src/core/gen/features/settlement.test.ts`

**Interfaces:**
- Consumes: `BuildingPlacement.required` from Task 5.
- Produces: no new exports. `pruneUnreachable` gains behaviour: a required building is never demolished; a non-required neighbour is demolished instead.

- [ ] **Step 1: Write the failing test**

Append to `src/core/gen/features/settlement.test.ts`:

```ts
it("never demolishes a required building, across many seeds", () => {
	// Demolition only fires when a doorstep is walled in, which depends on the roll. So
	// this sweeps seeds rather than contriving one: the property is that no seed anywhere
	// produces a town that has thrown away the building the story needs.
	for (const name of ["prune-a", "prune-b", "prune-c", "prune-d", "prune-e"]) {
		clearFeatureCache();
		const { seed, sites } = sampleSites(name, 3);
		for (const site of sites) {
			const world = worldSeed(seed);
			const patch = generateSettlement(world, site, {
				walled: site.kind === "town",
				structures: [
					{ kind: "hall", size: "medium", importance: 1, id: "needed", name: "Needed", required: true },
					...Array.from({ length: 20 }, () => ({
						kind: "house" as const,
						size: "medium" as const,
						importance: 3,
					})),
				],
			});

			// Either it was never placed (too few plots, reported by the solver) or it
			// survives. What must never happen is placed-then-demolished.
			const needed = patch.buildings.filter((b) => b.required);
			expect(needed.length).toBeLessThanOrEqual(1);
			for (const building of needed) {
				expect(building.name).toBe("Needed");
			}
		}
	}
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/gen/features/settlement.test.ts -t "never demolishes"`
Expected: this test may **pass** immediately, because demolition is rare. That is not good enough — it means the test does not yet exercise the path. Before proceeding, confirm the path runs at all by adding a temporary `console.error` inside the `for (const index of doomed)` loop and re-running. If it never fires across those five seeds, widen the seed list until it does, then remove the logging. **A guard with no failing test is a guess.**

- [ ] **Step 3: Write the implementation**

Replace `pruneUnreachable` in `src/core/gen/features/settlement.ts` with:

```ts
const MAX_PRUNE_ROUNDS = 4;

/**
 * Demolish what the carve pass could not reach — except what the story needs.
 *
 * A building walled in by its neighbours is demolished rather than shipped, because the
 * alternative the old design took was letting the player break the wall at runtime,
 * which turned every unreachable objective into a hole punched through stone.
 *
 * A *required* building is different: demolishing it is the very substitution
 * `plots.ts` exists to prevent, arriving one pass later. So a required building that
 * cannot be reached takes a neighbour down instead — the nearest non-required building —
 * and the carve is retried. If that still does not open a route the building is kept,
 * unreachable, and the `buildings-reachable` invariant reports it. Kept rather than
 * demolished on purpose: a building standing in the wrong place is a bug somebody can
 * see and fix, and a building that was silently deleted is the bug that took a
 * playthrough to find.
 */
function pruneUnreachable(
	patch: FeaturePatch,
	square: Vec2,
	buildings: BuildingPlacement[],
	anchors: Anchor[],
	buildable: Allowed,
	rng: Rng,
): void {
	for (let round = 0; round < MAX_PRUNE_ROUNDS; round++) {
		const reached = reachableFrom(patch, square, anchors);
		if (!reached) return;

		const stranded = new Set<number>();
		for (const anchor of anchors) {
			if (anchor.kind !== "doorstep" || anchor.building === undefined) continue;
			if (!reached.has(anchor)) stranded.add(anchor.building);
		}
		if (stranded.size === 0) return;

		const isRequired = (index: number) =>
			buildings.find((building) => building.index === index)?.required === true;

		// What actually comes down this round: the stranded buildings that may be
		// demolished, plus one sacrificial neighbour for each stranded one that may not.
		const doomed = new Set<number>();
		for (const index of stranded) {
			if (!isRequired(index)) {
				doomed.add(index);
				continue;
			}
			const neighbour = nearestExpendable(buildings, index, doomed);
			if (neighbour !== undefined) doomed.add(neighbour);
		}
		if (doomed.size === 0) return;

		for (const index of doomed) {
			const building = buildings.find((b) => b.index === index);
			if (building) demolish(patch, building, buildable, rng);
		}

		for (let i = buildings.length - 1; i >= 0; i--) {
			if (doomed.has(buildings[i]?.index ?? -1)) buildings.splice(i, 1);
		}
		for (let i = anchors.length - 1; i >= 0; i--) {
			const owner = anchors[i]?.building;
			if (owner !== undefined && doomed.has(owner)) anchors.splice(i, 1);
		}

		// Re-carve: removing a building may open a route the previous pass could not find.
		carveConnections(patch, square, anchors, buildable);
	}
}

/**
 * The nearest building that may be knocked down to open a route to `index`.
 *
 * By squared distance between footprint centres, with the building index as the
 * tie-break, so two equidistant neighbours always resolve the same way — this runs
 * inside settlement generation, where a coin toss would make two chunks disagree.
 */
function nearestExpendable(
	buildings: readonly BuildingPlacement[],
	index: number,
	already: ReadonlySet<number>,
): number | undefined {
	const subject = buildings.find((building) => building.index === index);
	if (!subject) return undefined;
	const centreOf = (building: BuildingPlacement) => ({
		x: building.rect.x + building.rect.w / 2,
		y: building.rect.y + building.rect.h / 2,
	});
	const from = centreOf(subject);

	let best: number | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const building of [...buildings].sort((a, b) => a.index - b.index)) {
		if (building.index === index) continue;
		if (building.required) continue;
		if (already.has(building.index)) continue;
		const to = centreOf(building);
		const distance = (to.x - from.x) ** 2 + (to.y - from.y) ** 2;
		if (distance < bestDistance) {
			bestDistance = distance;
			best = building.index;
		}
	}
	return best;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/gen/features/`
Expected: PASS, including the purity and chunk-order tests.

- [ ] **Step 5: Commit**

```bash
npm run lint:fix && npm run check
git add src/core/gen/features/settlement.ts src/core/gen/features/settlement.test.ts
git commit -m "Take a neighbour down rather than the building the story needs"
```

---

### Task 9: Close the loop

Phase 1 measured. Phase 2 changed the generator. This confirms the measurement moved, and only in the intended direction.

**Files:**
- Modify: `docs/superpowers/plans/2026-08-10-invariants-and-place-solver.md` (the `## Baseline` section)
- Modify: `src/core/gen/features/settlement.test.ts`

- [ ] **Step 1: Write the property test that ties the solver to the invariant**

Append to `src/core/gen/features/settlement.test.ts`:

```ts
it("builds every required structure a town has room for, across many seeds", () => {
	// The property phase 2 exists to establish. Not "every requirement is always built" —
	// a hamlet with four plots cannot hold six halls, and pretending otherwise would be
	// the advisory behaviour again with a new name. The property is that a requirement is
	// never beaten to a plot by filler.
	for (const name of ["fit-a", "fit-b", "fit-c"]) {
		clearFeatureCache();
		const { seed, sites } = sampleSites(name, 3);
		for (const site of sites) {
			const world = worldSeed(seed);
			const patch = generateSettlement(world, site, {
				walled: false,
				structures: [
					{ kind: "inn", size: "small", importance: 1, id: "inn", name: "Inn", required: true },
					...Array.from({ length: 20 }, () => ({
						kind: "house" as const,
						size: "small" as const,
						importance: 5,
					})),
				],
			});

			// A small inn needs the same plot a small house does, so whenever any house was
			// built the inn had a plot available to it and must have taken it first.
			const houses = patch.buildings.filter((b) => b.kind === "house").length;
			if (houses === 0) continue;
			expect(patch.buildings.some((b) => b.required)).toBe(true);
		}
	}
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/core/gen/features/settlement.test.ts`
Expected: PASS. A failure here means filler is still outbidding a requirement — fix `assignPlots` or the wiring, not the test.

- [ ] **Step 3: Re-run the invariant CLI**

Run: `npm run invariants`

Compare against the `## Baseline` section recorded in Task 4, Step 4.

Expected: **`structures-built` violations on the two generated scenarios are unchanged.** This is not a regression — those artifacts were written before `required` existed, so every structure in them is optional and nothing in phase 2 applies. Phase 2 makes a *binding* spec binding; it cannot retroactively make an old spec binding. The number that must not get *worse* is `buildings-reachable`.

- [ ] **Step 4: Record the after-numbers and the honest conclusion**

Append an `## After Phase 2` section to this plan with the new count blocks, and one paragraph stating plainly which invariants moved, which did not, and why. If `buildings-reachable` got worse, stop and investigate before continuing — the neighbour-demolition in Task 8 can open one route while closing another, and that is exactly the kind of change that must not be waved through.

- [ ] **Step 5: Commit**

```bash
npm run lint:fix && npm run check
git add src/core/gen/features/settlement.test.ts docs/superpowers/plans/2026-08-10-invariants-and-place-solver.md
git commit -m "Confirm a requirement is never outbid by filler, and record what moved"
```

---

## What this plan does not do

Named so that nobody goes looking for them:

- **Nothing authors `required`.** The generator honours it, the schema stores it, and hand-written scenarios may now use it — but no pass sets it. That arrives with `src/forge/` in phase 7 of the spec, where the story's requirements are projected into per-place structure requirements.
- **Relations are implemented but unused.** `OnSquare`, `AtEdge`, `OnArrivalStreet`, `Adjacent` and `Isolated` are solved and tested; the wiring in Task 7 passes `relations: []` because no spec field carries them yet. They are built now because the solver is being written now and adding a constraint kind later means re-testing the search.
- **`InsideWall` is deliberately absent.** Every plot is inside the deformed footprint and the wall follows that same outline (`settlement.ts:282-296`), so the relation would be either trivially true or unsatisfiable. It is not worth a branch.
- **The story-side requirement types are not defined here**, though the spec's phase 1 lists
  "define the types". `StoryBible`, `PlaceRequirement`, `CastRequirement`, `SpineBeat` and
  `Yield` have no consumer until `src/forge/` exists, and a file of interfaces nothing reads
  is a file that drifts from the design it claims to encode. The one type from that family
  worth having now is `Relation`, because the solver being written in Task 6 needs it — so it
  lives in `plots.ts`, where it is used. The rest arrive with the pass that reads them.
- **`hidingPlace` is not deleted.** The spec retires it once a required structure is asked for
  on purpose, and nothing asks yet, so removing the fallback now would leave the *existing*
  author pass with no answer when a beat wants a barracks in a town that has none. It goes
  when `src/forge/` replaces `src/ai/author/`.
- **The invariant CLI is not wired into `npm run check`.** It exits non-zero on the current
  scenarios, and a red tree teaches people to ignore the signal. Wire it in once the generated
  scenarios come from `src/forge/`.

## Baseline

**2026-08-10.** `npm run invariants` over all four installed scenarios (`green-chapel`,
`thornwick-road` hand-written; `a-secret-lies-in-the`, `an-interesting-spin-on-the`
generated). Verbatim output:

```
> auto-adventure@0.2.0 invariants
> vite-node src/tools/invariants.ts --

green-chapel — A Blow for a Blow
  structures-built  Camelkeep (site 1144681494): asked for 1 shrine, built 0
  structures-built  Wain Keep (site 1529687061): asked for 1 barn, built 0
  structures-built  Wain Keep (site 1529687061): asked for 2 house, built 0
  structures-built  Wodedesert (site 2340111694): asked for 1 farmhouse, built 0
  structures-built  Wodedesert (site 2340111694): asked for 3 house, built 0
  structures-built  Wodedesert (site 2340111694): asked for 1 inn, built 0
  structures-built  Wodedesert (site 2340111694): asked for 1 shop, built 0
  structures-built  Greyford (site 2447650453): asked for 1 house, built 0
  structures-built  Greyford (site 2447650453): asked for 1 stable, built 0
  structures-built  Heathgate (site 2901334670): asked for 1 farmhouse, built 0
  structures-built  Heathgate (site 2901334670): asked for 3 house, built 1
  structures-built  Stubchapel (site 860455222): asked for 1 farmhouse, built 0
  structures-built  Stubchapel (site 860455222): asked for 3 house, built 2
  structures-built  Stubchapel (site 860455222): asked for 1 mill, built 0
  buildings-reachable  Greyford (site 2447650453): the square itself is not walkable
  FAIL  structures-built: 14
  FAIL  buildings-reachable: 1
  ok    scenes-written: 0
  ok    legs-walkable: 0

a-secret-lies-in-the — Hands Full
  structures-built  Hammerwatch (site 2227307379): asked for 1 smithy, built 0
  structures-built  Bedrock's End (site 3213465016): asked for 1 hall, built 0
  structures-built  Bedrock's End (site 3213465016): asked for 1 house, built 0
  structures-built  Bedrock's End (site 3213465016): asked for 1 inn, built 0
  structures-built  Hearthgate (site 3271006950): asked for 5 house, built 2
  structures-built  The Last Anvil (site 3287834627): asked for 1 barracks, built 0
  structures-built  The Last Anvil (site 3287834627): asked for 1 hall, built 0
  structures-built  The Last Anvil (site 4064606860): asked for 1 farmhouse, built 0
  structures-built  The Last Anvil (site 4064606860): asked for 1 hall, built 0
  structures-built  The Last Anvil (site 4064606860): asked for 2 house, built 0
  structures-built  The Last Anvil (site 4064606860): asked for 1 inn, built 0
  structures-built  The Last Anvil (site 4064606860): asked for 1 temple, built 0
  structures-built  The Last Anvil (site 4064606860): asked for 1 tower, built 0
  structures-built  The Last Anvil (site 4064606860): asked for 1 warehouse, built 0
  scenes-written  beat bellkeeper-rub: no conversation was written for the person this beat hangs on
  legs-walkable  Hammerwatch: 415 tiles in one leg, over the 320 a session tolerates
  FAIL  structures-built: 14
  ok    buildings-reachable: 0
  FAIL  scenes-written: 1
  FAIL  legs-walkable: 1

an-interesting-spin-on-the — The Ash-Stained Crown
  structures-built  Rust-Hollow (site 1278240940): asked for 1 shop, built 0
  structures-built  Salt-Tooth Outpost (site 1677355018): asked for 1 inn, built 0
  structures-built  Salt-Spit Junction (site 3676251433): asked for 1 ruin, built 0
  structures-built  Salt-Spit Junction (site 3676251433): asked for 1 shop, built 0
  structures-built  Rustgutter (site 3986944761): asked for 4 house, built 1
  structures-built  Rustgutter (site 3986944761): asked for 1 warehouse, built 0
  legs-walkable  Rust-Hollow: 431 tiles in one leg, over the 320 a session tolerates
  FAIL  structures-built: 6
  ok    buildings-reachable: 0
  ok    scenes-written: 0
  FAIL  legs-walkable: 1

thornwick-road — The Hollow Tithe
  structures-built  Measurewick (site 1803785688): asked for 2 farmhouse, built 1
  structures-built  Measurewick (site 1803785688): asked for 2 house, built 0
  structures-built  Kilnwait (site 2009483734): asked for 1 house, built 0
  structures-built  Kilnwait (site 2009483734): asked for 1 stable, built 0
  structures-built  Bracken Cross (site 2150566345): asked for 1 barn, built 0
  structures-built  Bracken Cross (site 2150566345): asked for 1 smithy, built 0
  structures-built  Bracken Cross (site 2150566345): asked for 1 warehouse, built 0
  structures-built  Measuregate (site 2165261147): asked for 1 farmhouse, built 0
  structures-built  Measuregate (site 2165261147): asked for 2 house, built 0
  structures-built  Measuregate (site 2165261147): asked for 1 shop, built 0
  structures-built  Tallybastion (site 2309958617): asked for 4 barracks, built 2
  structures-built  Tallybastion (site 2309958617): asked for 1 stable, built 0
  structures-built  Tallybastion (site 2309958617): asked for 1 warehouse, built 0
  structures-built  Brackenholt (site 232432215): asked for 1 shrine, built 0
  structures-built  Harrowmere (site 3139050156): asked for 1 apothecary, built 0
  structures-built  Harrowmere (site 3139050156): asked for 1 inn, built 0
  structures-built  Harrowmere (site 3139050156): asked for 1 mill, built 0
  structures-built  Harrowmere (site 3139050156): asked for 1 shop, built 0
  structures-built  Harrowmere (site 3139050156): asked for 1 smithy, built 0
  structures-built  Harrowmere (site 3139050156): asked for 1 temple, built 0
  structures-built  Harrowmere (site 3139050156): asked for 1 warehouse, built 0
  structures-built  Kilnbarrow (site 3217682817): asked for 3 ruin, built 2
  structures-built  Cord Mere (site 338095591): asked for 2 house, built 0
  structures-built  Bellmere (site 4073541284): asked for 2 house, built 0
  structures-built  Measurewrack (site 4125361648): asked for 3 ruin, built 1
  structures-built  Kilnbridge (site 933820581): asked for 1 farmhouse, built 0
  structures-built  Kilnbridge (site 933820581): asked for 3 house, built 2
  scenes-written  beat the-honest-weight: no conversation was written for the person this beat hangs on
  scenes-written  beat the-weight-in-hand: no conversation was written for the person this beat hangs on
  scenes-written  beat report-the-fraud: no conversation was written for the person this beat hangs on
  FAIL  structures-built: 27
  ok    buildings-reachable: 0
  FAIL  scenes-written: 3
  ok    legs-walkable: 0
```

Counts:

| scenario | structures-built | buildings-reachable | scenes-written | legs-walkable |
|---|---|---|---|---|
| green-chapel (hand-written) | 14 | 1 | 0 | 0 |
| thornwick-road (hand-written) | 27 | 0 | 3 | 0 |
| a-secret-lies-in-the (generated) | 14 | 0 | 1 | 1 |
| an-interesting-spin-on-the (generated) | 6 | 0 | 0 | 1 |

**Reading.** Not zero: the two generated scenarios do show `structures-built` violations
(14 and 6), so the diagnosis this plan is built on — that filler is outbidding requested
structures — is not falsified by this run, and the stop condition in Task 4, Step 4 does
not apply.

But the run does not match the plan's other stated expectation, that the hand-written
scenarios would be "largely clean". They are not: `green-chapel` has *more*
`structures-built` violations than either generated scenario (14, tied with
`a-secret-lies-in-the`), and `thornwick-road` has the worst count of the four (27),
plus 3 `scenes-written` violations. `checkStructuresBuilt` counts by kind, not by
whether a spec was ever meant to be binding — and per "What this plan does not do"
above, `required` has no author today, so every structure in every one of these four
files, hand-written or generated, is advisory. Filler is free to outbid an advisory
request regardless of who wrote the spec, so a high `structures-built` count on
`green-chapel` and `thornwick-road` is consistent with the mechanism the plan
describes, not evidence against it — but it does mean "hand-written vs. generated"
is not the axis this invariant actually splits on, and Phase 2's Task 9 comparison
(Task 4 note: `structures-built` on the two generated scenarios is expected to stay
unchanged after Phase 2, precisely because their specs are all advisory) should be
read with that in mind for the hand-written pair too.

The other three invariants behave as expected: `buildings-reachable` is a single,
narrow fault (`green-chapel`'s Greyford square is not walkable) rather than a systemic
one; `scenes-written` and `legs-walkable` are occasional, not pervasive, in all four
files.

The run took about 6.2 seconds wall-clock for all four scenarios (`6.69s user 0.08s
system 109% cpu 6.187 total`, via `time npm run invariants`). All four scenarios
loaded and reported without a "could not be read" line, and nothing threw; the process
exited 1, as expected with violations present.
