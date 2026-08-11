# Track C, part 1: The Solver Tells the Truth, and the Ground Is Big Enough

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the placement solver throwing away the one signal it produces, measure how many buildings a site can really hold instead of estimating it from a radius, and give sites enough room — by default and by growing the ones that are short — that the story rarely needs rescuing later.

**Architecture:** Four moves, in dependency order. The solver stops failing all-or-nothing and reports what genuinely did not fit. `FeaturePatch` carries that report. The plot computation is *extracted* from the builder so capacity and the builder cannot disagree, and the roster budget becomes the measured number. Then the default radii rise, and the survey grows any site whose real capacity is short of what the model is about to be told it may ask for.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Vitest, Biome. No model calls anywhere in this plan — every line is offline and deterministic.

## Why this is part 1 of three

Track C in `docs/superpowers/specs/2026-08-11-generation-integrity-design.md` is C1–C8. This plan is **C1, C2 and C3**. The remaining two plans are:

- **Part 2 — C4 and C5:** the repair split (`mainLine`, four spatial repairs moving out) and `settleTheStory`, the forward walk that fixes each beat where it stands.
- **Part 3 — C6, C7 and C8:** side-quest fitting, the story adjustment call, and write-only-on-acceptance with the reseed loop.

They are deferred rather than written now, deliberately. Part 2's whole substance is a table of fix tiers keyed to *what a failure actually looks like* — and two of those tiers read `unplaced`, which does not exist yet, and a third depends on what `sitePlots` reports about a site that came up short. Writing that plan now would mean inventing the shape of data this plan is about to create, and then discovering the invention was wrong. Part 1 lands first; Part 2 gets written against the real thing.

This plan produces working, testable software on its own: after it, undersized sites are rarer, the ones that remain are *reported* instead of silent, and nothing downstream has changed behaviour it did not already have.

## Global Constraints

- Node floor `>=18`; ESM with explicit `.js` specifiers on every relative import.
- `exactOptionalPropertyTypes` is on — spread optionals conditionally.
- **Generation is pure in `(seed, recipe)` and must stay that way.** Everything here runs inside chunk generation or the survey; no `Date.now()`, no `Math.random()`, no iteration order that depends on a `Map`'s insertion. Two chunks that disagree about a settlement is the one failure the seam contract cannot absorb.
- The codebase's validator rule (`invariants.ts:15-45`): measure what nothing else measures, or share the question something already asks. **Never ask the same question by two routes** — two routes drift, and a check that disagrees with the thing it validates is worse than no check, because it is believed.
- Verify with `npm run check`. Single file: `npx vitest run <path>`.
- Test names finish the sentence "it …". Never write a test that cannot fail.

## What already exists (verified — do not re-derive)

- `assignPlots` returns `{ assignments, blocked, unplaced }` (`features/plots.ts:76-90`). On a failed search it clears everything and reports **every** required request as unplaced (`plots.ts:252-265`).
- `buildSettlement` destructures `assignments` and `blocked` and **never reads `unplaced`** (`settlement.ts:305-313`). It is dead data: nothing in `src/` reads it.
- `createPatch(id, bounds)` returns the patch plus the live `buildings`/`anchors` arrays aliased into it (`features/patch.ts:100-121`). Four builders call it: `settlement.ts:124`, `castle.ts:66`, `docks.ts:59`, `cave.ts:55`.
- `buildingBudget(site)` is a closed-form function of `site.radius` — `area/110` clamped 2..14 (`world/context.ts:56-66`) — and never runs the plot pass. Its one caller is `siteContext` (`context.ts:109`), and it reaches the model as a hard instruction: `"Give exactly ${context.buildingBudget} structures"` (`director/prompt.ts:181`), with `peopleWanted` derived from it (`prompt.ts:141`).
- Real plots come from a BSP over a `radius * 1.56` square, keeping leaves ≥5×5 that are fully on buildable ground and clear of the plaza (`settlement.ts:206-260`).
- `macroSite` takes an authored place's radius over the computed one (`macro.ts:86`), keeps the cell's id and region, and sets `authored: true`. `maxFeatureRadius` folds authored radii into the halo assertion (`macro.ts:206`), which `validate.ts:271-279` checks against `HALO * MACRO = 128`.
- `PlaceRecipeSchema` allows `radius` up to `HALO * CHUNK` = 128 (`recipe-schema.ts:208-213`). `SiteRecipeSchema.radius.base` is capped at **64**, commented *"64 is one macro cell; a base beyond that guarantees neighbours overlap"* (`recipe-schema.ts:171-175`).
- The survey filters sites through `buildsSomething` (`survey.ts:121-129`), which accepts any patch with ≥1 building **or ≥1 anchor** — and `buildSettlement` always emits a `square` and a `well`, so a buildingless town passes.
- `fallbackSettlementSpec` builds the deterministic roster from `rules.sites.roster[kind]` and `structureCount(rule, importance)` (`features/fallback-spec.ts:53-69`).

### The two findings that shape this plan

**1. An overlap check already exists, and growth would newly trigger it.** `validate.ts:307-321` walks every *authored* place and warns when it overlaps a rolled site — `` `${place} overlaps ${name} by N tiles` ``. It skips authored-vs-authored (`if (site.authored) continue`). Growth works by pinning a site as an authored place, so **every grown site becomes subject to that warning**. Two consequences the tasks below handle: the growth ceiling has to respect the same overlap notion or generated worlds will fill with warnings; and the predicate must be *shared* rather than reimplemented, per the rule above.

**2. Nothing checks spacing between two rolled sites.** One site per macro cell, jittered to within `MACRO * 0.22` ≈ 14 tiles of the cell edge (`macro.ts:93-99`), so two adjacent centres can be ~28 tiles apart while a town already reaches 35. Today that is unreported. This plan does **not** retrospectively forbid it — that would fail existing worlds — but growth must not add to it.

---

## File Structure

**Created:**
- `src/core/gen/features/plots-capacity.test.ts` — the agreement test between `sitePlots` and the builder. Its own file because it is the load-bearing test of the whole track and deserves to be findable.
- `src/core/world/spacing.ts` — the one overlap predicate, shared by the survey's growth ceiling and `validate.ts`. Lives in `core/world` because both callers are above it and neither may depend on the other.
- `src/core/world/spacing.test.ts`

