# Track B: Picking a Premise — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before a world is paid for, offer four premise/title/tone bundles written to order, let the player take one or ask for four more, and make the choice binding — the world gets that title and that register, and the title names the file.

**Architecture:** One new authoring call (`suggestPitches`) on the prose model, returning bundles. One new launcher page that shows them. `ScenarioBrief` gains a `title`; `tone` is already there. Binding is enforced by *overwriting* `lore.title`/`lore.tone` after the lore pass rather than by asking the prompt nicely, because a field a model was asked to preserve is a field that gets quietly rewritten.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod schemas, Vercel AI SDK via `structured()`, React + Ink, Vitest, Biome.

This is Track B of `docs/superpowers/specs/2026-08-11-generation-integrity-design.md`. Track A has landed. Track C is independent of this except that its reseed keeps the chosen bundle.

## Global Constraints

- Node floor `>=18`; ESM with explicit `.js` specifiers on every relative import.
- `exactOptionalPropertyTypes` is on: never pass `foo: undefined` for an optional field — spread conditionally, `...(x ? { x } : {})`.
- A model call never throws into the caller and never blocks a frame. `structured()` returns `undefined` on any failure and every caller has a deterministic fallback. This page's fallback is "the player types their own".
- The TUI owns stdout; diagnostics go through `logger`.
- Comments explain *why*, in prose, at the density of the surrounding file.
- Verify with `npm run check`. Single file: `npx vitest run <path>`.
- Test names finish the sentence "it …".
- Never write a test that cannot fail.

## What already exists (verified, do not re-derive)

- **`ScenarioBrief` already has `tone`** (`core/world/brief.ts:31`) and it already reaches the lore prompt through `briefLines` (`ai/director/prompt.ts:29-38`). Only `title` is new.
- `CallKind` is `"bible" | "region" | "site" | "dialogue" | "summary"` (`ai/telemetry.ts:4`). Buckets are a lazy `Map` (`telemetry.ts:44`), so adding a member has no exhaustiveness fallout.
- `MODELS.bible` is the *prose* model (`config.ts:144`). The pitch call wants the same tier for the same reason: the player reads every word.
- The lore pass is `structured({ kind: "bible", schema: WorldLoreSchema, system: LORE_SYSTEM, prompt: lorePrompt(brief) })` at `ai/author/author.ts:275-286`, and `WorldLoreSchema` carries `title`, `premise`, `era`, `tone`, `factions`, `deities` (`ai/director/schemas.ts:40-50`).
- `freeScenarioId(premise, taken)` → `resolveSeed(id)` at `scenario/generate.ts:131-134`.
- The config page is only reachable when a model is available: `NewWorld` disables the generate row unless `canUseModel` (`new-world.tsx:97-101`), and `Launcher` computes that from the key (`launcher.tsx:135`). So the picker needs no gating of its own.

**The trap:** `ScenarioBriefSchema` (`scenario/schema.ts:63-71`) enumerates the brief's fields, and Zod strips unknown keys. A `title` added only to the interface is silently dropped when an artifact is read back. The save layer does *not* enumerate them — `GameState` is JSON round-tripped — so only the artifact schema needs the matching line.

---

## File Structure

**Created:**
- `src/ai/author/pitch.ts` — `suggestPitches`. Owns the call and nothing else; no UI, no disk.
- `src/ai/author/pitch.test.ts`
- `src/ui/launcher/pick-premise.tsx` — the page. A pure view plus its own key handling, taking the call as a prop so it renders in a test with no key.
- `src/ui/launcher/pick-premise.test.tsx`

**Modified:**
- `src/core/world/brief.ts` — `title` on the interface, in `isBriefEmpty` and in `normalizeBrief`.
- `src/scenario/schema.ts:63` — `title` on `ScenarioBriefSchema`.
- `src/ai/telemetry.ts:4` — `"pitch"` on `CallKind`.
- `src/ai/author/schemas.ts` — `PitchSchema`, `PitchesSchema`.
- `src/ai/author/prompts.ts` — `PITCH_SYSTEM`, `pitchPrompt`.
- `src/ai/director/prompt.ts` — `lorePrompt` states a given title and tone as fixed.
- `src/ai/author/author.ts:275-287` — overwrite `lore.title`/`lore.tone` from the brief.
- `src/scenario/generate.ts` — `freeScenarioId` prefers the title.
- `src/ui/launcher/generate-config.tsx` — title/tone state, the three-way chooser on the Premise row, the picker page.
- `src/ui/launcher/launcher.tsx` — pass the suggest binding through.
- `src/ui/launcher/pick-launch.tsx` — supply the real `suggestPitches`.
- `src/ui/launcher/launcher.test.tsx` — the config page's new behaviour.

---

### Task 1: A title on the brief, surviving the round trip

**Files:**
- Modify: `src/core/world/brief.ts`
- Modify: `src/scenario/schema.ts:63-71`
- Test: `src/core/world/brief.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ScenarioBrief.title?: string`, handled by `normalizeBrief` and `isBriefEmpty`. Tasks 3, 4 and 6 read it.

- [x] **Step 1: Write the failing test**

Append to `src/core/world/brief.test.ts` (read the file first and match its existing describe blocks and voice):

```ts
	it("keeps a title, and drops one that is only whitespace", () => {
		expect(normalizeBrief({ title: "The Tide-Glass of Wodedesert" })?.title).toBe(
			"The Tide-Glass of Wodedesert",
		);
		expect(normalizeBrief({ title: "   " })).toBeUndefined();
	});

	it("counts a title as an instruction, so a brief carrying only one is not empty", () => {
		// A player who picked a world by its name has said something about the world, and a
		// brief reported as empty is a brief the prompts leave out entirely.
		expect(isBriefEmpty({ title: "The Tide-Glass" })).toBe(false);
	});
```

And in `src/scenario/schema.test.ts` — or, if no such file exists, in `src/scenario/repo.test.ts` beside the other round-trip cases:

```ts
	it("keeps a brief's title through a write and a read", () => {
		// Zod strips what a schema does not name, so a field added to the interface and not
		// to `ScenarioBriefSchema` survives in memory and vanishes on the way back off disk —
		// which reads as the lore pass having ignored the title rather than as data loss.
		const artifact = demoArtifact({
			brief: { premise: "a drowned archipelago", title: "The Tide-Glass", tone: "sombre" },
		});
		const path = writeScenario(artifact);
		const read = readScenarioFile(path);
		expect(read?.brief.title).toBe("The Tide-Glass");
		expect(read?.brief.tone).toBe("sombre");
	});
```

