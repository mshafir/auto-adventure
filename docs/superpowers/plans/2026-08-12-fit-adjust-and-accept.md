# Track C, part 3: fitting, adjusting, and writing only on acceptance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the generation-integrity track — fit the side quests once the main line stands,
let one model call adjust the story to what fitted, and stop writing a world whose main line
could not be settled unless the player says to.

**Architecture:** Three passes and a gate. The session-and-walk half of `settleTheStory` moves
into `play.ts` so a second caller can use it; `fit.ts` visits each optional beat with a lower
tolerance and no growth at all; `adjust.ts` spends one call on the story's own commentary and
discards the result wholesale if the re-walk disagrees. `generate.ts` then writes only a settled
world, and `pick-launch.tsx` loops over attempts with a fresh seed salt.

**Tech stack:** TypeScript ESM (explicit `.js` specifiers), Vitest, Biome, Ink + React for the
screen, Zod for the model schema.

## Global constraints

- `npm run check` (typecheck + lint + test) must be green at the end of every task.
- `exactOptionalPropertyTypes: true` — never assign `undefined` to an optional field; use a
  conditional spread `...(x ? { x } : {})`.
- Every import of a local module ends in `.js`.
- Generation stays pure in `(seed, recipe)`. Nothing may read the clock to decide what a world
  *contains*; a wall clock may only decide when to stop trying.
- **The main line is sacred.** No pass added here may delete, shorten, or bar a non-optional
  beat. Where a fault cannot be fixed, it is reported.
- **C6 never grows a site.** Growing re-rolls the whole BSP layout, which would move every plot
  the main line has just been settled against.
- Comments carry the reasoning, in the register of the surrounding code: say what a rule
  prevents and how it was found, not what the line does.
- Every new test must be shown to fail before it passes — by hand-disabling the rule it covers
  where TDD order is impractical.

---

### Task 1: Lift the session and the walk out of `settleTheStory`

A pure refactor, and the enabling one: `fitSideQuests` needs the same ephemeral session, the
same walker, and the same main-line walk to bring a story's state up before it can visit a side
errand. Two copies of that walk would relearn every bug the walker's comments record.

**Files:**
- Create: `src/scenario/play.ts`
- Create: `src/scenario/play.test.ts`
- Modify: `src/scenario/settle.ts` (delete what moves; call the new functions)
- Modify: `src/core/rules/arc.ts` (export `isBarredBranch`)

**Interfaces produced:**

```ts
export interface Playing {
	readonly walker: StoryWalker;
	readonly state: () => GameState;
	readonly sites: ReadonlyMap<number, MacroSite>;
}
export async function withStory<T>(
	artifact: ScenarioArtifact,
	run: (playing: Playing) => Promise<T>,
): Promise<T>;
export interface Walkthrough {
	readonly opened: readonly string[];
	readonly concessions: readonly string[];
	readonly stuck?: { readonly beat: string; readonly siteId: number; readonly why: string };
}
export async function walkMainLine(
	artifact: ScenarioArtifact,
	playing: Playing,
	deadline: number,
): Promise<Walkthrough>;
export async function closeWhatIsOpen(playing: Playing): Promise<void>;
```

- [ ] **Step 1: Write `src/scenario/play.ts`**

Move, verbatim with their comments: `walkMainLine`'s body (minus the session construction and
the `finally`), `closeWhatIsOpen`, `MAX_CLOSE_ROUNDS`, `ticked`, `whyStuck`, and the `Attempt`
interface renamed `Walkthrough`. `withStory` owns what `walkMainLine` used to own:

```ts
export async function withStory<T>(
	artifact: ScenarioArtifact,
	run: (playing: Playing) => Promise<T>,
): Promise<T> {
	const sites = siteIndex(artifact);
	const session = buildSession(
		{
			worldId: `play-${artifact.id}`,
			seed: artifact.seed,
			flavour: "prebuilt",
			scenario: artifact,
		},
		{ saveDebounceMs: 0, persist: false },
	);
	try {
		// The opening card blocks movement until it is read, which is the point of it.
		session.engine.dispatch({ t: "DismissCard" });
		const walker = storyWalker(artifact, session.engine, sites);
		return await run({ walker, state: () => session.engine.getState(), sites });
	} finally {
		// On every path, including a throw. A session left undisposed holds a debounce timer,
		// and a pass may build several.
		session.dispose();
	}
}
```

The file's header comment says what it is: playing a story in a session nobody will ever see,
and why both callers want the same one.

- [ ] **Step 2: Export `isBarredBranch` from `arc.ts`**

Change `function isBarredBranch` to `export function isBarredBranch`, and extend its comment:
`mainLineBeats` asks it for the main line; the side-quest pass has to ask it about an *optional*
arm, which `mainLineBeats` filters out before it can be asked.

- [ ] **Step 3: Rewrite `settle.ts` against it**

`walkMainLine` and its helpers go; the call site becomes:

```ts
const attempt = await withStory(current, (playing) =>
	walkMainLine(current, playing, started + BUDGET_MS),
);
```

Everything else in `settle.ts` — the fix tiers, `makeRoomAt`, the budgets, `SettleReport` —
stays exactly as it is.

- [ ] **Step 4: Write `src/scenario/play.test.ts`**

Two tests, both against `thornwick-road`, with the same `AUTO_ADVENTURE_HOME` temp-dir
`beforeEach`/`afterEach` as `settle.test.ts` (the walk must leave no save behind):