**Modified:**
- `src/core/gen/features/plots.ts` — greedy fallback instead of all-or-nothing.
- `src/core/gen/features/patch.ts` — `unplaced` on `FeaturePatch` and `createPatch`.
- `src/core/gen/features/settlement.ts` — export `sitePlots`; use it; report `unplaced`.
- `src/core/world/context.ts` — `buildingBudget` takes the world and measures.
- `src/core/world/recipe.ts:441-452` — `DEFAULT_RADIUS`.
- `src/scenario/validate.ts:307-321` — use the shared predicate.
- `src/scenario/survey.ts` — growth, and a tightened `buildsSomething`.
- `.scenarios/an-interesting-spin-on-the.json`, `.scenarios/green-chapel.json`, `.scenarios/thornwick-road.json` — pin today's radii.
- Existing tests: `src/core/gen/features/plots.test.ts`, `settlement.test.ts`, `src/scenario/survey.test.ts`, and the goldens under `test/goldens/`.

---

### Task 1: The solver places what it can, and names what it could not

Today a search that cannot satisfy every required request throws away the ones it *could* have satisfied and reports all of them unplaced — so a town short of one required building gets filler for all of them, which is precisely the substitution `plots.ts` was written to prevent, arriving one layer down.

**Files:**
- Modify: `src/core/gen/features/plots.ts:242-265`
- Test: `src/core/gen/features/plots.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `assignPlots` unchanged in signature; `unplaced` now lists only requests genuinely not placed, and `assignments` keeps whatever was placed. Task 2 reads `unplaced`.

- [ ] **Step 1: Write the failing test**

`src/core/gen/features/plots.test.ts` already has the two fixtures these need: `context(sizes)` builds a row of square plots of the given sizes, spaced 40 apart, and `request(over)` fills in a `PlotRequest` around whatever you override. Use them.

Two small plots and one demand for a large building is the shape: a `hall` at `medium` needs more than a 6×6, so sizes `[13, 13, 6]` give two that fit and one that does not.

```ts
	it("places the requirements it can when one of them will not fit", () => {
		// The old behaviour threw away the two that fitted along with the one that did not,
		// so a town short of a single required building got filler for all three — which is
		// the substitution this module exists to prevent, one layer further down.
		const ctx = context([13, 13, 6]);
		const solution = assignPlots(ctx, [
			request({ id: "chapel", kind: "chapel", size: "medium", required: true }),
			request({ id: "forge", kind: "forge", size: "medium", required: true }),
			request({ id: "keep", kind: "keep", size: "large", required: true }),
		]);

		expect(solution.unplaced).toEqual(["keep"]);
		expect(solution.assignments.map((a) => a.request.id).sort()).toEqual(["chapel", "forge"]);
	});

	it("still reports nothing unplaced when every requirement fits", () => {
		const ctx = context([13, 13]);
		const solution = assignPlots(ctx, [
			request({ id: "chapel", kind: "chapel", size: "medium", required: true }),
			request({ id: "forge", kind: "forge", size: "medium", required: true }),
		]);
		expect(solution.unplaced).toEqual([]);
		expect(solution.assignments).toHaveLength(2);
	});

	it("answers the same way whatever order the requests arrive in", () => {
		// The property the whole module rests on: this runs inside settlement generation, so
		// two chunks that disagreed about which building went where would disagree about the
		// town. The fallback below is greedy, which is exactly where an order dependence
		// would creep back in.
		const ctx = () => context([13, 13, 6]);
		const chapel = request({ id: "chapel", kind: "chapel", size: "medium", required: true });
		const forge = request({ id: "forge", kind: "forge", size: "medium", required: true });
		const keep = request({ id: "keep", kind: "keep", size: "large", required: true });

		const forwards = assignPlots(ctx(), [chapel, forge, keep]);
		const backwards = assignPlots(ctx(), [keep, forge, chapel]);

		expect(backwards.unplaced).toEqual(forwards.unplaced);
		expect(backwards.assignments.map((a) => [a.plot, a.request.id])).toEqual(
			forwards.assignments.map((a) => [a.plot, a.request.id]),
		);
	});
```

`context()` is called freshly for each run above because `assignPlots` reads `context.plots` and the `blocked` pass iterates it — sharing one object between two solves would be fine today and is the kind of thing that stops being fine. Check `minimumPlot(kind, size)` for the kinds you pick and adjust the sizes if `chapel`/`forge`/`keep` do not have the footprints assumed here; the point of the fixture is that two fit and one does not, not the specific trades.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/gen/features/plots.test.ts`

Expected: FAIL — the first reports all three unplaced and no assignments.

- [ ] **Step 3: Replace the all-or-nothing branch with a greedy fallback**

In `src/core/gen/features/plots.ts`, replace the `else` branch of `if (solved)`:

```ts
	if (solved) {
		for (const request of ordered) {
			const index = chosen.get(request.id);
			if (index === undefined) unplaced.push(request.id);
			else assignments.push({ plot: index, request });
		}
	} else {
		/*
		 * No assignment satisfies every requirement at once, so take what can be had.
		 *
		 * The old branch reported *all* of them unplaced and cleared the map, on the
		 * grounds that a half-solution hides which half is missing. That is true of the
		 * report and false of the town: a settlement short of one required building was
		 * given filler for every one of them, which is the substitution this module exists
		 * to prevent, arriving one layer further down and unremarked.
		 *
		 * Greedy over `ordered`, which is sorted on explicit keys — fewest candidate plots,
		 * then importance, then id — so this is a function of the inputs and not of the
		 * order the caller happened to pass them in. Same relations, same isolation, same
		 * `placed` list as the search above, so a plot taken here constrains what comes
		 * after it exactly as it would have during the search.
		 */
		for (const request of ordered) {
			const index = plots.findIndex((plot, i) => {
				if (taken.has(i) || !fitsSize(plot, request)) return false;
				if (!request.relations.every((relation) => holds(relation, plot, chosen))) return false;
				return respectsIsolation(request, plot);
			});
			if (index < 0) {
				unplaced.push(request.id);
				continue;
			}
			taken.add(index);
			chosen.set(request.id, index);
			placed.push({ request, index });
			assignments.push({ plot: index, request });
		}
	}
```

Note the `Adjacent` caveat this inherits: `holds` allows an unmeasurable `Adjacent` through when its target is not yet placed, and the greedy pass has no `verified` sweep at the end. That is the right trade here — the alternative is refusing a building because a relation could not be checked, which is the deletion the whole track is trying to stop — but say so where it happens:

```ts
			// `Adjacent` to something that never got placed is allowed through, unlike in the
			// search above, which verifies the finished assignment. Placing a building slightly
			// further from its neighbour than asked is a worse world; not placing it at all is a
			// missing one, and this branch only runs when the good answer is already gone.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/gen/features && npm run typecheck`