Read `repo.test.ts` first: it already has a temporary `AUTO_ADVENTURE_SCENARIOS` and a `demoArtifact` import to reuse. Follow its setup rather than adding your own.

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/world/brief.test.ts src/scenario/repo.test.ts`

Expected: FAIL — `title` is not a property of `ScenarioBrief`, so the first two do not compile; the round-trip one fails on `undefined`.

- [x] **Step 3: Add the field in all three places**

In `src/core/world/brief.ts`, add to the interface, above `premise`:

```ts
export interface ScenarioBrief {
	/**
	 * What the world is called, when the player chose it rather than leaving it to be
	 * invented.
	 *
	 * Unlike every other field here this one is not a hint — the lore pass is made to keep
	 * it (see `author.ts`), because a player who picked a world by its name and got a
	 * different name has been overruled by a machine on the one decision they made.
	 */
	readonly title?: string;
	/** Freeform intent, used close to verbatim. The main knob. */
	readonly premise?: string;
```

In `isBriefEmpty`, add `brief.title?.trim() ||` as the first clause of the `!(...)`.

In `normalizeBrief`, add `title?: string;` to the local `next` type and, beside the others:

```ts
	const title = text(brief.title);
	if (title) next.title = title;
```

In `src/scenario/schema.ts`, add to `ScenarioBriefSchema` above `premise`:

```ts
export const ScenarioBriefSchema = z.object({
	title: z.string().optional(),
	premise: z.string().optional(),
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/world src/scenario && npm run typecheck`

Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/core/world/brief.ts src/core/world/brief.test.ts src/scenario/schema.ts src/scenario/repo.test.ts
git commit -m "Let a brief say what the world is called

Tone was already here and already reaching the prompts; a title was not. It is
added in three places rather than one, and the third is the point: Zod strips
what a schema does not name, so a field on the interface alone survives in
memory and vanishes coming back off disk — which reads as the lore pass having
ignored the title rather than as data loss.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The call that writes four worlds to choose between

**Files:**
- Create: `src/ai/author/pitch.ts`
- Create: `src/ai/author/pitch.test.ts`
- Modify: `src/ai/telemetry.ts:4`
- Modify: `src/ai/author/schemas.ts`
- Modify: `src/ai/author/prompts.ts`

**Interfaces:**
- Consumes: `structured` from `../client.js`, `MODELS` from `../../config.js`, `Duration` from `../../core/world/brief.js`.
- Produces: `interface Pitch { readonly title: string; readonly tone: string; readonly premise: string }` and `suggestPitches(input: PitchRequest): Promise<readonly Pitch[]>` where `PitchRequest` is `{ duration: Duration; hint?: string; count?: number; avoid?: readonly string[]; signal?: AbortSignal }`. Task 5 renders `Pitch`; Task 6 passes `suggestPitches` in.

- [x] **Step 1: Write the failing test**

Create `src/ai/author/pitch.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Four worlds to choose between, before one is paid for.
 *
 * With nothing typed the lore pass invents a premise silently, four minutes in — so the
 * first thing a player learns about the world they bought is that they did not choose it.
 * This is one cheap call that turns that into a decision.
 *
 * Nothing here is load-bearing: a failed call returns nothing and the page it feeds falls
 * back to the player typing their own, which is what they would have done anyway.
 */

const structured = vi.fn();
vi.mock("../client.js", () => ({
	structured: (...args: unknown[]) => structured(...args),
}));

const { suggestPitches } = await import("./pitch.js");

const FOUR = {
	pitches: [
		{ title: "The Tide-Glass", tone: "sombre", premise: "A drowned archipelago." },
		{ title: "The Ledger of Saint Wain", tone: "wry", premise: "A monastery audits miracles." },
		{ title: "Nine Years at the Gate", tone: "weary", premise: "A siege nobody remembers." },
		{ title: "The Salt Road", tone: "hard", premise: "The caravans have stopped coming." },
	],
};

beforeEach(() => {
	structured.mockReset();
});

describe("suggesting a premise", () => {
	it("asks the prose model, because the player reads every word of these", async () => {
		structured.mockResolvedValue(FOUR);
		await suggestPitches({ duration: "medium" });

		const request = structured.mock.calls[0]?.[0] as { model: string; kind: string };
		// The fast model does the bookkeeping nobody reads; this is the other kind of call.
		expect(request.model).toBe("google/gemini-2.5-flash");
		expect(request.kind).toBe("pitch");
	});

	it("hands back the bundles it was given", async () => {
		structured.mockResolvedValue(FOUR);
		const pitches = await suggestPitches({ duration: "medium" });
		expect(pitches).toHaveLength(4);
		expect(pitches[0]?.title).toBe("The Tide-Glass");
		expect(pitches[0]?.tone).toBe("sombre");
	});

	it("returns nothing rather than throwing when the call fails", async () => {
		// The contract every caller of `structured` keeps. The page falls back to the player
		// typing their own, which is what they would have done without this at all.
		structured.mockResolvedValue(undefined);
		expect(await suggestPitches({ duration: "medium" })).toEqual([]);
	});

	it("puts what the player has already typed in front of the model", async () => {
		structured.mockResolvedValue(FOUR);
		await suggestPitches({ duration: "short", hint: "something about debt" });

		const request = structured.mock.calls[0]?.[0] as { prompt: string };
		expect(request.prompt).toContain("something about debt");
	});

	it("tells the model what it has already offered, so 'more' means more", async () => {
		// Without this the second press returns four near-copies of the first four, and the
		// key reads as broken rather than as a model with no memory between calls.
		structured.mockResolvedValue(FOUR);
		await suggestPitches({ duration: "short", avoid: ["The Tide-Glass"] });

		const request = structured.mock.calls[0]?.[0] as { prompt: string };
		expect(request.prompt).toContain("The Tide-Glass");
	});

	it("says how long the world will be, since that changes what fits in one", async () => {
		structured.mockResolvedValue(FOUR);
		await suggestPitches({ duration: "tiny" });

		const request = structured.mock.calls[0]?.[0] as { prompt: string };
		expect(request.prompt).toContain("tiny");
	});
});
```

The model id asserted above is whatever `MODELS.bible` resolves to with no `MODEL_BIBLE` set and the default catalogue row — `google/gemini-2.5-flash`. If the default row changes, assert `MODELS.bible` rather than hard-coding the string.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ai/author/pitch.test.ts`

Expected: FAIL — cannot resolve `./pitch.js`.

- [x] **Step 3: Add the kind, the schema, the prompt and the call**

In `src/ai/telemetry.ts` line 4:

```ts
export type CallKind = "bible" | "region" | "site" | "dialogue" | "summary" | "pitch";
```

In `src/ai/author/schemas.ts`, beside the other authoring schemas:

```ts
/**
 * One world, offered rather than written.
 *
 * Three fields and no more. The player is choosing between four of these on one screen, so
 * anything that does not help them choose is a line pushing the fourth option off the
 * bottom — and everything else about the world is the lore pass's job anyway.
 */
export const PitchSchema = z.object({
	title: cappedText(60).describe("The world's name. Two to five words, no subtitle."),
	tone: cappedText(24).describe("Its register, in one or two words: 'sombre', 'wry'."),
	premise: cappedText(400).describe("What the player is caught up in, in two to four sentences."),
});

export const PitchesSchema = z.object({
	pitches: z
		.array(PitchSchema)
		.min(1)
		.transform((v) => v.slice(0, 8)),
});

export type PitchResponse = z.infer<typeof PitchSchema>;
```

In `src/ai/author/prompts.ts`, beside `ARC_SYSTEM`:

```ts
export const PITCH_SYSTEM =
	`You pitch worlds for a small terminal roguelike. ${HOUSE_STYLE} ` +
	"Each pitch is a whole world in three lines: what it is called, its register, and what " +
	"the player has walked into. They must differ from each other in kind and not merely in " +
	"decoration — four ways to be a fishing village is one idea told four times.";

/**
 * What a world could be, before any of it exists.
 *
 * The one authoring prompt with no survey behind it, and deliberately so: the premise
 * decides the scenario's id and therefore its seed, so it has to be settled before a single
 * tile is generated. The model is inventing rather than describing, which is why this asks
 * for difference between the options — the failure mode of a list like this is four
 * paraphrases of whichever one the model thought of first.
 */
export function pitchPrompt(input: {
	readonly duration: Duration;
	readonly count: number;
	readonly hint?: string;
	readonly avoid?: readonly string[];
}): string {
	const lines = [
		`Offer ${input.count} worlds to play in, as different from each other as you can make them.`,
		`Each will be a ${input.duration} scenario: ${LENGTH_NOTE[input.duration]}`,
		"A traveller on foot is the protagonist, and a village blacksmith should plausibly have",
		"an opinion about whatever has happened.",
	];
	if (input.hint) {
		lines.push("", "The player has said what they are after. Follow it:", input.hint);
	}
	if (input.avoid && input.avoid.length > 0) {
		// Named rather than described, because "something different" is advice a model can
		// satisfy without changing anything.
		lines.push(
			"",
			"These have already been offered and refused. Do not repeat them or reword them:",
			input.avoid.map((title) => `- ${title}`).join("\n"),
		);
	}
	return lines.join("\n");
}

/** What each length can actually hold, so a pitch is not bigger than its world. */
const LENGTH_NOTE: Readonly<Record<Duration, string>> = {
	tiny: "a few places and two scenes, so keep the stakes local and the cast small.",
	short: "a handful of places and three scenes — an evening.",
	medium: "a dozen or so places and six scenes, with room to wander between them.",
	long: "a large map, ten scenes, side errands and a fork or two.",
};
```

Add `import type { Duration } from "../../core/world/brief.js";` to that file's imports.

Create `src/ai/author/pitch.ts`:

```ts
import { MODELS } from "../../config.js";
import type { Duration } from "../../core/world/brief.js";
import { logger } from "../../utils/log.js";
import { structured } from "../client.js";
import { PITCH_SYSTEM, pitchPrompt } from "./prompts.js";
import { PitchesSchema } from "./schemas.js";

/**
 * Four worlds to choose between, before one is paid for.
 *
 * With nothing typed, the lore pass invents a premise as a field of the world's lore — so
 * the first thing a player learns about the world they just bought four minutes of is that
 * they did not choose it. This turns that into a decision, for one call on the cheap side
 * of a bill that is about to be sixty.
 *
 * The *prose* model, not the fast one, and that is the whole reason this is its own call
 * rather than a cheap aside: the player reads every word of these and picks between them on
 * the strength of the writing. It is the same tier the lore pass uses, for the same reason.
 *
 * Deliberately knows nothing about surveys, worlds or seeds. It cannot: the premise decides
 * the scenario's id and the id decides the seed, so this runs before any of that exists.
 */

export interface Pitch {
	readonly title: string;
	readonly tone: string;
	readonly premise: string;
}

export interface PitchRequest {
	readonly duration: Duration;
	/** Whatever the player has typed so far, if anything. Followed rather than embellished. */
	readonly hint?: string;
	readonly count?: number;
	/** Titles already offered and passed over, so "more" produces more rather than again. */
	readonly avoid?: readonly string[];
	readonly signal?: AbortSignal;
}

/** Four fits a short terminal without scrolling, and is enough to see a range in. */
export const DEFAULT_PITCH_COUNT = 4;

/**
 * Long enough for a reasoning model to answer, short enough that a player who pressed a key
 * on a launcher screen is not left looking at a spinner wondering if it hung. Shorter than
 * the authoring passes get, because this one has somebody watching it in real time.
 */
const PITCH_TIMEOUT_MS = 45_000;

export async function suggestPitches(input: PitchRequest): Promise<readonly Pitch[]> {
	const count = input.count ?? DEFAULT_PITCH_COUNT;
	const response = await structured({
		kind: "pitch",
		model: MODELS.bible,
		schema: PitchesSchema,
		system: PITCH_SYSTEM,
		prompt: pitchPrompt({
			duration: input.duration,
			count,
			...(input.hint ? { hint: input.hint } : {}),
			...(input.avoid && input.avoid.length > 0 ? { avoid: input.avoid } : {}),
		}),
		// Higher than the authoring passes run at. These are meant to differ from one another
		// and from the last four, which is the one job a low temperature is bad at.
		temperature: 1,
		timeoutMs: PITCH_TIMEOUT_MS,
		...(input.signal ? { signal: input.signal } : {}),
	});

	if (!response) {
		// No throw and no fallback of our own. The page offers the player the text field they
		// would have used anyway, which is a better answer than four worlds we invented
		// procedurally and presented as if a model had written them.
		logger.warn("no premises came back; the player types their own");
		return [];
	}
	return response.pitches.slice(0, count);
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ai/author/pitch.test.ts && npm run typecheck`

Expected: PASS, 6 tests.

- [x] **Step 5: Commit**

```bash
git add src/ai/author/pitch.ts src/ai/author/pitch.test.ts src/ai/telemetry.ts src/ai/author/schemas.ts src/ai/author/prompts.ts
git commit -m "Ask for four worlds to choose between

With nothing typed, the lore pass invents a premise as a field of the world's
lore — so the first thing a player learns about a world they just paid four
minutes for is that they did not choose it.

The prose model rather than the fast one, which is why this is its own call:
the player reads every word and picks on the strength of the writing. And it
knows nothing about surveys or seeds, because it cannot — the premise decides
the id and the id decides the seed, so this runs before any of that exists.

The titles already refused are named in the prompt rather than described,
because 'offer something different' is advice a model can satisfy without
changing anything, and a 'more' key that returns four paraphrases reads as
broken.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Make the choice binding

A title the player picked and did not get is worse than never having been asked. The prompt is told, *and* the answer is overwritten — asking a model to preserve a field and then trusting it is how the field gets quietly rewritten.

**Files:**
- Modify: `src/ai/director/prompt.ts:57-79` (`lorePrompt`)
- Modify: `src/ai/author/author.ts:275-287`
- Test: `src/ai/director/prompt.test.ts` — exists, and already tests `lorePrompt`.
- **Create**: `src/ai/author/author.test.ts`

**Note on shape.** `authorScenario` has no test file — verified, `src/ai/author/` contains tests for `lower`, `mend`, `polish`, `prompts` and `reactions` and nothing for `author.ts` itself. It is a ~200-line function that runs six passes, so testing the binding through it would mean stubbing every one of them to assert one field. So the binding is **extracted as a named exported function** and tested directly. That is worth doing on its own terms: "the player's title wins" is a rule, and a rule buried mid-function is a rule the next person deletes by accident.

**Interfaces:**
- Consumes: `ScenarioBrief.title` (Task 1).
- Produces: `bindLore(written: WorldLore, brief: ScenarioBrief | undefined): WorldLore`, exported from `src/ai/author/author.ts`.

- [x] **Step 1: Write the failing tests**

Create `src/ai/author/author.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bindLore } from "./author.js";

/**
 * Whose world it is.
 *
 * The lore pass is asked to keep a title the player chose, and asking is not enough: a
 * model told to preserve a field preserves it most of the time, and the times it does not
 * are a player who picked a world by its name being overruled by a machine on the one
 * decision they made before paying for it. So the answer is overwritten rather than
 * trusted, and this is the rule stated where it can be read.
 */

const WRITTEN = {
	title: "Something Else Entirely",
	premise: "The tide came in and did not go out.",
	era: "late bronze",
	tone: "jaunty",
	factions: ["the collectors", "the glassmen"],
	deities: ["the drowned saint"],
};

describe("binding the lore to what the player chose", () => {
	it("keeps the player's title and tone over whatever came back", () => {
		const lore = bindLore(WRITTEN, { title: "The Tide-Glass", tone: "sombre" });
		expect(lore.title).toBe("The Tide-Glass");
		expect(lore.tone).toBe("sombre");
	});

	it("leaves everything else to the model, including how it phrased the premise", () => {
		// The binding is two fields, not a takeover. The era, the factions, the deities and
		// the premise as written are the pass's own work and stay that way.
		const lore = bindLore(WRITTEN, { title: "The Tide-Glass" });
		expect(lore.premise).toBe(WRITTEN.premise);
		expect(lore.era).toBe(WRITTEN.era);
		expect(lore.factions).toEqual(WRITTEN.factions);
		// Tone was not chosen, so it is still the model's.
		expect(lore.tone).toBe("jaunty");
	});

	it("changes nothing at all for a world nobody named", () => {
		expect(bindLore(WRITTEN, { premise: "A drowned archipelago." })).toEqual(WRITTEN);
		expect(bindLore(WRITTEN, undefined)).toEqual(WRITTEN);
	});

	it("ignores a title that is only whitespace", () => {
		// Briefs arrive from environment variables and text fields, so a blank one has to
		// read as silence rather than as an instruction to call the world "".
		expect(bindLore(WRITTEN, { title: "   " }).title).toBe(WRITTEN.title);
	});
});
```

And in `src/ai/director/prompt.test.ts`, beside the existing `lorePrompt` cases:

```ts
	it("states a chosen title as settled rather than as a suggestion", () => {
		const prompt = lorePrompt({ title: "The Tide-Glass", premise: "A drowned archipelago." });
		expect(prompt).toContain("The Tide-Glass");
		expect(prompt).toMatch(/already called/i);
	});

	it("says nothing about a name when nobody chose one", () => {
		expect(lorePrompt({ premise: "A drowned archipelago." })).not.toMatch(/already called/i);
	});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ai/author src/ai/director`

Expected: FAIL — the title is whatever the stub returned.

- [x] **Step 3: Tell the prompt, then overwrite the answer**

In `src/ai/director/prompt.ts`, inside `lorePrompt`, after the `briefLines(brief)` spread and before the closing scale guidance, add:

```ts
		...(brief.title
			? [
					"",
					`This world is already called "${brief.title}". Use that name exactly; do not`,
					"rename it or add a subtitle.",
				]
			: []),
		...(brief.tone
			? [`Its register is already settled: ${brief.tone}. Write everything in it.`]
			: []),
```

The no-brief branch above is untouched: a brief carrying a title is not an empty brief, so it never reaches that path (`isBriefEmpty` counts the title — Task 1).

In `src/ai/author/author.ts`, add the rule as its own function — placed immediately above
`authorScenario` so it is read before the pass that uses it:

```ts
/**
 * The lore, with the player's own choices put back over it.
 *
 * `lorePrompt` asks for these too, and asking is not enough on its own: a model told to
 * preserve a field preserves it most of the time, and the times it does not are a player who
 * picked a world by its name being overruled by a machine on the one decision they made
 * before paying for it.
 *
 * Two fields and no more. The era, the factions, the deities and the premise as the model
 * chose to phrase it are the pass's own work, and a brief that named a world is not a brief
 * that wrote one.
 *
 * Exported for its test: the pass around it runs six model calls, and a rule buried inside
 * one of them is a rule the next person deletes by accident.
 */
export function bindLore(written: WorldLore, brief: ScenarioBrief | undefined): WorldLore {
	const title = brief?.title?.trim();
	const tone = brief?.tone?.trim();
	if (!title && !tone) return written;
	return {
		...written,
		...(title ? { title } : {}),
		...(tone ? { tone } : {}),
	};
}
```

`ScenarioBrief` is already imported in that file; check and add if not.

Then replace the lore pass's tail:

```ts
	const written =
		(await structured({
			kind: "bible",
			model: MODELS.bible,
			schema: WorldLoreSchema,
			system: LORE_SYSTEM,
			prompt: lorePrompt(options.brief),
			temperature: 1,
			timeoutMs: AUTHOR_TIMEOUT_MS,
			...abortable,
		})) ?? fallbackLore();
	const lore = bindLore(written, options.brief);
	calls++;
	say(`lore: ${lore.title}`);
	stopIfAsked("the lore");
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ai && npm run typecheck`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/ai/director/prompt.ts src/ai/director/prompt.test.ts src/ai/author/author.ts src/ai/author/author.test.ts
git commit -m "Give the world the name the player chose

Told to the prompt and then enforced on the answer, which is not belt and
braces: a model asked to preserve a field preserves it most of the time, and
the times it does not are a player who picked a world by its name being
overruled on the one decision they made before paying for it.

Everything else in the lore is still the model's — the era, the factions, the
deities, and the premise as it chose to phrase it.

The rule is a named function rather than four lines inside a two-hundred-line
pass, because authorScenario has no test of its own and testing this through it
would mean stubbing six model calls to assert one field. It also stops being
something the next person deletes by accident.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The title names the file

**Files:**
- Modify: `src/scenario/generate.ts` (`freeScenarioId` and its one caller)
- Test: `src/scenario/generate.test.ts`

**Interfaces:**
- Consumes: `ScenarioBrief.title` (Task 1).
- Produces: `freeScenarioId(brief: ScenarioBrief | undefined, taken: readonly string[]): string` — **signature change**, from `(premise, taken)`. Track C's reseed calls this.

- [x] **Step 1: Write the failing test**

In `src/scenario/generate.test.ts`, beside the existing `freeScenarioId` cases:

```ts
	it("names the file after the title when there is one", () => {
		// `.scenarios` is a directory a person reads. "the-tide-glass-of-wodedesert" is a
		// shelf of books; "a-drowned-archipelago-run-by" is a list of pitches.
		expect(freeScenarioId({ title: "The Tide-Glass of Wodedesert", premise: "Debt." }, [])).toBe(
			"the-tide-glass-of-wodedesert",
		);
	});

	it("falls back to the premise for a world nobody named", () => {
		expect(freeScenarioId({ premise: "a siege that has gone on nine years" }, [])).toBe(
			"a-siege-that-has-gone",
		);
	});

	it("still refuses to overwrite a world of the same name", () => {
		expect(freeScenarioId({ title: "The Tide-Glass" }, ["the-tide-glass"])).toBe(
			"the-tide-glass-2",
		);
	});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/scenario/generate.test.ts`

Expected: FAIL — `freeScenarioId` takes a string, so passing an object does not compile.

- [x] **Step 3: Take the brief instead of the premise**

In `src/scenario/generate.ts`:

```ts
/**
 * A filename nothing else has taken, from what the player asked for.
 *
 * The title first, because `.scenarios` is a directory a person reads and a shelf of book
 * names beats a list of pitches. The premise second, which is what every world written
 * before there was a title to give has. Two worlds asked for in the same words must not
 * overwrite each other, so a taken slug gets a number, and a brief with neither falls back
 * to a fixed stem.
 */
export function freeScenarioId(brief: ScenarioBrief | undefined, taken: readonly string[]): string {
	const already = new Set(taken);
	const stem = slug(brief?.title) || slug(brief?.premise) || "a-world";
	if (!already.has(stem)) return stem;
	for (let n = 2; ; n++) {
		const candidate = `${stem}-${n}`;
		if (!already.has(candidate)) return candidate;
	}
}
```

Add `import type { ScenarioBrief } from "../core/world/brief.js";` and change the call site from `freeScenarioId(request.brief.premise, taken())` to `freeScenarioId(request.brief, taken())`.

Note `slug` takes the first five words, so a long title is truncated the same way a premise always was — which is why the first test above expects five words and not six.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/scenario && npm run typecheck`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/scenario/generate.ts src/scenario/generate.test.ts
git commit -m "Name a scenario file after the world, not the pitch

.scenarios is a directory a person reads. The premise made a serviceable slug
and a poor name — 'a-drowned-archipelago-run-by' is the sentence somebody typed
into a box, where 'the-tide-glass-of-wodedesert' is the world it produced.

freeScenarioId takes the brief now rather than the premise string, so the
fallback for a world nobody named is exactly the behaviour every existing
scenario was written under.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The page that shows them

**Files:**
- Create: `src/ui/launcher/pick-premise.tsx`
- Create: `src/ui/launcher/pick-premise.test.tsx`

**Interfaces:**
- Consumes: `Pitch` (Task 2), `Chooser`/`ChoiceItem` from `./chooser.js`, `Frame`/`FRAME_CHROME` from `../panels/primitives.js`, `rampRows` from `./gradient.js`, `ColorDepth`/`rgb` from `../render/color.js`.
- Produces: `PickPremise` component with props `{ columns, rows, depth, duration, hint?, suggest, onChoose, onBack, isActive? }` where `suggest: (input: { hint?: string; avoid?: readonly string[] }) => Promise<readonly Pitch[]>` and `onChoose: (pitch: Pitch) => void`. Task 6 mounts it.

- [x] **Step 1: Write the failing test**

Create `src/ui/launcher/pick-premise.test.tsx`:

`renderInk` already returns a `screen()` that strips ANSI (`test/harness/ink.tsx:156`), so use
`m.ink.screen()` rather than wrapping `lastFrame` again.

```tsx
import { describe, expect, it, vi } from "vitest";
import { KEY, renderInk } from "../../../test/harness/ink.js";
import type { Pitch } from "../../ai/author/pitch.js";
import { PickPremise } from "./pick-premise.js";

/**
 * Four worlds, and a decision the player makes before paying rather than after.
 *
 * The call is injected because this page has to render in a test with no gateway key —
 * the same rule the rest of the launcher follows for the disk.
 */

const FOUR: Pitch[] = [
	{ title: "The Tide-Glass", tone: "sombre", premise: "A drowned archipelago run by collectors." },
	{ title: "The Ledger of Saint Wain", tone: "wry", premise: "A monastery audits its miracles." },
	{ title: "Nine Years at the Gate", tone: "weary", premise: "A siege nobody remembers starting." },
	{ title: "The Salt Road", tone: "hard", premise: "The caravans have stopped coming through." },
];

function mount(props: Partial<Parameters<typeof PickPremise>[0]> = {}) {
	const chosen: Pitch[] = [];
	const backs: number[] = [];
	const suggest = vi.fn(async () => FOUR);
	const ink = renderInk(
		<PickPremise
			columns={100}
			rows={24}
			depth="none"
			duration="medium"
			suggest={suggest}
			onChoose={(pitch) => chosen.push(pitch)}
			onBack={() => backs.push(1)}
			{...props}
		/>,
		{ columns: 100, rows: 24 },
	);
	return { ink, chosen, backs, suggest, screen: ink.screen };
}

describe("choosing a premise", () => {
	it("says it is working rather than sitting blank while the call runs", () => {
		// A launcher screen that shows nothing for several seconds is one a player assumes
		// has hung, and this is the first model call of the whole session.
		const m = mount({ suggest: vi.fn(() => new Promise<readonly Pitch[]>(() => undefined)) });
		expect(m.screen()).toMatch(/writing|thinking|working/i);
		m.ink.unmount();
	});

	it("shows each world's name, its register and what it is about", async () => {
		const m = mount();
		await m.ink.settle();
		const text = m.screen();
		expect(text).toContain("The Tide-Glass");
		expect(text).toContain("sombre");
		expect(text).toContain("drowned archipelago");
		m.ink.unmount();
	});

	it("hands back the whole bundle, not just the words", async () => {
		const m = mount();
		await m.ink.settle();
		await m.ink.type(KEY.enter);
		expect(m.chosen).toHaveLength(1);
		expect(m.chosen[0]?.title).toBe("The Tide-Glass");
		expect(m.chosen[0]?.tone).toBe("sombre");
		expect(m.chosen[0]?.premise).toContain("drowned archipelago");
		m.ink.unmount();
	});

	it("asks for more without offering the same four again", async () => {
		const m = mount();
		await m.ink.settle();
		await m.ink.type("m");
		await m.ink.settle();

		expect(m.suggest).toHaveBeenCalledTimes(2);
		const second = m.suggest.mock.calls[1]?.[0] as { avoid?: readonly string[] };
		// Named rather than merely counted: a model with no memory between calls will
		// otherwise return four rewordings and the key will read as broken.
		expect(second.avoid).toContain("The Tide-Glass");
		m.ink.unmount();
	});

	it("passes on what the player had already typed", async () => {
		const m = mount({ hint: "something about debt" });
		await m.ink.settle();
		const first = m.suggest.mock.calls[0]?.[0] as { hint?: string };
		expect(first.hint).toBe("something about debt");
		m.ink.unmount();
	});

	it("says so and steps aside when nothing comes back", async () => {
        // A page that cannot be left is worse than a page that failed: the player still has
        // to be able to go and type their own.
		const m = mount({ suggest: vi.fn(async () => [] as readonly Pitch[]) });
		await m.ink.settle();
		expect(m.screen()).toMatch(/could not|nothing came back/i);
		await m.ink.type(KEY.escape);
		expect(m.backs).toHaveLength(1);
		m.ink.unmount();
	});

	it("goes back on ESC without choosing anything", async () => {
		const m = mount();
		await m.ink.settle();
		await m.ink.type(KEY.escape);
		expect(m.backs).toHaveLength(1);
		expect(m.chosen).toHaveLength(0);
		m.ink.unmount();
	});
});
```

Read `test/harness/ink.js` and an existing launcher test first, and match the real `settle`/`type` signatures.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/launcher/pick-premise.test.tsx`

Expected: FAIL — cannot resolve `./pick-premise.js`.

- [x] **Step 3: Write the page**

Create `src/ui/launcher/pick-premise.tsx`:

```tsx
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Pitch } from "../../ai/author/pitch.js";
import type { Duration } from "../../core/world/brief.js";
import { FRAME_CHROME, Frame } from "../panels/primitives.js";
import { type ColorDepth, rgb } from "../render/color.js";
import { type ChoiceItem, Chooser } from "./chooser.js";
import { rampRows } from "./gradient.js";

/**
 * Four worlds, offered before one is paid for.
 *
 * The screen this exists to replace was a blank text field and a line saying the model would
 * pick a premise if it was left empty — which most players did, and which meant the first
 * thing they learned about a world they had just waited four minutes for was that nobody had
 * chosen it. A premise is the one decision that shapes everything downstream and the one
 * they had least help making.
 *
 * The call runs here rather than in `pickLaunch`, which is where the rest of the launcher's
 * model work is forbidden from happening. The rule it bends is real — an Ink app that awaits
 * for minutes is one that gets unmounted mid-`await` — and this is the case it does not
 * cover: one call, seconds not minutes, abortable, and useless anywhere else, because the
 * player has to see the answers to make the choice that produces the request.
 */

const CHROME = FRAME_CHROME + 4;

/** The heading, its blank, and the footer. */
const PAGE_CHROME = 3;

const RAMP = { from: rgb("#f0c674"), to: rgb("#4f7fd4") };

export interface PickPremiseProps {
	readonly columns: number;
	readonly rows: number;
	readonly depth: ColorDepth;
	/** How long the world will be, which changes what fits inside one. */
	readonly duration: Duration;
	/** Whatever the player had already typed, followed rather than embellished. */
	readonly hint?: string;
	/**
	 * The call, injected.
	 *
	 * The same rule the options page follows for the disk: this component has to render in a
	 * test with no gateway key, so it is handed the thing that needs one.
	 */
	readonly suggest: (input: {
		readonly hint?: string;
		readonly avoid?: readonly string[];
	}) => Promise<readonly Pitch[]>;
	readonly onChoose: (pitch: Pitch) => void;
	readonly onBack: () => void;
	readonly isActive?: boolean;
}

export function PickPremise({
	columns,
	rows,
	depth,
	duration,
	hint,
	suggest,
	onChoose,
	onBack,
	isActive = true,
}: PickPremiseProps) {
	const [pitches, setPitches] = useState<readonly Pitch[]>([]);
	const [working, setWorking] = useState(true);
	const [failed, setFailed] = useState(false);
	/*
	 * Every title offered so far, across every round.
	 *
	 * A ref rather than state because it is read inside the async callback below, where a
	 * captured piece of state would be whatever it was when the round started — so the third
	 * round would forget the first. Nothing renders from it, so nothing needs it to be state.
	 */
	const offered = useRef<string[]>([]);

	const ask = useCallback(async () => {
		setWorking(true);
		setFailed(false);
		// Never throws by contract, but this runs in a React effect where a rejected promise
		// is an unhandled rejection rather than a caught error, and a launcher that dies
		// because a premise could not be written is a launcher nobody can get past.
		let next: readonly Pitch[] = [];
		try {
			next = await suggest({
				...(hint ? { hint } : {}),
				...(offered.current.length > 0 ? { avoid: [...offered.current] } : {}),
			});
		} catch {
			next = [];
		}
		if (next.length === 0) {
			setFailed(true);
			setWorking(false);
			return;
		}
		offered.current = [...offered.current, ...next.map((pitch) => pitch.title)];
		setPitches(next);
		setWorking(false);
	}, [hint, suggest]);

	useEffect(() => {
		void ask();
	}, [ask]);

	// `M` is handled here rather than through the chooser's own key hook, because the chooser
	// is not mounted while a round is in flight and a key that only works between rounds is a
	// key that reads as broken.
	useInput(
		(input, key) => {
			if (key.escape) {
				onBack();
				return;
			}
			if (working) return;
			if (input.toLowerCase() === "m") void ask();
		},
		{ isActive },
	);

	const heading = rampRows([HEADING], RAMP, depth)[0] ?? HEADING;
	const inner = columns - CHROME;

	if (working) {
		return (
			<Frame style="menu" width={columns} height={rows}>
				<Box marginBottom={1}>
					<Text bold>{heading}</Text>
				</Box>
				<Box flexGrow={1}>
					<Text>
						<Text color="cyan">
							<Spinner type="dots" />
						</Text>
						<Text dimColor>{"  writing a few, which takes a moment"}</Text>
					</Text>
				</Box>
				<Text dimColor wrap="truncate">
					ESC to type one of your own instead
				</Text>
			</Frame>
		);
	}

	if (failed) {
		return (
			<Frame style="menu" width={columns} height={rows}>
				<Box marginBottom={1}>
					<Text bold>{heading}</Text>
				</Box>
				<Box flexGrow={1}>
					<Text color="yellow" wrap="truncate">
						Nothing came back. The world can still be written — say what it should be about
						yourself, or leave it and let the model choose as it writes.
					</Text>
				</Box>
				<Text dimColor wrap="truncate">
					M to try again · ESC to go back
				</Text>
			</Frame>
		);
	}

	const items: ChoiceItem[] = pitches.map((pitch, index) => ({
		id: `pitch:${index}:${pitch.title}`,
		label: pitch.title,
		detail: pitch.tone,
		body: pitch.premise,
		accent: SHELF[index % SHELF.length] as string,
	}));

	return (
		<Frame style="menu" width={columns} height={rows}>
			<Box marginBottom={1}>
				<Text bold>{heading}</Text>
				<Text dimColor>{`  ${duration}, and any of them can be edited after`}</Text>
			</Box>

			<Box flexGrow={1} flexDirection="column">
				<Chooser
					items={items}
					width={inner}
					height={rows - FRAME_CHROME - PAGE_CHROME}
					isActive={isActive}
					onBack={onBack}
					onChoose={(item) => {
						const at = items.findIndex((each) => each.id === item.id);
						const pitch = pitches[at];
						if (pitch) onChoose(pitch);
					}}
				/>
			</Box>

			<Text dimColor wrap="truncate">
				{"↑↓ read · ENTER choose · M four more · ESC type my own"}
			</Text>
		</Frame>
	);
}

/**
 * Colours the offers are labelled with, in order.
 *
 * The same shelf `new-world.tsx` uses for written scenarios, and for the same reason: the
 * list should read as several distinct things at a glance. Cyan is absent because the cursor
 * needs it, and a list where every row is coloured has no colour left to mean "here".
 */
const SHELF: readonly string[] = ["green", "magenta", "yellow", "blue", "red", "white"];

const HEADING = "Choose a world";
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/launcher/pick-premise.test.tsx && npm run typecheck`

Expected: PASS, 7 tests.

- [x] **Step 5: Commit**

```bash
git add src/ui/launcher/pick-premise.tsx src/ui/launcher/pick-premise.test.tsx
git commit -m "A page that offers four worlds to choose between

The screen this replaces was an empty text field and a line saying the model
would pick if it was left blank — which most players did, so the first thing
they learned about a world they had waited four minutes for was that nobody had
chosen it.

The call runs in the component, which is the one place the launcher otherwise
forbids model work. The rule is real — an Ink app that awaits for minutes gets
unmounted mid-await — and this is the case it does not cover: one call, seconds
not minutes, abortable, and impossible anywhere else, since the player has to
read the answers to make the choice that produces the request.

The titles offered so far live in a ref rather than state, because the async
round reads them and captured state would be whatever it was when the round
started — so the third round would forget the first.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Wire it into the Premise row

**Files:**
- Modify: `src/ui/launcher/generate-config.tsx`
- Modify: `src/ui/launcher/launcher.tsx`
- Modify: `src/ui/launcher/pick-launch.tsx`
- Test: `src/ui/launcher/launcher.test.tsx`

**Interfaces:**
- Consumes: `PickPremise` (Task 5), `suggestPitches` (Task 2), `ScenarioBrief.title` (Task 1).
- Produces: `GenerateConfigProps.onSuggest?`, `LauncherProps.onSuggest?`; the emitted `GenerateRequest.brief` carries `title` and `tone` when a bundle was chosen.

- [x] **Step 1: Write the failing test**

In `src/ui/launcher/launcher.test.tsx`, in the config-page describe block:

```ts
	it("offers to write a few premises rather than only an empty box", async () => {
		const m = mount();
		await toConfig(m);
		await toRow(m, "Premise");
		await m.ink.type(KEY.enter);
		expect(m.ink.screen()).toContain("Suggest");
		m.ink.unmount();
	});

	it("puts a chosen world's title and tone on the request, not just its premise", async () => {
		// The whole point of binding the bundle: a player who picked a world by its name gets
		// that name, and the register they picked with it.
		const m = mount({
			onSuggest: async () => [
				{ title: "The Tide-Glass", tone: "sombre", premise: "A drowned archipelago." },
			],
		});
		await toConfig(m);
		await toRow(m, "Premise");
		await m.ink.type(KEY.enter);

		await toRow(m, "Suggest some for me");
		await m.ink.type(KEY.enter);
		// The call is a promise, so the list is not on screen until the frames settle.
		await m.ink.settle();

		await toRow(m, "The Tide-Glass");
		await m.ink.type(KEY.enter);

		await toRow(m, "Write this world");
		await m.ink.type(KEY.enter);

		expect(m.requested[0]?.brief).toMatchObject({
			title: "The Tide-Glass",
			tone: "sombre",
			premise: "A drowned archipelago.",
		});
		m.ink.unmount();
	});

	it("still lets a premise be typed", async () => {
		const m = mount();
		await toConfig(m);
		await toRow(m, "Premise");
		await m.ink.type(KEY.enter);
		await toRow(m, "Type it myself");
		await m.ink.type(KEY.enter);
		expect(m.ink.screen()).toContain("A sentence is plenty");
		m.ink.unmount();
	});
```

`toRow` navigates by looking for `❯ <label>` on screen rather than by counting presses
(`launcher.test.tsx:166-172`), so the two calls that land on a row already under the cursor
are free — they are there so the test survives the rows being reordered.

`mount` needs one new option. Add `onSuggest?: GenerateConfigProps["onSuggest"]` to its
options object (`launcher.test.tsx:57-72`) and forward it to the rendered `<Launcher>` the
same way `gatewayKey` and `modelSet` already are — conditionally spread, since
`exactOptionalPropertyTypes` is on:

```tsx
			{...(options.onSuggest ? { onSuggest: options.onSuggest } : {})}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/launcher/launcher.test.tsx`

Expected: FAIL — ENTER on Premise opens the text field directly, so "Suggest" is not on screen.

- [x] **Step 3: Add the three-way, the state, and the prop chain**

In `src/ui/launcher/generate-config.tsx`:

Add to props:

```ts
	/**
	 * Writes a few worlds to choose between, when there is a model to write them with.
	 *
	 * Absent means the Premise row behaves as it always did — straight into the text field.
	 * Passed down rather than imported so this page renders in a test with no gateway key.
	 */
	readonly onSuggest?: (input: {
		readonly hint?: string;
		readonly avoid?: readonly string[];
	}) => Promise<readonly Pitch[]>;
```

Add state beside `premise`:

```ts
	// Set only by choosing an offered world. A premise typed by hand leaves both empty, which
	// is what keeps a hand-written brief behaving exactly as it did.
	const [title, setTitle] = useState("");
	const [tone, setTone] = useState("");
	// Which of the three ways into a premise is on screen: none, the chooser, or the field.
	const [premiseWay, setPremiseWay] = useState<"none" | "how" | "suggest" | "type">("none");
```

Replace `editing` with `premiseWay === "type"` throughout — the `Chooser`'s `isActive` and the `TextField` branch both.

Show the picker as its own page, before the frame:

```tsx
	if (premiseWay === "suggest" && onSuggest) {
		return (
			<PickPremise
				columns={columns}
				rows={rows}
				depth={depth}
				duration={duration}
				{...(premise.trim() ? { hint: premise.trim() } : {})}
				suggest={onSuggest}
				onChoose={(pitch) => {
					setTitle(pitch.title);
					setTone(pitch.tone);
					setPremise(pitch.premise);
					setPremiseWay("none");
				}}
				onBack={() => setPremiseWay("none")}
			/>
		);
	}
```

And the three-way, likewise a page of its own using `Chooser` with three items — `type` ("Type it myself"), `suggest` ("Suggest some for me", disabled with a reason when `onSuggest` is absent), and `model` ("Let the model choose", which clears the premise and returns). Put `suggest` first when it is available: it is the one the player cannot discover any other way.

Change the Premise row's `onChoose` from `setEditing(true)` to `setPremiseWay("how")`, and its `detail` to show the title when there is one:

```ts
			detail: title ? `“${clamp(title, 48)}”` : premise.trim() ? `“${clamp(premise.trim(), 48)}”` : "let the model choose",
```

Include both in the request:

```ts
								brief: normalizeBrief({ premise, title, tone, duration }) ?? { duration },
```

`normalizeBrief` drops the empty strings, so a hand-typed premise produces exactly the brief it produced before.

In `src/ui/launcher/launcher.tsx`: add `readonly onSuggest?: …` to `LauncherProps` with the same shape, and forward it to `<GenerateConfig {...(onSuggest ? { onSuggest } : {})} />`.

In `src/ui/launcher/pick-launch.tsx`: import `suggestPitches`, and pass

```tsx
			onSuggest={(input) =>
				suggestPitches({
					duration: CONFIG.brief?.duration ?? "medium",
					...input,
				})
			}
```

**Careful:** the duration on the config page is state, and the one above is the environment's. Pass the *page's* duration by having `GenerateConfig` supply it — the `PickPremise` mount above already does, so `onSuggest` should not take a duration at all. Keep `onSuggest`'s input to `{ hint, avoid }` and give `suggestPitches` its duration inside `GenerateConfig`… which cannot, since it does not import the AI layer. Resolve it by widening `onSuggest` to take `duration` too:

```ts
	readonly onSuggest?: (input: {
		readonly duration: Duration;
		readonly hint?: string;
		readonly avoid?: readonly string[];
	}) => Promise<readonly Pitch[]>;
```

and having `GenerateConfig` close over its own `duration` when it hands `suggest` to `PickPremise`:

```tsx
				suggest={(input) => onSuggest({ duration, ...input })}
```

Then `pick-launch.tsx` is simply `onSuggest={suggestPitches}`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui && npm run typecheck`

Expected: PASS.

- [x] **Step 5: Verify the whole repo**

Run: `npm run check`

Expected: typecheck clean, Biome clean, all tests pass.

- [x] **Step 6: Verify by hand, in the real program**

Needs `AI_GATEWAY_API_KEY`. If there is none, say so in the commit body rather than claiming a check that did not happen.

```bash
npm run start
```

Then: New → Generate a New Scenario → Premise → Suggest some for me. Confirm four worlds appear with names, registers and paragraphs; that `M` produces four *different* ones; that ENTER fills the Premise row with the chosen title; and that writing the world produces `.scenarios/<title-slug>.json` whose `lore.title` is the title you picked.

- [x] **Step 7: Commit**

```bash
git add src/ui/launcher src/scenario
git commit -m "Offer the premise rather than only asking for one

ENTER on the Premise row opened an empty box, and the line under it said the
model would pick if it was left blank. Most players left it blank, so the
premise — the one decision that shapes everything downstream — was the one they
had least help with.

Three ways in now, with suggesting first because it is the only one a player
cannot discover for themselves. A chosen world puts its title and its tone on
the brief alongside its premise, so the binding in author.ts has something to
bind to; a typed premise leaves both empty and produces exactly the brief it
always did.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Part B of the design specifies: one `structured` call on the prose model returning four `{title, tone, premise}` bundles with a new `"pitch"` CallKind and a `PitchesSchema` capped at 60/24/400 → Task 2. `ScenarioBrief` gaining `title` and `tone` with `normalizeBrief` handling them → Task 1 (tone already existed, which the plan states). The three-way chooser on the Premise row with `M` for four more and `ESC` back → Tasks 5 and 6. Binding enforced by overwriting `lore.title`/`lore.tone` after the call rather than trusting the prompt → Task 3. `freeScenarioId` preferring the title → Task 4. The spec's five testing bullets map to Task 2 Step 1 (stubbed `structured`, empty on failure), Task 1 Step 1 (`normalizeBrief`), Task 4 Step 1 (id preference and de-duplication), Task 3 Step 1 (title survives whatever the model returned), Task 5 Step 1 (the page renders and reports).

**Type consistency.** `Pitch` is defined in Task 2 and used under that name in Tasks 5 and 6. `suggestPitches` keeps the signature Task 2 gives it, and Task 6 passes it as `onSuggest` after widening the input with `duration` — the widening is stated in Task 6 rather than left to be discovered. `freeScenarioId`'s signature changes in Task 4 and its single call site changes with it. `bindLore` is defined and exported in Task 3 and used only there.

**Files verified to exist before being referenced:** `src/core/world/brief.test.ts`, `src/scenario/repo.test.ts`, `src/ai/director/prompt.test.ts` (which already covers `lorePrompt`), `test/harness/ink.tsx`. `src/ai/author/author.test.ts` does **not** exist and is created by Task 3; `src/scenario/schema.test.ts` does not exist either, which is why Task 1's round-trip case goes in `repo.test.ts`.

**Three things the implementer should expect to fight:**

1. **Task 6's prop chain and the duration.** The duration lives in `GenerateConfig`'s state, the AI import must not, and `PickPremise` needs both. Task 6 works this through to `onSuggest({ duration, ...input })` — follow that rather than re-deriving it, because the two wrong answers (importing `suggestPitches` into the component, or reading `CONFIG.brief.duration` in `pick-launch`) both compile and both send the wrong length to the model.
2. **`premiseWay` replaces `editing`.** Every current use of `editing` in `generate-config.tsx` — the `Chooser`'s `isActive`, the `TextField` branch, and the footer text — has to move together, or the page will take arrow keys in two places at once.
3. **Task 6's `mount` helper.** The tests need one new option on it, and `exactOptionalPropertyTypes` means forwarding it as `onSuggest={options.onSuggest}` will not compile when it is absent — spread it conditionally, as Task 6 shows and as the neighbouring `gatewayKey` already does.

---

## What it took, in the end

Landed on `premise-picker`, six commits, one per task. `npm run check` clean: 2038 tests.
Five places the plan needed correcting, recorded here because each was a real thing rather
than a preference.

1. **Two `Chooser`s in the same position are one `Chooser`.** The plan has the three-way as
   a page of its own, and both it and the settings page are a `Frame` holding a `Chooser` in
   the same slot — so React reconciled them as one component and the new page opened on the
   *settings* cursor's row, which is the Premise row, which is the second choice. They are
   keyed apart now. That in turn means the settings list really does remount, where before it
   kept its cursor by accident of reconciliation, so `Chooser` gained an `initialId` and the
   page tells it to open on `premise`. Adding that prop was not in the plan and is the reason
   the four existing "type a premise" cases still pass unchanged in what they assert.
2. **ESC was answered twice.** `PickPremise` handles ESC itself — it has to, because the
   spinner and the failure screen have no chooser mounted — and the plan also hands `onBack`
   to the chooser inside it. Every mounted `useInput` fires, so one keypress went back two
   screens. Caught by the plan's own last test case.
3. **`freeScenarioId`'s existing cases moved with its signature.** The plan adds three cases
   and does not mention the four already there, which pass a `string`. They now pass a brief.
4. **Two prompt defects only a real model showed.** Asked for "two to four sentences" it
   wrote four long ones and `cappedText(400)` trimmed them, so every premise stopped
   mid-sentence — on the one screen where the paragraph is the whole content. The budget is
   stated in characters as well now. And the plan's scale line, taken from `lorePrompt`
   verbatim, put a literal blacksmith in all four pitches: beside a whole brief it reads as
   scale, and with nothing else to go on a model reads a named trade as casting.
5. **The model id is asserted as `MODELS.bible`,** not the string, which the plan sanctions
   as the fallback. The default catalogue row is a moving target.

**Verified against the gateway** for the pitch call alone: four bundles, four different
worlds, nothing repeated on a second round, nothing truncated. The walkthrough to a written
world was not run — sixty calls and several minutes of somebody's money — so Task 6's Step 6
is done only to the depth one cheap call reaches.