```ts
it("walks a good story's main line to the end, and changes nothing", async () => {
	const artifact = readScenarioFile(scenarioPath("thornwick-road"));
	if (!artifact?.arc) return;
	const walk = await withStory(artifact, (playing) =>
		walkMainLine(artifact, playing, Date.now() + 60_000),
	);
	expect(walk.stuck).toBeUndefined();
	expect(walk.opened.length).toBeGreaterThan(0);
});

it("reports the beat it could not open rather than fixing it", async () => {
	// The distinction this file exists for: a walk *reports*, and the policy above it decides
	// what to do about it. A walk that quietly repaired would make its own report a tautology.
	const artifact = readScenarioFile(scenarioPath("thornwick-road"));
	if (!artifact?.arc) return;
	const beats = mainLineBeats(artifact.arc).filter((beat) => beat.branch === undefined);
	const last = beats[beats.length - 1] as ScenarioBeat;
	const broken = {
		...artifact,
		arc: {
			...artifact.arc,
			beats: artifact.arc.beats.map((beat) =>
				beat.id === last.id ? { ...beat, siteId: 987_654_321 } : beat,
			),
		},
	};
	const walk = await withStory(broken, (playing) =>
		walkMainLine(broken, playing, Date.now() + 60_000),
	);
	expect(walk.stuck?.beat).toBe(last.id);
	expect(walk.stuck?.why).toContain("987654321");
	expect(broken.arc.beats.length).toBe(artifact.arc.beats.length);
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/scenario/play.test.ts src/scenario/settle.test.ts src/scenario/walker.test.ts`
Expected: PASS, and `settle.test.ts` unchanged and still green — that is what makes this a
refactor rather than a rewrite.

- [ ] **Step 6: `npm run check`, then commit**

```bash
git add -A && git commit -m "Lift the session and the walk out of settling, for the pass beside it"
```

---

### Task 2: `fitSideQuests` — the side quests, after the main line stands

**Files:**
- Create: `src/scenario/fit.ts`
- Create: `src/scenario/fit.test.ts`

**Interfaces consumed:** `withStory`, `walkMainLine`, `closeWhatIsOpen`, `Playing` (Task 1);
`isBarredBranch` (Task 1); `applySpatialRepairs` (`repair.ts`).

**Interfaces produced:**

```ts
export interface FitReport {
	readonly artifact: ScenarioArtifact;
	/** Optional beats that opened, or that a fork barred, which is not a failure. */
	readonly fitted: readonly string[];
	/** Optional beats taken out of the story, in words. */
	readonly dropped: readonly string[];
	/** Beats that would not fit and could not be dropped, in words. */
	readonly refused: readonly string[];
	/** What was changed to fit them, in words. */
	readonly fixes: readonly string[];
	readonly concessions: readonly string[];
}
export async function fitSideQuests(
	artifact: ScenarioArtifact,
	onProgress?: (message: string) => void,
): Promise<FitReport>;
/** An optional beat taken out of the story, and everything that pointed at it. */
export function dropBeat(artifact: ScenarioArtifact, id: string): ScenarioArtifact;
```

- [ ] **Step 1: Write the failing tests first**

`src/scenario/fit.test.ts`, same temp-`HOME` fixture as `settle.test.ts`. Both shipped scenarios
have optional beats — thornwick two (`the-old-adit`, `the-carters-favour`), green-chapel one
(`the-ferrymans-iron`) — so the load-bearing case needs no fixture:

```ts
it("fits the side quests of a good world without dropping any", async () => {
	for (const name of ["thornwick-road", "green-chapel"]) {
		const artifact = readScenarioFile(scenarioPath(name));
		if (!artifact?.arc) continue;
		const optional = artifact.arc.beats.filter((beat) => beat.optional);
		expect(optional.length, `${name} has no side quests, so this proves nothing`).toBeGreaterThan(0);
		const report = await fitSideQuests(artifact);
		expect(report.dropped, `${name}: a working side quest was dropped`).toEqual([]);
		expect(report.fitted.length).toBe(optional.length);
		// And never the map. Growing a site re-rolls its layout, which would move every plot
		// the main line was just settled against.
		expect(report.artifact.recipe?.places).toEqual(artifact.recipe?.places);
	}
});

it("drops the one it cannot fit and keeps the others", async () => {
	// Independence is the property: an unplaceable side errand must cost the others nothing.
	const artifact = readScenarioFile(scenarioPath("thornwick-road"));
	if (!artifact?.arc) return;
	const optional = artifact.arc.beats.filter((beat) => beat.optional);
	const doomed = optional[0] as ScenarioBeat;
	const broken = {
		...artifact,
		arc: {
			...artifact.arc,
			beats: artifact.arc.beats.map((beat) =>
				beat.id === doomed.id ? { ...beat, siteId: 987_654_321 } : beat,
			),
		},
	};
	const report = await fitSideQuests(broken);
	expect(report.dropped.join(" ")).toContain(doomed.id);
	expect(report.fitted).toEqual(optional.slice(1).map((beat) => beat.id));
	expect(report.artifact.arc?.beats.some((beat) => beat.id === doomed.id)).toBe(false);
	// The main line is exactly as long as it was.
	expect(mainLineBeats(report.artifact.arc as ScenarioArc).length).toBe(
		mainLineBeats(broken.arc).length,
	);
});

it("refuses to drop a side quest the main line waits on", async () => {
	// The rule the whole track rests on, in the one place C6 could break it: a main-line beat
	// written as a step of an optional one cannot open once its parent is gone, so the parent
	// stays and the fault is reported.
	const artifact = readScenarioFile(scenarioPath("thornwick-road"));
	if (!artifact?.arc) return;
	const doomed = artifact.arc.beats.find((beat) => beat.optional) as ScenarioBeat;
	const main = mainLineBeats(artifact.arc)[2] as ScenarioBeat;
	const broken = {
		...artifact,
		arc: {
			...artifact.arc,
			beats: artifact.arc.beats.map((beat) =>
				beat.id === doomed.id
					? { ...beat, siteId: 987_654_321 }
					: beat.id === main.id
						? { ...beat, requires: [`arc:${doomed.id}`] }
						: beat,
			),
		},
	};
	const report = await fitSideQuests(broken);
	expect(report.refused.join(" ")).toContain(doomed.id);
	expect(report.dropped).toEqual([]);
	expect(report.artifact.arc?.beats.some((beat) => beat.id === doomed.id)).toBe(true);
});

it("has nothing to do when the story has no side quests", async () => {
	const artifact = readScenarioFile(scenarioPath("thornwick-road"));
	if (!artifact?.arc) return;
	const straight = {
		...artifact,
		arc: { ...artifact.arc, beats: artifact.arc.beats.filter((beat) => !beat.optional) },
	};
	const report = await fitSideQuests(straight);
	expect(report.artifact).toBe(straight);
	expect(report.fitted).toEqual([]);
});

it("leaves no world behind for the launcher to offer", async () => {
	const artifact = readScenarioFile(scenarioPath("thornwick-road"));
	if (!artifact) return;
	await fitSideQuests(artifact);
	expect(listSaves()).toEqual([]);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/scenario/fit.test.ts`