Expected: PASS. `settlement.test.ts` should be unaffected — nothing reads `unplaced` yet.

- [ ] **Step 5: Commit**

```bash
git add src/core/gen/features/plots.ts src/core/gen/features/plots.test.ts
git commit -m "Place the requirements that fit, rather than none of them

A search that could not satisfy every required request threw away the ones it
could have, and reported all of them unplaced. The reasoning was that a half
solution hides which half is missing — true of the report, false of the town: a
settlement one building short got filler for every one of them, which is the
substitution this module exists to prevent, arriving a layer down and
unremarked.

The fallback is greedy over the same explicitly-sorted list the search uses, so
it stays a function of the inputs rather than of argument order — which matters
more here than usual, since two chunks that disagreed would disagree about the
town.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The patch carries what did not fit

**Files:**
- Modify: `src/core/gen/features/patch.ts:90-121`
- Modify: `src/core/gen/features/settlement.ts:305-313`
- Test: `src/core/gen/features/settlement.test.ts`

**Interfaces:**
- Consumes: `assignPlots`'s `unplaced` (Task 1).
- Produces: `FeaturePatch.unplaced: readonly string[]` — the structure ids from the spec that no plot could take. Empty for every builder that is not a settlement. Part 2's growth tier reads it.

- [ ] **Step 1: Write the failing test**

In `src/core/gen/features/settlement.test.ts`:

```ts
	it("says which required structures did not fit, instead of quietly building filler", () => {
		// The signal the solver has always produced and nobody has ever read. Without it the
		// only evidence that the story's counting house became a shack is the shack.
		const world = worldSeed(hashString("cramped"));
		const site = { ...someSmallSite(world), radius: 8 };
		const patch = generateSettlement(world, site, {
			walled: false,
			structures: [
				{ kind: "keep", size: "large", importance: 5, id: "keep", required: true },
				{ kind: "chapel", size: "large", importance: 5, id: "chapel", required: true },
				{ kind: "hall", size: "large", importance: 5, id: "hall", required: true },
			],
		});

		expect(patch.unplaced.length).toBeGreaterThan(0);
		// And it names them, so a report can say which building the story lost.
		expect(patch.unplaced.every((id) => ["keep", "chapel", "hall"].includes(id))).toBe(true);
	});

	it("reports nothing unplaced for a settlement that fitted its whole roster", () => {
		const world = worldSeed(hashString("roomy"));
		const site = someLargeSite(world);
		const patch = generateSettlement(world, site, fallbackSettlementSpec(world, site));
		expect(patch.unplaced).toEqual([]);
	});
```

`settlement.test.ts` gets its sites from `sampleSites(seedName, radius)`, which returns `{ seed, sites }` — use it rather than calling `macroSite` directly, and override `radius` on the site you pick, as the fixture above does.

**The first test must actually fail before the fix**, and it will not fail for the reason you expect: before Task 2 the property does not exist, so it fails to compile. After Task 2 it must still fail *if the radius is generous* — so pick one small enough that three large required structures genuinely cannot fit, and confirm by checking `patch.unplaced.length` is non-zero rather than assuming it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/gen/features/settlement.test.ts`

Expected: FAIL — `patch.unplaced` is not a property of `FeaturePatch`.

- [ ] **Step 3: Add the field and wire it through**

In `src/core/gen/features/patch.ts`, add to `FeaturePatch` after `anchors`:

```ts
	/**
	 * Ids of structures the spec required that no plot could take.
	 *
	 * Empty for the builders that lay out their own buildings from their own rules — a
	 * castle's ward and a dock's row of sheds are not solved against a roster. For a
	 * settlement it is `assignPlots`'s own verdict, carried rather than discarded: it was
	 * computed for three years and read by nothing, so the only evidence that the story's
	 * counting house had become a shack was the shack.
	 */
	readonly unplaced: readonly string[];
```

and in `createPatch`, alias a live array the same way `buildings` and `anchors` are:

```ts
	const buildings: BuildingPlacement[] = [];
	const anchors: Anchor[] = [];
	const unplaced: string[] = [];
	return {
		patch: {
			id,
			bounds,
			terrain: new Uint16Array(size),
			decor: new Uint16Array(size),
			flags: new Uint8Array(size),
			buildings,
			anchors,
			unplaced,
		},
		buildings,
		anchors,
		unplaced,
	};
```

Widen the return type to include `unplaced: string[]`. The other three builders (`castle.ts:66`, `docks.ts:59`, `cave.ts:55`) destructure only what they use, so they get an empty array for free and need no edit.

In `src/core/gen/features/settlement.ts`, take it from `createPatch` and fill it from the solution:

```ts
	const { patch, buildings, anchors, unplaced } = createPatch(site.id, bounds);
```

and after `const solution = assignPlots(...)`:

```ts
	// Carried out of here rather than dropped. `plots.ts` computes this and, until now,
	// nothing anywhere read it — so a settlement that silently substituted filler for the
	// building the story sends the player to find looked exactly like one that did not.
	unplaced.push(...solution.unplaced);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/gen && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/gen/features/patch.ts src/core/gen/features/settlement.ts src/core/gen/features/settlement.test.ts
git commit -m "Carry the solver's verdict out of the settlement builder

assignPlots has always computed which required structures no plot could take,
and buildSettlement has always destructured past it. Nothing in the codebase
read it, so the only evidence that the story's counting house had become a
shack was the shack.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Measure the plots instead of estimating them

The highest-risk change in the whole track, and the one everything after it rests on. The rule: **extract, do not reimplement.** A capacity function that can disagree with the builder is worse than the estimate it replaces, because it would be believed.

**Files:**
- Modify: `src/core/gen/features/settlement.ts:126-260`
- Create: `src/core/gen/features/plots-capacity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sitePlots(world: WorldSeed, site: MacroSite): readonly Rect[]`, exported from `settlement.ts` — the plots `buildSettlement` will use, in the same order. Tasks 4 and 6 call it.

- [ ] **Step 1: Write the failing test**

Create `src/core/gen/features/plots-capacity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashString } from "../../rand/hash.js";
import { macroSite } from "../../world/macro.js";
import { worldSeed } from "../../world/recipe.js";
import { fallbackSettlementSpec } from "./fallback-spec.js";
import { generateSettlement, sitePlots } from "./settlement.js";
import { invalidateFeature } from "./registry.js";

/**
 * What a site can hold, and what it actually held.
 *
 * The load-bearing test of the whole placement track. Capacity is used to decide how many
 * structures the model may ask for and whether a site needs to be grown, so a capacity
 * function that can disagree with the builder is worse than the arithmetic estimate it
 * replaces — that one was obviously a guess, and this one would be believed.
 *
 * The two are kept honest by construction rather than by hope: `buildSettlement` calls
 * `sitePlots`. This checks that it stayed that way.
 */

/** Enough seeds and cells to cross coast, slope, river and open ground. */
const CASES = [
	{ seed: "alpha", mx: 0, my: 0 },
	{ seed: "alpha", mx: 3, my: -2 },
	{ seed: "harrow", mx: 1, my: 1 },
	{ seed: "harrow", mx: -4, my: 5 },
	{ seed: "vale", mx: 7, my: -6 },
	{ seed: "vale", mx: -1, my: 2 },
	{ seed: "cramped", mx: 2, my: 2 },
	{ seed: "cramped", mx: -3, my: -3 },
] as const;

describe("what a settlement site can hold", () => {
	it.each(CASES.map((c) => [`${c.seed} ${c.mx},${c.my}`, c] as const))(
		"%s builds on the plots it reported and no others",
		(_name, testCase) => {
			const world = worldSeed(hashString(testCase.seed));
			const site = macroSite(world, testCase.mx, testCase.my);
			if (site.kind === "none") return;

			const plots = sitePlots(world, site);
			invalidateFeature(world, site.id);
			const patch = generateSettlement(world, site, fallbackSettlementSpec(world, site));

			// Every building stands inside one of the reported plots. Not equality of counts:
			// the builder drops a plot whose fitted rectangle came out under 5x5, and prunes
			// what it could not reach — both are reductions, never additions. A building
			// *outside* every reported plot is the failure this exists to catch, and it means
			// capacity is describing a layout the builder is not using.
			for (const building of patch.buildings) {
				const inside = plots.some(
					(plot) =>
						building.rect.x >= plot.x &&
						building.rect.y >= plot.y &&
						building.rect.x + building.rect.w <= plot.x + plot.w &&
						building.rect.y + building.rect.h <= plot.y + plot.h,
				);
				expect(inside, `a building stood outside every plot sitePlots reported`).toBe(true);
			}
			expect(patch.buildings.length).toBeLessThanOrEqual(plots.length);
		},
	);

	it("answers the same way twice, because generation is pure in seed and recipe", () => {
		const world = worldSeed(hashString("alpha"));
		const site = macroSite(world, 0, 0);
		expect(sitePlots(world, site)).toEqual(sitePlots(world, site));
	});

	it("reports nothing for ground with nowhere to build", () => {
		// A site the sea or the slope leaves no room on. The survey drops these; without a
		// zero here it would keep naming them and hanging beats on them.
		const world = worldSeed(hashString("alpha"));
		const site = { ...macroSite(world, 0, 0), radius: 3 };
		expect(sitePlots(world, site)).toHaveLength(0);
	});
});
```

The last case assumes a radius-3 footprint cannot yield a 5×5 plot clear of the plaza. Check that holds; if a radius of 3 still yields one, lower it until it does not, and say in a comment why that number.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/gen/features/plots-capacity.test.ts`

Expected: FAIL — `sitePlots` is not exported from `./settlement.js`.

- [ ] **Step 3: Extract, and have the builder call it**

In `src/core/gen/features/settlement.ts`, lift the footprint, BSP and plot filter out of `buildSettlement` into an exported function. It needs the rng, and the rng is `rngFor(world.seed, "settlement", site.mx, site.my)` — a pure function of the same inputs — so build it inside rather than threading it in, and note that this is what keeps the two callers identical:

```ts
/**
 * The plots a settlement will be laid out on.
 *
 * Extracted from `buildSettlement` rather than written beside it, and `buildSettlement`
 * calls this — that is the whole point. Capacity decides how many structures the model may
 * ask for and whether a site has to be grown, so a second implementation that drifted from
 * the builder would be a lie told confidently, where the arithmetic estimate it replaces
 * was at least obviously a guess.
 *
 * Pure in `(world, site)`: the rng is rebuilt here from the same seed and cell the builder
 * uses, so asking twice gives the same answer and asking here gives the answer the builder
 * will get. Largest first, which is the order the assignment pass expects.
 */
export function sitePlots(world: WorldSeed, site: MacroSite): readonly Rect[] {
	// …the body currently spanning `const rng = …` through the `.sort(...)` that produces
	// `plots`, returning `plots`.
}
```

Then in `buildSettlement`, replace the extracted block with `const plots = sitePlots(world, site);`.

**The care this needs.** The extracted region and the builder both consume `rng`, and `rng` is a *stream* — every `rng.float()` advances it. If `sitePlots` builds its own rng and `buildSettlement` also builds its own and then continues drawing from it, the draws after the extraction point must line up exactly with what they were before, or every settlement in every world changes shape. Two ways to be sure:

1. Have `buildSettlement` call `sitePlots` and keep its own `rng` for everything after, accepting that the *sequence* changed — then update the goldens and read the diff.
2. Have `sitePlots` return the rng alongside the plots so the builder continues the same stream, keeping every existing world byte-identical.

**Take (1).** Option (2) makes the capacity function's return value carry a mutable stream, which is exactly the kind of shared state that makes two callers disagree later. The goldens exist to be read when generation changes deliberately (`golden.test.ts:9-16` says so outright), and this is such a change. Run `npx vitest run -u src/core/gen/golden.test.ts` and **read the diff** — a coastline that moved is wrong and means the extraction changed more than the rng sequence; towns that re-laid-out are expected.

- [ ] **Step 4: Run the tests, update the goldens, read the diff**

```bash
npx vitest run src/core/gen/features/plots-capacity.test.ts
npx vitest run -u src/core/gen/golden.test.ts
git diff --stat test/goldens/
git diff test/goldens/ | head -120
```

Expected: the capacity test PASSES. The goldens change only inside settlement footprints — buildings and streets moved. If terrain outside any town changed, stop: the extraction altered more than the rng sequence and something has been moved that should not have been.

- [ ] **Step 5: Run everything**

Run: `npm run check`

Expected: `coherence.test.ts` and `seam.test.ts` may also need `-u`; the shipped scenario tests must still pass — those worlds pin their own radii and their content is keyed to site *ids*, which do not change.

If a shipped scenario test fails here, that is a real finding and not a snapshot to update: it means a re-laid-out town lost a building an authored artifact names. Report it rather than papering over it.

- [ ] **Step 6: Commit**