Expected: FAIL — cannot resolve `./fit.js`.

- [ ] **Step 3: Write `src/scenario/fit.ts`**

Header comment: side quests are fitted only once the main line stands, with a deliberately lower
tolerance — they are worth having and none of them is worth risking the story for. Four non-map
fixes only, one attempt each, drop on failure. And the ordering argument for why no growth is
available here, not the preference.

The pass:

```ts
export async function fitSideQuests(artifact, onProgress = () => undefined): Promise<FitReport> {
	const arc = artifact.arc;
	const optional = arc ? orderedBeats(arc).filter((beat) => beat.optional) : [];
	if (!arc || optional.length === 0) {
		return { artifact, fitted: [], dropped: [], refused: [], fixes: [], concessions: [] };
	}

	let current = artifact;
	const fixes: string[] = [];
	const concessions: string[] = [];

	// First attempt, in one session: the main line is walked to bring the story's state up,
	// because a side errand is commonly gated on a beat of it, and then each optional beat is
	// visited in `orderedBeats` order so the result is deterministic.
	let round = await attemptAll(current, optional, concessions);

	// One fix attempt for the whole set, not three per beat. These are the repairs that touch
	// no map — somebody standing in a building that was not built, a thing hidden in a room
	// that does not exist — so they are re-derived once against the whole artifact and the
	// beats that failed are visited again. A second round buys nothing: a fix that changed
	// nothing will change nothing next time either.
	if (round.failed.length > 0) {
		const fixed = applySpatialRepairs(current);
		if (fixed.artifact !== current) {
			current = fixed.artifact;
			fixes.push(...fixed.repairs);
			onProgress(`fixed ${fixed.repairs.length} placement fault(s) and tried again`);
			const again = await attemptAll(current, round.failed, concessions);
			round = { fitted: [...round.fitted, ...again.fitted], failed: again.failed };
		}
	}

	const dropped: string[] = [];
	const refused: string[] = [];
	for (const beat of round.failed) {
		const waiting = waitingOn(current, beat.id);
		if (waiting) {
			refused.push(
				`side errand ${beat.id} would not fit, and ${waiting} waits on it; left it alone rather than breaking the story`,
			);
			continue;
		}
		current = dropBeat(current, beat.id);
		dropped.push(`side errand ${beat.id} could not be placed in this world; dropped it`);
	}
	for (const said of [...dropped, ...refused]) onProgress(said);
	return { artifact: current, fitted: round.fitted, dropped, refused, fixes, concessions };
}
```

`attemptAll(artifact, beats, concessions)` uses `withStory`: walk the main line first (ignoring
its `stuck` — a story whose main line is not settled has no business here, and the caller only
calls this once `settleTheStory` said it was), then per beat:

- barred by a fork that went the other way (`isBarredBranch(state(), beat)`) → **fitted**, with
  the comment that a barred optional arm is an alternative that was not taken, not a side quest
  that would not fit, and dropping it would delete the road the player did not walk;
- the site is not in this world → failed;
- otherwise `walker.openWith(beat)`, `walker.goTo(site)`, `walker.talkTo(beatNpcId(beat),
  walker.roomOf(beat.siteId, beat.npcSlot))`, then `state().flags[beat.setsFlag]` decides. On
  success, `closeWhatIsOpen(playing)`, because a side errand with an unclosed objective is the
  same fault on a smaller scale.

`waitingOn(artifact, id)` returns the id of the first beat that is *not itself optional* and
whose `flagsRead(asCondition(beat.requires))` contains `arc:${id}`, or undefined.

`dropBeat(artifact, id)` takes out the beat and everything that pointed at it, each with its
reason:

```ts
export function dropBeat(artifact: ScenarioArtifact, id: string): ScenarioArtifact {
	const arc = artifact.arc;
	if (!arc) return artifact;
	const flag = `arc:${id}`;
	const beats = arc.beats
		.filter((beat) => beat.id !== id)
		.map((beat) => {
			// A parent that had this as one of its steps: the `quest` objective naming it can
			// never tick now, and an errand waiting on a step that is gone is an errand that
			// stays in the log forever — which is exactly what stops an arc from ever finishing.
			if (!beat.quest?.objectives.some((o) => o.kind === "quest" && o.target === id)) return beat;
			return {
				...beat,
				quest: {
					...beat.quest,
					objectives: beat.quest.objectives.filter((o) => !(o.kind === "quest" && o.target === id)),
				},
			};
		});
	// An ending chosen by having done this: unreachable, and `pickEnding` takes the first match,
	// so leaving it would put a dead condition ahead of a live one.
	const endings = (arc.endings ?? []).filter((ending) => !flagsRead(ending.when).has(flag));
	// The thing this beat hid, which nothing now asks for. Keyed by the beat, in `lowerArc`.
	const placements = (artifact.placements ?? []).filter((placement) => placement.id !== `find:${id}`);
	return {
		...artifact,
		arc: { ...arc, beats, ...(endings.length > 0 ? { endings } : {}) },
		...(placements.length > 0 ? { placements } : {}),
	};
}
```

Note in a comment that `dropBeat` deliberately does not touch `trees` or `triggers`: a
conversation for a person who is still standing there is content a player can reach, and a
trigger keyed on a flag nothing now sets is inert rather than broken — `validate.ts` reports
both, and deleting a conversation to tidy a report would cost more than it saves.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/scenario/fit.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Prove the drop test can fail**

Temporarily make `dropBeat` return its input unchanged. Expected: "drops the one it cannot fit"
goes red on the `beats.some(...)` assertion. Restore.

- [ ] **Step 6: `npm run check`, then commit**

```bash
git add -A && git commit -m "Fit the side quests, and drop only the ones nothing waits on"
```

---

### Task 3: The adjustment schema, prompt, and lowering

The call itself is Task 4; everything that can be tested without a key is here.

**Files:**
- Modify: `src/ai/author/schemas.ts` (add `AdjustmentSchema`)
- Modify: `src/ai/author/prompts.ts` (add `ADJUST_SYSTEM`, `adjustPrompt`)
- Create: `src/ai/author/adjust.ts` (the lowering only; the call in Task 4)
- Create: `src/ai/author/adjust.test.ts`

**Scope note, stated rather than quietly dropped.** The spec lists four things this call may do:
a different ending conditioned on side quests, a shortcut between beats, an alternative
main-line beat, and revised text. Three are implemented. An *alternative main-line beat* is not,
because there is no way to add one without changing what some existing main-line beat requires
— and that is the one thing this track exists to protect. A new beat is therefore always
optional, gated on the side quests that fitted, which is the same content delivered without
touching the settled line. Recorded in the file's header comment and in the spec's own terms.

**Interfaces produced:**

```ts
export const AdjustmentSchema: z.ZodType<...>;   // in schemas.ts
export type AdjustmentResponse = z.infer<typeof AdjustmentSchema>;
export const ADJUST_SYSTEM: string;              // in prompts.ts
export function adjustPrompt(input: {
	readonly lore: WorldLore;
	readonly beats: readonly { readonly place: string; readonly person: string; readonly summary: string; readonly optional: boolean }[];
	readonly fitted: readonly { readonly summary: string }[];
	readonly people: readonly { readonly place: string; readonly person: string }[];
}): string;
export interface Adjustment {
	readonly arc: ScenarioArc;
	/** What was applied, in words. */
	readonly changes: readonly string[];
	/** What was refused on the way in, in words. */
	readonly rejected: readonly string[];
}
export function lowerAdjustment(
	response: AdjustmentResponse,
	artifact: ScenarioArtifact,
	fitted: readonly string[],
): Adjustment | undefined;   // in adjust.ts
```

- [ ] **Step 1: Add `AdjustmentSchema` to `schemas.ts`**

Everything is an index into a list the prompt showed, which is the safety property the arc
schema already rests on: a model that cannot name a site cannot invent one.

```ts
/**
 * A new side errand, written once it is known which of the old ones fitted.
 *
 * Always optional, and always gated on the side quests it is about. An *alternative main-line*
 * beat is the one thing this call may not produce: adding one means changing what an existing
 * beat requires, and the main line has already been walked and settled against what it
 * requires now.
 */
export const AdjustBeatSchema = z.object({
	id: slugText(48).describe("Short stable slug, e.g. 'the-carters-thanks'."),
	siteIndex: z.number().int().min(0).describe("Index into the list of settlements shown."),
	npcIndex: z.number().int().min(0).describe("Index into that settlement's people, as listed."),
	summary: cappedText(200),
	journal: cappedText(240).nullable(),
	needs: cappedList(z.number().int().min(0), 4)
		.describe("Indices into the side errands that fitted. This opens once those are done."),
	quest: z
		.object({
			name: cappedText(80),
			description: cappedText(240),
			objective: z
				.object({
					// No `have`: an item is a placement, and a placement is a map. Deliberately absent.
					kind: z.enum(["reach", "talk"]),
					target: cappedText(80).describe("A place or person named exactly as listed above."),
				})
				.nullable(),
		})
		.nullable(),
});

export const AdjustmentSchema = z.object({
	/** An ending for a player who did the side errands. Null to leave the endings alone. */
	ending: z
		.object({
			title: cappedText(80),
			heading: cappedText(40).pipe(z.string().min(1)),
			body: cappedText(600),
			needs: cappedList(z.number().int().min(0), 4)
				.describe("Indices into the side errands this ending is for."),
		})
		.nullable(),
	/** Existing beats whose words should acknowledge what is now reachable. Text only. */
	revisions: cappedList(
		z.object({
			beat: z.number().int().min(0).describe("Index into the list of beats shown."),
			journal: cappedText(240).nullable(),
			errand: cappedText(240).nullable().describe("The errand's description, or null to keep it."),
		}),
		6,
	),
	beats: cappedList(AdjustBeatSchema, 3),
});
export type AdjustmentResponse = z.infer<typeof AdjustmentSchema>;
```