```bash
git add src/core/gen/features/settlement.ts src/core/gen/features/plots-capacity.test.ts test/goldens
git commit -m "Measure a site's plots by asking the thing that builds them

Capacity decides how many structures the model may ask for and whether a site
has to be grown, so a second implementation that drifted from the builder would
be a lie told confidently — where the arithmetic estimate it replaces was at
least obviously a guess. So buildSettlement calls sitePlots rather than the two
sharing a shape by convention, and a test asserts every building stands inside
a plot that was reported.

The goldens move: extracting the block changes where the rng stream is drawn
from, so towns re-lay-out. Terrain outside them is unchanged, which is the thing
worth checking in that diff.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The roster budget becomes the measured number

**Files:**
- Modify: `src/core/world/context.ts:56-66,109`
- **Create**: `src/core/world/context.test.ts` — verified absent; `core/world` has tests for `brief`, `recipe`, `recipe-schema` and `roster` but none for `context`.

**Interfaces:**
- Consumes: `sitePlots` (Task 3).
- Produces: `buildingBudget(world: WorldSeed, site: MacroSite): number` — **signature change**, gains `world`. Its one caller `siteContext` already has one.

- [ ] **Step 1: Write the failing test**

```ts
	it("never promises more buildings than the ground can hold", () => {
		// The budget reaches the model as "give exactly N structures", so an estimate that
		// overshoots is a roster the town cannot take — and the tail of it silently becomes
		// filler, which is the fault the whole placement track is about.
		const world = worldSeed(hashString("coastal"));
		const site = macroSite(world, CRAMPED.mx, CRAMPED.my);
		expect(buildingBudget(world, site)).toBeLessThanOrEqual(sitePlots(world, site).length);
	});

	it("still caps a roomy site by the formula rather than by its plot count", () => {
		// Measuring is a ceiling, not a target: a huge site with thirty plots should not be
		// asked for thirty buildings, because the roster is also a cast list and a story.
		const world = worldSeed(hashString("roomy"));
		const site = { ...macroSite(world, 0, 0), kind: "town" as const, radius: 40 };
		expect(buildingBudget(world, site)).toBeLessThan(sitePlots(world, site).length);
	});
```

`CRAMPED` is a seed and cell whose site genuinely has fewer plots than the formula predicts — find one by iterating cells in a scratch script and pin it with a comment saying what it is (coastal, steep, river-cut). **If no such cell exists in a reasonable search, say so and reconsider the task**: it would mean the estimate never overshoots, and this task is unnecessary.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/world/context.test.ts`

Expected: FAIL — `buildingBudget` takes one argument.

- [ ] **Step 3: Measure**

```ts
/**
 * Rough building capacity of a site, and then what the ground will actually take.
 *
 * The formula is a ceiling on *ambition* — a big town still gets a dozen buildings and not
 * thirty, because the roster is a cast list and a story as well as a row of houses. The
 * measurement is a ceiling on *possibility*, and it is the half that was missing: this
 * number reaches the model as "give exactly N structures" (`director/prompt.ts:181`), so on
 * a coastal or steep site the estimate was a promise the ground could not keep, and the
 * tail of the roster silently became filler.
 *
 * `peopleWanted` is derived from this too (`prompt.ts:141`), so a site with fewer real
 * plots is now asked for fewer people as well — which is right: they had nowhere to live.
 */
export function buildingBudget(world: WorldSeed, site: MacroSite): number {
	const wanted = ambition(site);
	if (!isSettlement(site.kind)) return wanted;
	return Math.min(wanted, sitePlots(world, site).length);
}

/** What a site of this kind and size is worth asking for, before the ground has a say. */
function ambition(site: MacroSite): number {
	if (site.kind === "cave") return 0;
	if (site.kind === "castle") return Math.max(3, Math.min(10, Math.round(site.radius / 3)));
	if (site.kind === "docks") return Math.max(2, Math.min(6, Math.round(site.radius / 4)));
	if (!isSettlement(site.kind)) return site.kind === "ruins" ? 3 : 1;
	const area = site.radius * site.radius * 1.9;
	return Math.max(2, Math.min(24, Math.round(area / 110)));
}
```

Note the clamp rises from 14 to 24, for the larger radii in Task 5. Only settlements are measured: `castle`, `docks` and `cave` lay out their own buildings from their own rules and `sitePlots` does not describe them.

Update `siteContext` to `buildingBudget(world, site)`. Beware the import cycle — `context.ts` is in `core/world` and `settlement.ts` is in `core/gen/features`, which already imports `world/macro.js`. Check the direction before adding the import; if it cycles, move `sitePlots` to its own module under `core/gen/features/` that neither imports the other, and say so in the commit.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/world/context.ts src/core/world/context.test.ts
git commit -m "Ask for as many buildings as the ground will take

The budget reaches the model as "give exactly N structures", and it was
arithmetic on a radius that never asked whether the ground was buildable — so
on a coastal or steep site it was a promise the town could not keep, and the
tail of the roster silently became filler.

The formula stays as a ceiling on ambition: a big town gets a dozen buildings
and not thirty, because a roster is a cast list and a story as well as a row of
houses. What is new is the second ceiling, on possibility.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Bigger sites by default, with the old worlds pinned

**Files:**
- Modify: `src/core/world/recipe.ts:441-452`
- Modify: `.scenarios/an-interesting-spin-on-the.json`, `.scenarios/green-chapel.json`, `.scenarios/thornwick-road.json`
- Test: `src/scenario/shipped.test.ts` (already exists and validates the shipped scenarios)

**Interfaces:**
- Consumes: nothing.
- Produces: larger `DEFAULT_RADIUS`. Task 6's growth ceiling is relative to it.

- [ ] **Step 1: Pin the existing worlds first**

Do this **before** touching the defaults, and run the tests in between — that way a failure afterwards is unambiguously the new numbers and not the pinning.

For each of the three artifacts, add a `sites.radius` to its `recipe` holding today's values:

```json
			"radius": {
				"town": { "base": 20, "perImportance": 3 },
				"village": { "base": 14, "perImportance": 2 },
				"fort": { "base": 13, "perImportance": 1 },
				"hamlet": { "base": 9, "perImportance": 1 },
				"ruins": { "base": 10, "perImportance": 1 },
				"camp": { "base": 6 },
				"landmark": { "base": 4 },
				"castle": { "base": 18, "perImportance": 2 },
				"docks": { "base": 12, "perImportance": 1 },
				"cave": { "base": 6 }
			}
```

`a-secret-lies-in-the.json` already carries its own and is left alone. Merge into the existing `recipe.sites` object rather than adding a second one, and keep the file's formatting — it is written with tabs by `writeScenario`.

Run: `npm run check`

Expected: PASS with nothing changed — pinning today's numbers is a no-op by construction. **If anything fails here, stop**: it means the pinned values do not match the live defaults, and the whole point of this step is that they do.

- [ ] **Step 2: Write the failing test**

In `src/scenario/shipped.test.ts` or beside the recipe tests:

```ts
	it("gives a town room for the roster a town is asked for", () => {
		// The estimate and the ground used to disagree most on the sites the story cares
		// about most. Bigger baselines are the cheap half of closing that: plots go as the
		// square of the radius, so a third more radius is most of a doubling.
		const world = worldSeed(hashString("alpha"));
		const town = { ...macroSite(world, 0, 0), kind: "town" as const, importance: 3 };
		expect(siteRadiusFor(world.rules, "town", 3)).toBeGreaterThanOrEqual(28);
	});

	it("keeps every kind inside the halo a chunk actually consults", () => {
		// The one failure the seam contract cannot absorb: a feature reaching further than
		// the halo looks exists in some chunks and not in others.
		expect(maxFeatureRadius(worldSeed(hashString("alpha")).rules)).toBeLessThanOrEqual(
			HALO * MACRO,
		);
	});

	it("leaves a scenario that pinned its own radii exactly as it was", () => {
		const artifact = loadScenario("green-chapel");
		expect(artifact?.recipe?.sites?.radius?.town?.base).toBe(20);
	});
```

`siteRadiusFor` is not exported today — either export `siteRadius` from `macro.ts` or assert through `macroSite(...).radius` on a cell known to hold a town. Prefer the latter; do not widen a module's API for a test if the behaviour is reachable.

- [ ] **Step 3: Raise the defaults**

In `src/core/world/recipe.ts`:

```ts
/**
 * How big each kind of place is, before a recipe has its say.
 *
 * Raised across the board, because the number that mattered was never the radius but the
 * *plots*, and plots go as its square: the old town at 20 held around seven, of which a
 * coastal or steep site kept rather fewer, against a roster the model was told to fill
 * exactly. A third more radius is most of a doubling, which turns "the tail of the roster
 * became filler" from the common case into an unusual one.
 *
 * Bounded twice over. `SiteRecipeSchema` caps a base at 64 — one macro cell, beyond which
 * neighbours are guaranteed to overlap — and `maxFeatureRadius` is asserted against the
 * halo at `HALO * MACRO`, 128. The largest here is a town at importance 5, which is 48.
 *
 * Corroborated rather than guessed: the one generated scenario whose recipe the model wrote
 * itself chose town 26, village 20, hamlet 12, which is close to this and higher than what
 * it replaced. Given the choice, the author asks for more room.
 */
const DEFAULT_RADIUS: Record<SettledKind, RadiusRule> = {
	town: { base: 28, perImportance: 4 },
	village: { base: 20, perImportance: 3 },
	fort: { base: 18, perImportance: 2 },
	hamlet: { base: 13, perImportance: 2 },
	ruins: { base: 14, perImportance: 2 },
	camp: { base: 9 },
	landmark: { base: 6 },
	castle: { base: 24, perImportance: 3 },
	docks: { base: 16, perImportance: 2 },
	cave: { base: 9 },
};
```

- [ ] **Step 4: Run everything, update goldens, read the diff**

```bash
npm run check
npx vitest run -u src/core/gen
git diff test/goldens/ | head -160
```

Expected: goldens change wherever a town's footprint grew. The shipped scenario tests must still pass, because all four artifacts now pin their own radii.

**Watch for a new class of warning.** `validate.ts:307-321` warns when an authored place overlaps a rolled site, and bigger radii make that likelier for the two hand-authored scenarios — but those pin the old numbers, so they should be silent. If they are not, the pinning in Step 1 is incomplete.

- [ ] **Step 5: Commit**

```bash
git add src/core/world/recipe.ts .scenarios test/goldens src/scenario/shipped.test.ts
git commit -m "Give every kind of place more room

The number that mattered was never the radius but the plots, and plots go as
its square: the old town at 20 held around seven, of which a coastal or steep
site kept fewer, against a roster the model was told to fill exactly. A third
more radius is most of a doubling.

The four existing scenarios pin today's numbers in their own recipes, so their
worlds are untouched and no live test is re-baselined. They already pinned their
places; this makes the rest of it explicit rather than inherited.

Corroboration rather than taste: the one scenario whose recipe a model wrote
for itself chose town 26, village 20, hamlet 12 — higher than what this
replaces, and close to what it becomes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Grow the sites that are still short, and drop the ones that build nothing

**Files:**
- Create: `src/core/world/spacing.ts`
- Create: `src/core/world/spacing.test.ts`
- Modify: `src/scenario/survey.ts`
- Modify: `src/scenario/validate.ts:307-321`
- Test: `src/scenario/survey.test.ts`

**Interfaces:**
- Consumes: `sitePlots` (Task 3), `buildingBudget` (Task 4).
- Produces: `overlapBy(a: {at: Vec2; radius: number}, b: {at: Vec2; radius: number}): number` in `spacing.ts` — tiles of overlap, ≤0 meaning clear. `Survey` gains `grown: Readonly<Record<string, number>>`, site name or id to new radius, for the progress line. The survey's `world` carries the grown radii in its recipe.

- [ ] **Step 1: Write the failing tests**

`src/core/world/spacing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { overlapBy } from "./spacing.js";

/**
 * How close two places may stand.
 *
 * One predicate, used by the survey to decide whether a site may grow and by the validator
 * to report a recipe that put two places on top of each other. Two implementations of this
 * would drift, and the survey would grow a site into an overlap the validator then
 * complained about — a generator arguing with its own checker.
 */