- [ ] **Step 2: Add `ADJUST_SYSTEM` and `adjustPrompt` to `prompts.ts`**

The system prompt states the constraint as a rule about what exists: you may only write about
places, people and things this world already has; you are not adding to the map. And the reason
it is being asked at all — which side errands survived was not known when the story was
plotted, so anything the story wants to say about them has to be written now.

`adjustPrompt` shows the lore, the beats in play order with which are optional, the side errands
that fitted (numbered, because `needs` indexes them), and the people it may name, in the
same numbered-list idiom `arcPrompt` uses.

- [ ] **Step 3: Write the failing lowering tests**

`src/ai/author/adjust.test.ts`, offline, no key:

```ts
it("rejects a beat naming a settlement this world does not have", () => {
	const artifact = readScenarioFile(scenarioPath("thornwick-road")) as ScenarioArtifact;
	const result = lowerAdjustment(
		{ ending: null, revisions: [], beats: [beat({ siteIndex: 99 })] },
		artifact,
		["the-old-adit"],
	);
	expect(result?.arc.beats.length).toBe(artifact.arc?.beats.length);
	expect(result?.rejected.join(" ")).toContain("settlement");
});

it("rejects an objective naming somebody who is not here", () => { /* target: "Nobody At All" */ });

it("adds the beat when everything it names exists, and only ever as a side errand", () => {
	// ...expect the new beat to be optional and to require the fitted side quest's flag
});

it("puts the new ending ahead of the old ones, because the first match wins", () => { /* ... */ });

it("revises the words of a beat without touching anything else about it", () => {
	// The zero-risk half of the pass, and the one worth pinning: a revision must not be able
	// to change where a beat is, who opens it, or what it sets.
});

it("keeps the arc it was given when nothing survived the checks", () => {
	expect(lowerAdjustment({ ending: null, revisions: [], beats: [] }, artifact, [])).toBeUndefined();
});
```

- [ ] **Step 4: Run them and watch them fail**

Run: `npx vitest run src/ai/author/adjust.test.ts`
Expected: FAIL — `lowerAdjustment` is not exported yet.

- [ ] **Step 5: Write `lowerAdjustment` in `adjust.ts`**

Rejections, each with a sentence saying what was named and that it does not exist: a site index
out of range; an npc index out of range; a duplicate or already-used beat id; a `needs` index out
of range; a `talk` target that matches nobody in the artifact by `namesMatch`; a `reach` target
that matches no site name. A new beat's `requires` is `{ all: [...needs.map(flag)] }` (or the
bare flag when there is one), `optional: true`, `order` after the last existing beat, and
`setsFlag: arc:<id>`. The ending is prepended to `arc.endings` with
`when: { all: [{ flag: ... }, ...] }`, and the comment says why *prepended*: `pickEnding` takes
the first match in author order, so an ending for a player who did more has to be asked about
first or it can never be reached.

- [ ] **Step 6: Run the tests, then `npm run check`, then commit**

```bash
git add -A && git commit -m "Say what an adjustment may name, and refuse the rest on the way in"
```

---

### Task 4: `adjustTheStory` — the call, verified or discarded