describe("how much two footprints overlap", () => {
	it("is zero or less when they stand clear of each other", () => {
		expect(overlapBy({ at: { x: 0, y: 0 }, radius: 10 }, { at: { x: 40, y: 0 }, radius: 10 })).toBeLessThanOrEqual(0);
	});

	it("counts the tiles by which they intrude on each other", () => {
		expect(overlapBy({ at: { x: 0, y: 0 }, radius: 20 }, { at: { x: 30, y: 0 }, radius: 20 })).toBe(10);
	});

	it("does not care which is given first", () => {
		const a = { at: { x: 0, y: 0 }, radius: 20 };
		const b = { at: { x: 30, y: 0 }, radius: 15 };
		expect(overlapBy(a, b)).toBe(overlapBy(b, a));
	});
});
```

`src/scenario/survey.test.ts`:

```ts
	it("grows a site whose ground holds less than its roster asks for", () => {
		// The fix at source. Without it the model is told to write eight buildings for a town
		// with four plots, and four of them quietly become filler.
		const world = worldSeed(hashString(CRAMPED_SEED));
		const survey = surveyWorld(world, "short");
		const grown = Object.keys(survey.grown);
		expect(grown.length).toBeGreaterThan(0);
		for (const id of grown) {
			const site = survey.sites.find((entry) => String(entry.site.id) === id);
			expect(site && sitePlots(survey.world, site.site).length).toBeGreaterThanOrEqual(
				site ? buildingBudget(survey.world, site.site) : 0,
			);
		}
	});

	it("will not grow a site into its neighbour", () => {
		// Growth is bounded by the same predicate the validator reports on, so the generator
		// cannot produce a world its own checker complains about.
		const survey = surveyWorld(worldSeed(hashString(CROWDED_SEED)), "medium");
		for (const a of survey.sites) {
			for (const b of survey.sites) {
				if (a.site.id === b.site.id) continue;
				expect(
					overlapBy(
						{ at: a.site.site, radius: a.site.radius },
						{ at: b.site.site, radius: b.site.radius },
					),
				).toBeLessThanOrEqual(CLEARANCE_ALLOWED);
			}
		}
	});

	it("keeps a grown site in the recipe, so the world survives being reloaded", () => {
		// Growth that lived only in the survey would be a town that shrank the next time the
		// artifact was opened, with every placement written against the larger one.
		const survey = surveyWorld(worldSeed(hashString(CRAMPED_SEED)), "short");
		const [id] = Object.keys(survey.grown);
		if (!id) return;
		const site = survey.sites.find((entry) => String(entry.site.id) === id);
		const reloaded = macroSite(survey.world, site?.site.mx ?? 0, site?.site.my ?? 0);
		expect(reloaded.radius).toBe(site?.site.radius);
	});

	it("drops a site the ground will not let build anything", () => {
		// `buildsSomething` accepted a patch with any anchor, and every settlement emits a
		// square and a well — so a town with no buildings at all was named, peopled and given
		// story beats. This is the todo.txt case: Wodedesert, Wain Keep.
		const world = worldSeed(hashString(BARREN_SEED));
		const survey = surveyWorld(world, "short");
		for (const entry of survey.sites) {
			if (!entry.settlement) continue;
			expect(sitePlots(survey.world, entry.site).length).toBeGreaterThan(0);
		}
	});
```

`CRAMPED_SEED`, `CROWDED_SEED` and `BARREN_SEED` must be found, not invented. Write a scratch script that surveys a few dozen seeds and prints, per settlement site, the formula budget against `sitePlots().length` and the closest neighbour's overlap — then pin seeds that actually exhibit each case, with a comment naming what makes them interesting. **A seed that does not exhibit the case makes a test that cannot fail.**

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/world/spacing.test.ts src/scenario/survey.test.ts`

Expected: FAIL — `spacing.js` does not resolve; `survey.grown` does not exist.

- [ ] **Step 3: One predicate, shared**

Create `src/core/world/spacing.ts`:

```ts
import type { Vec2 } from "../geom/vec.js";

/**
 * How close two places may stand, asked once.
 *
 * Two callers want this and they must not answer it separately: the survey uses it to
 * decide whether a site may grow, and `validate.ts` uses it to report a recipe that put two
 * places on top of each other. Written twice they would drift, and the drift would show up
 * as a generator producing worlds its own checker complains about.
 *
 * Circles rather than rectangles, matching how a footprint is actually described — a site
 * is a centre and a radius everywhere else in the codebase, and the deformed outline
 * `buildSettlement` draws stays inside it.
 */
export interface Footprint {
	readonly at: Vec2;
	readonly radius: number;
}

/** Tiles by which two footprints intrude on each other. Zero or less means clear. */
export function overlapBy(a: Footprint, b: Footprint): number {
	return a.radius + b.radius - Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y);
}

/**
 * How much overlap is tolerated before growth is refused.
 *
 * Not zero, and this is the one number here that is a judgement rather than geometry.
 * Sites are one per macro cell with their centres jittered, so two neighbours can already
 * stand 28 tiles apart before anything grows — pre-existing overlaps are common enough that
 * forbidding all of them would refuse growth almost everywhere. What growth must not do is
 * make an overlap *worse*, which is what the survey checks.
 */
export const GROWTH_CLEARANCE = 0;
```

In `src/scenario/validate.ts:307-321`, replace the inline `Math.hypot` comparison with `overlapBy`, keeping the finding's wording identical so no report changes:

```ts
	for (const place of byCell.values()) {
		const reach = radiusOf(place, rules);
		for (const site of sites.values()) {
			if (site.authored) continue;
			const over = overlapBy({ at: place.at, radius: reach }, { at: site.site, radius: site.radius });
			if (over <= 0) continue;
			const name = artifact.sites[String(site.id)]?.name ?? site.kind;
			findings.push(warning(`${describePlace(place)} overlaps ${name} by ${Math.round(over)} tiles`));
		}
	}
```

- [ ] **Step 4: Grow, in the survey**

In `src/scenario/survey.ts`, after the site list is built in `surveyAt` and before the regions are derived, add a growth pass. The shape, and the ordering that matters:

```ts
/**
 * How far a site may grow, and by how much at a time.
 *
 * Three tiles a step, because a plot needs five and a step smaller than that can spend
 * several rounds buying nothing. The ceiling is the smaller of the next size up on the
 * ladder and half again the site's own radius — the same shape as `growthCeiling` for the
 * boundary and for the same reason: a hamlet that has to reach village size has stopped
 * being the thing it was.
 */
const GROWTH_STEP = 3;

/**
 * The three kinds that differ only in size.
 *
 * Deliberately not `isSettlement`, which also admits `fort` — a fort is a settlement but
 * not a bigger village, and nothing else on the map has a next size up at all.
 */
const SIZE_LADDER: readonly SettledKind[] = ["hamlet", "village", "town"];
```

The pass itself:

1. For each settlement site, compute `sitePlots(world, site).length` and the *unmeasured* ambition for that site (Task 4's `ambition`, which needs exporting, or recompute the formula — prefer exporting, so there is one formula).
2. If plots ≥ ambition, leave it.
3. Otherwise try radii in steps of `GROWTH_STEP` up to the ceiling, stopping at the first that satisfies ambition. Reject any candidate radius that would push `overlapBy` against a neighbour above what it already is, or that would leave the footprint not `isWellInside` the bounds.
4. Collect the accepted radii as `places` entries — `{ at: site.site, kind: site.kind, importance: site.importance, radius }` keyed by `placeKey(site.mx, site.my)`.
5. If any were accepted, build a **new** `WorldSeed` with those places merged into the recipe and re-derive the site list from it, so everything downstream sees the grown radii. Positions and kinds are pinned to what they already were, so roads, region ids and site ids are unchanged — which is the property that makes this safe.
6. Return the survey against the new world, with `grown` recording what changed.

Two things to get right, both of which compile either way:

- **Re-derive, do not patch.** Mutating `site.radius` on the objects already collected would leave `world.rules.places` disagreeing with them, and `macroSite` is what every later caller consults. Rebuild the world and re-run the site collection.
- **Growth must be idempotent.** Surveying an already-grown world must not grow it again: the second pass measures the grown radius, finds the plots sufficient, and stops. Assert this in a test — survey twice, expect `grown` empty the second time.

Finally, tighten `buildsSomething`:

```ts
/**
 * Whether the generator will actually build something here.
 *
 * "Something" used to include an anchor, and every settlement emits a square and a well
 * before it places a single building — so a town with nothing in it passed this filter, was
 * named, peopled, and given story beats, and the only symptom was a field with a signpost.
 * A settlement now has to produce a building; the kinds that lay out their own buildings
 * from their own rules keep the old test, since an empty patch is what *their* refusal
 * looks like.
 */
function buildsSomething(world: WorldSeed, site: MacroSite): boolean {
	if (!featureKindFor(site.kind)) return true;
	try {
		const patch = generateFeature(world, site, fallbackSettlementSpec(world, site));
		if (!patch) return true;
		if (isSettlement(site.kind)) return patch.buildings.length > 0;
		return patch.buildings.length > 0 || patch.anchors.length > 0;
	} finally {
		invalidateFeature(world, site.id);
	}
}
```

This must run **after** growth, or a site that would have been fine once grown is dropped for being empty at its original size. Note that ordering in a comment — it is the kind of thing a later refactor reorders without noticing.

- [ ] **Step 5: Run everything**

Run: `npm run check`

Expected: PASS. Survey-dependent tests may shift; read any diff rather than updating it reflexively. If the number of sites in a shipped scenario changes, stop — those pin their own radii and must be untouched.

- [ ] **Step 6: Report growth on the progress screen**

`authorScenario` already emits progress lines. Add one after the survey, so a player watching can see it happen:

```ts
	if (Object.keys(survey.grown).length > 0) {
		say(`made room in ${Object.keys(survey.grown).length} place(s) for what they were asked to hold`);
	}
```

- [ ] **Step 7: Commit**

```bash
git add src/core/world/spacing.ts src/core/world/spacing.test.ts src/scenario/survey.ts src/scenario/survey.test.ts src/scenario/validate.ts src/ai/author/author.ts
git commit -m "Make room before asking for a roster that needs it

A site short of plots was told to produce a roster it could not hold, and the
tail of that roster became filler. Growing it at survey time — before the model
is asked anything — is the fix at source rather than a repair afterwards.

Bounded by the same predicate the validator reports overlaps with, extracted so
both share it: written twice they would drift, and the drift would be a
generator producing worlds its own checker complains about. Growth may not make
an overlap worse and may not cross the boundary band, and a hamlet may not grow
past a village, because a hamlet that reaches village size has stopped being the
thing it was.

Growth is written into the recipe rather than held in the survey, so a reloaded
artifact gets the same town the placements were written against. Positions and
kinds are pinned to what they already were, which is what leaves roads, region
ids and site ids untouched.

buildsSomething now demands a building of a settlement. It accepted any anchor,
and every settlement emits a square and a well before placing anything — so a
town with nothing in it was named, peopled and given story beats, and the only
symptom was a field with a signpost.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (C1–C3).** C1's greedy fallback → Task 1; `unplaced` on the patch → Task 2. C2's `sitePlots` extraction and measured `buildingBudget` → Tasks 3 and 4, with the clamp raised to 24 as specced. C3's radius table → Task 5 with the exact numbers from the spec, and the three artifacts pinned; survey-time growth with the `hamlet → village → town` ladder, the 1.5× ceiling, the boundary-band constraint and neighbour clearance → Task 6; growth persisted as recipe `places` → Task 6 step 4; `buildsSomething` tightened → Task 6 step 4.

The spec's testing bullets for this part: `sitePlots` agreeing with the builder → Task 3 Step 1 (the whole file); solver partial failure → Task 1; `unplaced` reaching the patch → Task 2; growth stopping at ceiling, band and neighbour → Task 6; the buildingless site → Task 6.

**Deferred to Parts 2 and 3, tracked here so nothing is lost:** `mainLine` and the repair split (C4), `settleTheStory` (C5), side-quest fitting (C6), the adjustment call (C7), write-on-acceptance and reseed (C8). None of them is touched by this plan, and nothing here changes behaviour they will depend on except by making it more truthful.

**Type consistency.** `sitePlots` is defined in Task 3 and called in Tasks 4 and 6 under that name. `buildingBudget` gains `world` in Task 4 and every caller is updated there. `overlapBy`/`Footprint` are defined in Task 6 and used by both the survey and `validate.ts` in the same task. `FeaturePatch.unplaced` is added in Task 2 and read by nothing until Part 2 — which is stated rather than hidden, because an unread field looks like an oversight.

**Four things the implementer must not paper over:**

1. **Task 3's rng ordering.** Extracting the block changes where the rng stream is drawn from, so every settlement re-lays-out and the goldens move. That is expected and the plan says to take it. What is *not* expected is terrain changing outside a town — if the golden diff shows a moved coastline, the extraction took something with it.
2. **Task 4's possible import cycle.** `core/world/context.ts` importing `core/gen/features/settlement.ts` may cycle. The plan says to check and gives the fallback. Do not resolve it by copying the plot logic.
3. **Task 6's seeds.** Three tests need seeds that genuinely exhibit cramped, crowded and barren sites. Find them with a scratch script and pin them with a comment. A seed chosen because it was to hand makes a test that cannot fail, which is worse than no test.
4. **Task 5 Step 1's ordering.** Pin the artifacts and run the tests *before* raising the defaults. Doing both at once makes a failure ambiguous between "the new numbers broke something" and "the pinning was wrong", and those need different fixes.