**Files:**
- Modify: `src/ai/author/adjust.ts` (add the pass)
- Modify: `src/ai/author/adjust.test.ts` (add the pass's tests)

**Interfaces consumed:** `lowerAdjustment` (Task 3), `withStory`/`walkMainLine` (Task 1),
`inspect`/`score` (`repair.ts`).

**Interfaces produced:**

```ts
export interface AdjustInput {
	readonly artifact: ScenarioArtifact;
	/** Ids of the optional beats that fitted. Nothing to adjust to when empty. */
	readonly fitted: readonly string[];
	/** Injected so the pass can be tested without a key. */
	readonly ask?: (input: AdjustInput) => Promise<AdjustmentResponse | undefined>;
	readonly onProgress?: (message: string) => void;
	readonly signal?: AbortSignal;
}
export interface AdjustResult {
	readonly artifact: ScenarioArtifact;
	readonly calls: number;
	readonly changes: readonly string[];
	/** Why the adjustment was thrown away, when it was. */
	readonly discarded?: string;
}
export async function adjustTheStory(input: AdjustInput): Promise<AdjustResult>;
```

- [ ] **Step 1: Write the failing tests**

```ts
it("makes no call when no side errand fitted", async () => {
	let asked = 0;
	const result = await adjustTheStory({ artifact, fitted: [], ask: async () => { asked++; return undefined; } });
	expect(asked).toBe(0);
	expect(result.artifact).toBe(artifact);
	expect(result.calls).toBe(0);
});

it("keeps an adjustment the story still plays with", async () => { /* one valid new optional beat */ });

it("throws the whole adjustment away when the main line stops playing", async () => {
	// The rule: the world was already playable, this pass is an enhancement, and chasing a fix
	// for a flourish would spend the main line's guarantee on it. So the pre-adjustment arc is
	// kept whole — not repaired, not partly applied.
	// Injected `ask` returns a revision that moves a main-line beat's site out of the world.
	expect(result.artifact).toBe(artifact);
	expect(result.discarded).toContain("could not");
});

it("throws it away when it makes the offline findings worse", async () => { /* a dead flag objective */ });
```

The third test needs an adjustment that breaks the main line. `revisions` are text-only by
construction, so this is written by having the injected `ask` return a valid response and then
*stubbing the verification's artifact* — no: instead, give the test its own `apply` hook? Do not
add a hook. Write it with a `beats` entry whose `needs` names a fitted side quest and whose
`quest.objective` is a `talk` to somebody real — valid — and then break the main line in the
*input* artifact so the re-walk fails for a reason the adjustment did not cause. That is the
honest version of the same guarantee: **the pass discards its own work whenever the walk it runs
afterwards does not pass**, and asserting it on a world that was already broken proves the
discard is unconditional rather than clever. Say so in the test's comment, and assert
`result.discarded` names the beat that would not open.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/ai/author/adjust.test.ts`

- [ ] **Step 3: Write the pass**

```ts
export async function adjustTheStory(input: AdjustInput): Promise<AdjustResult> {
	const say = input.onProgress ?? (() => undefined);
	const arc = input.artifact.arc;
	// Skipped entirely when nothing fitted: there is nothing to adjust to, and a call spent to
	// be told so is a call wasted.
	if (!arc || input.fitted.length === 0) {
		return { artifact: input.artifact, calls: 0, changes: [] };
	}
	const response = await (input.ask ?? askForAdjustment)(input);
	if (!response) return { artifact: input.artifact, calls: 0, changes: [] };
	const lowered = lowerAdjustment(response, input.artifact, input.fitted);
	for (const said of lowered?.rejected ?? []) say(said);
	if (!lowered) return { artifact: input.artifact, calls: 1, changes: [] };

	const candidate: ScenarioArtifact = { ...input.artifact, arc: lowered.arc };
	// Verified, not assumed — which is the whole reason it is worth running. The changes are text
	// and arc only, so the re-walk is expected to pass; a pass that is expected to pass and is
	// never checked is how an unreachable beat ships. Warm caches, so this is engine commands.
	const walk = await withStory(candidate, (playing) =>
		walkMainLine(candidate, playing, Date.now() + VERIFY_BUDGET_MS),
	);
	const worse = score(inspect(candidate)) > score(inspect(input.artifact));
	if (walk.stuck || worse) {
		const why = walk.stuck
			? `beat ${walk.stuck.beat} would not open afterwards: ${walk.stuck.why}`
			: "it left more wrong with the world than it found";
		say(`the adjustment ${why}; kept the story as it was`);
		return { artifact: input.artifact, calls: 1, changes: [], discarded: why };
	}
	for (const change of lowered.changes) say(change);
	return { artifact: candidate, calls: 1, changes: lowered.changes };
}
```

`askForAdjustment` is the `structured` call: `MODELS.bible`, `AdjustmentSchema`,
`ADJUST_SYSTEM`, `adjustPrompt(...)`, `temperature: 0.7`, `timeoutMs: 180_000`, the abort
signal spread in. Temperature reasoning in a comment: this one is writing rather than judging,
unlike the reading pass, but it is writing *about* a world that exists — so warmer than 0.2 and
cooler than the arc's 0.9.

- [ ] **Step 4: Run the tests, then `npm run check`, then commit**

```bash
git add -A && git commit -m "Adjust the story to the side quests that fitted, or keep the one that worked"
```

---

### Task 5: Wire the two passes into the pipeline, and report what happened

**Files:**
- Modify: `src/ai/author/author.ts` (passes 9 and 10; `AuthorResult`)
- Modify: `src/scenario/generate.ts` (carry the new field through)

**Interfaces produced:**

```ts
export interface AuthorResult {
	// ...existing fields...
	/**
	 * The main-line beat that could not be settled, when one could not.
	 *
	 * Present means the story does not play. Absent means every main-line beat opened and
	 * closed in a real session, which is a far stronger statement than "no findings".
	 */
	readonly unplayable?: {
		readonly beat: string;
		readonly why: string;
		readonly tried: readonly string[];
	};
}
```

- [ ] **Step 1: Add `unplayable` to `AuthorResult` and set it from pass 8**

Right where pass 8 already reports the stuck beat. `settled.stuck` is exactly its shape.

- [ ] **Step 2: Add pass 9 (fit) and pass 10 (adjust) after pass 8**

Both skipped when the main line did not settle, and the comment says why: fitting a side errand
onto a story that does not play is arranging the furniture in a house with no floor, and the
adjustment would be a paid call about it.

```ts
// --- pass 9: fit the side quests -----------------------------------------
if (settled.settled) {
	const fitted = await fitSideQuests(artifact, say);
	...
	artifact = fitted.artifact;
	repairs.push(...fitted.fixes, ...fitted.dropped);
	// The refusals join the findings, as the repair pass's do: a side errand that would not
	// fit and could not be dropped is a fault a person should see.
}

// --- pass 10: adjust the story to what fitted ----------------------------
if (settled.settled && !options.skipTrees) {
	const adjusted = await adjustTheStory({ artifact, fitted: kept, onProgress: say, ...abortable });
	calls += adjusted.calls;
	artifact = adjusted.artifact;
	repairs.push(...adjusted.changes);
}
```

Findings are recomputed once at the end if either pass changed the artifact, carrying
`mechanical.refused` across exactly as pass 8 already does — and the comment already there
explains why, so extend it rather than duplicating it.

Gated on `skipTrees` for the adjustment, since that is the existing flag for "do not spend
model calls", and `tools/author.ts` uses it.

- [ ] **Step 3: Carry `unplayable` out through `generateScenario`**

Only the plumbing in this task — `GenerationOutcome.unplayable` set from `result.unplayable`.
The write gate is Task 6, so nothing changes about what reaches the disk yet.

- [ ] **Step 4: Run the affected suites**

Run: `npx vitest run src/ai/author src/scenario`
Expected: PASS. `authorScenario` is still not tested end to end — it needs model calls — so
this is a typecheck-and-neighbours verification, and the honest statement of that goes in the
commit body.

- [ ] **Step 5: `npm run check`, then commit**

```bash
git add -A && git commit -m "Run the two new passes where they belong, and say when the story does not play"
```

---

### Task 6: Write only on acceptance, and salt the seed for a second attempt

**Files:**
- Modify: `src/scenario/generate.ts`
- Modify: `src/scenario/generate.test.ts`

**Interfaces produced:**

```ts
export interface GenerationOutcome {
	// ...existing fields...
	/** The main-line beat that could not be settled. Nothing was written. */
	readonly unplayable?: { readonly beat: string; readonly why: string; readonly tried: readonly string[] };
	/**
	 * The world that was written but not kept, so the player can accept it anyway.
	 *
	 * Held rather than written: `path` and `choice` are absent precisely because nothing
	 * reached the disk, and this is what {@link acceptScenario} needs to change that.
	 */
	readonly held?: ScenarioArtifact;
}
export interface GenerateRequest {
	// ...existing fields...
	/** Which try this is. 1 is the first; later attempts salt the seed. */
	readonly attempt?: number;
}
export function acceptScenario(outcome: GenerationOutcome, deps?: { write?: ... }): GenerationOutcome;
```

- [ ] **Step 1: Write the failing tests**

```ts
it("writes nothing when the main line could not be settled", async () => {
	const h = harness({ author: author(demoArtifact(), 12, [], { beat: "report-to-corbin", why: "no way to walk there from the start", tried: [] }) });
	const outcome = await generateScenario(REQUEST, h.deps);
	expect(h.written).toHaveLength(0);
	expect(outcome.choice).toBeUndefined();
	expect(outcome.unplayable?.beat).toBe("report-to-corbin");
	// And the world is still in hand, because the player may take it anyway.
	expect(outcome.held).toBeDefined();
});

it("writes it when the player accepts it anyway", () => {
	// The only path by which a world with an unsettled story reaches the disk, and it is the
	// player's decision rather than ours.
	const written: ScenarioArtifact[] = [];
	const after = acceptScenario(stuckOutcome, { write: (a) => { written.push(a); return "/tmp/x.json"; } });
	expect(written).toHaveLength(1);
	expect(after.choice?.scenario).toBe(stuckOutcome.held);
	expect(after.path).toBe("/tmp/x.json");
});

it("keeps the id and salts the seed on a second attempt", async () => {
	const seeds: number[] = [];
	const ids: string[] = [];
	const h = harness({ author: async (o) => { seeds.push(o.seed); ids.push(o.id); return { artifact: demoArtifact(), calls: 1, findings: [], repairs: [] }; } });
	await generateScenario(REQUEST, h.deps);
	await generateScenario({ ...REQUEST, attempt: 2 }, h.deps);
	expect(ids[0]).toBe(ids[1]);
	expect(seeds[1]).not.toBe(seeds[0]);
});

it("writes a settled world without being asked", async () => { /* the existing behaviour, pinned */ });
```

`harness`'s `author` helper gains an optional fourth argument for `unplayable`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/scenario/generate.test.ts`
Expected: FAIL — three of the four; `acceptScenario` does not exist.

- [ ] **Step 3: Implement**

The seed, with the reasoning the spec asks for stated where the salt is applied:

```ts
// From the id, so the same name always names the same country — the rule the CLI already
// follows. A reseed breaks that on purpose: the premise, the title, the tone and the id are
// all the same, and the *world* is what the player asked to be given again, so the seed is
// salted with the attempt. A kept world is still exactly reproducible, because `artifact.seed`
// is authoritative and is what a save records; what is lost is only guessing a seed from a
// filename.
const attempt = request.attempt ?? 1;
const seed = resolveSeed(attempt > 1 ? `${id}#${attempt}` : id);
```

The gate, where the unconditional `write(artifact)` is today:

```ts
// Nothing reaches the disk when the story does not play. The world is handed back in `held`
// instead: the screen names the beat that could not be settled and what was tried, and the
// player decides between another attempt and taking this one anyway. Writing it regardless —
// which is what this did — meant the Continue list filled up with worlds whose stories stop
// at the second scene, with nothing on the file to say so.
if (result.unplayable) {
	return { findings, calls: result.calls, unplayable: result.unplayable, held: artifact };
}
```

`acceptScenario` writes `held` and returns the same outcome with `path` and `choice` filled in,
keeping `unplayable` on it so the screen after it can still say what is wrong.

- [ ] **Step 4: Run the tests, then `npm run check`, then commit**

```bash
git add -A && git commit -m "Keep an unplayable world out of the launcher unless the player asks for it"
```

---

### Task 7: The unplayable screen, and the attempt loop

**Files:**
- Modify: `src/ui/launcher/generate-progress.tsx`
- Modify: `src/ui/launcher/generate-progress.test.tsx`
- Modify: `src/ui/launcher/pick-launch.tsx`

**Interfaces produced:**

```ts
export interface GenerateProgressProps {
	// ...existing...
	/** The beat that could not be settled, when the story does not play. Nothing was written. */
	readonly unplayable?: { readonly beat: string; readonly why: string; readonly tried: readonly string[] };
	/** Discard this world and write another with the same brief and a new seed. */
	readonly onRetry?: () => void;
	/** Write this one anyway and play it. */
	readonly onAccept?: () => void;
}
```

- [ ] **Step 1: Write the failing screen tests**

```ts
const STUCK = { beat: "report-to-corbin", why: "there is no way to walk there from the start", tried: ["re-applied the placement fixes at report-to-corbin"] };

it("names the beat that could not be settled, and what was tried", () => {
	const m = mount({ unplayable: STUCK, onRetry: () => {}, onAccept: () => {} });
	const text = m.screen();
	expect(text).toContain("report-to-corbin");
	expect(text).toContain("no way to walk there");
	expect(text).toContain("re-applied the placement fixes");
});

it("says nothing was kept, which is the thing a player needs to know", () => {
	expect(mount({ unplayable: STUCK }).screen()).toMatch(/nothing was kept|not been kept/i);
});

it("offers another world on R and this one on P", async () => {
	const retried: number[] = []; const accepted: number[] = [];
	const m = mount({ unplayable: STUCK, onRetry: () => retried.push(1), onAccept: () => accepted.push(1) });
	await m.ink.settle();
	await m.ink.type("r");
	expect(retried).toHaveLength(1);
	await m.ink.type("p");
	expect(accepted).toHaveLength(1);
	// And no other key starts a world that does not exist: this screen must not dismiss on
	// "any key" the way the review does, because there is nothing to dismiss *to*.
	await m.ink.type(KEY.space);
	expect(m.dismissed).toHaveLength(0);
});

it("abandons on ESC without writing anything", async () => { /* onDismiss not called; a new onAbandon is */ });
```

ESC on this screen means abandon, and it is the only screen where ESC after the work is done
means anything — so it resolves through `onStop`, which `pick-launch` already treats as "the
player wants out" and which this screen reaches only once the run is over. Assert `stopped`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/ui/launcher/generate-progress.test.tsx`

- [ ] **Step 3: Add the `Unplayable` view**

A sibling of `Review`, taking the same frame. It says, in order: the world's title; that its
story stops at a named beat and why; each fix that was tried; that **nothing has been kept**;
the cost so far; and the three keys. The `useInput` handler takes `r`, `p` and ESC *before* the
`reviewing` catch-all, for exactly the reason `d` and `p` are already taken first — and the
comment says which: this screen has no "any key to play it", because there is nothing on disk to
play.

`reviewing` becomes `done ?? Boolean(unplayable) ?? Boolean(findings?.length)`, so the elapsed
clock stops.

- [ ] **Step 4: Loop over attempts in `pick-launch.tsx`**

```ts
for (let attempt = 1; ; attempt++) {
	outcome = await generateScenario({ ...request, attempt }, { signal: stop.signal, onProgress: ... });
	calls = outcome.calls;
	if (!outcome.unplayable || !outcome.held) break;
	// The one screen in the launcher where a keypress spends money. So the estimate is on it
	// before it is spent, and there is no cap: each attempt is an explicit decision.
	const next = await new Promise<"again" | "anyway" | "leave">((resolve) => { ... });
	if (next === "leave") { ...nothing written... }
	if (next === "anyway") { outcome = acceptScenario(outcome); break; }
	// Round again: same premise, title, tone, length, model and packs; same id; a salted seed.
	lines.push("");
	lines.push(`starting again with a different world (attempt ${attempt + 1})`);
}
```

The working file is closed and reopened per attempt by `generateScenario`'s own `beginWorking`,
so a discarded attempt leaves its record behind — which is the point: a failure has to be
diagnosable after the fact even though its artifact is gone. Say that in a comment.

- [ ] **Step 5: Run the tests, then `npm run check`, then commit**

```bash
git add -A && git commit -m "Offer another world rather than keeping one whose story stops"
```

---

### Task 8: Say what the pipeline now does, and run it for real

**Files:**
- Modify: `docs/scenarios.md`
- Modify: `README.md` (only if it describes the generation passes)

- [ ] **Step 1: Update the pipeline description**

The ten passes in order, with one line each for 8, 9 and 10, and the two sentences that matter
to somebody reading it later: a generated world is *played* before it is kept, and an unplayable
one is not kept unless the player says so.

- [ ] **Step 2: Run the real thing, with the key from the settings file**

The user has a Vercel AI Gateway key registered through the in-app options page
(`~/.auto-adventure/settings.json`, `modelSet: claude-haiku`). Run a real `tiny`/`short`
generation through the CLI author tool, with the scenarios directory pointed at a scratch path
so the repository's `.scenarios` is untouched. Watch for:

- passes 8, 9 and 10 appearing in the progress lines in that order;
- whether the main line settled, and if not, which beat and what was tried;
- whether any side errand was dropped, and whether the adjustment was kept or discarded;
- the cost, and nothing written on a stuck story.

- [ ] **Step 3: Report what actually happened, including anything that came out wrong**

If the live run finds a fault, fix it and say so — a pass that has only ever run against the two
shipped scenarios has been tested against worlds that were assembled by hand.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Say what the generation pipeline does now, after watching it do it"
```
