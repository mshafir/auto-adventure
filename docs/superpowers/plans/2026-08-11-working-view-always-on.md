# Track A: The Working View, Always On — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the prompt-by-prompt record of a world being written always available — no toggle, no environment variable — with the debug log readable on the same screen and both kept on disk so a bad run can be read after the process that made it has gone.

**Architecture:** Three moves. Delete the gate (`enabled`, `setDebugAi`, `debugAi`, `DEBUG_AI`, `GenerateRequest.debug`, the config-page row) so `recordExchange` always records. Split logging into two sinks — a bounded in-memory ring that captures at debug level always, and the file, which keeps obeying `LOG_LEVEL`. Then a `.jsonl` sink beside the artifact that both streams append to, and which seeds the in-game view for a world this process did not write.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), React + Ink for the TUI, Vitest, Biome.

This is Track A of the design in `docs/superpowers/specs/2026-08-11-generation-integrity-design.md`. Tracks B (premise picker) and C (generation integrity) get their own plans. A is first because it is self-contained and because it makes C's failures readable while C is built.

## Global Constraints

- Node floor is `>=18`. No `AbortSignal.any`, no `Array.prototype.findLast` on typed arrays, nothing newer.
- ESM with explicit `.js` specifiers on every relative import, including from `.ts`/`.tsx` files.
- `exactOptionalPropertyTypes` is on: never pass `foo: undefined` for an optional field. Spread it conditionally — `...(x ? { x } : {})` — which is the pattern used throughout this codebase.
- The TUI owns stdout. Nothing outside `src/ui/` may write to stdout or stderr; diagnostics go through `logger`.
- Comments explain *why*, in prose, at the density of the surrounding file. This codebase's comments carry design rationale and history — match that. Do not add comments that restate the code.
- Verification command for the whole repo: `npm run check` (typecheck, then Biome, then Vitest). Single-file test runs: `npx vitest run <path>`.
- Test names in this codebase are sentences that finish "it …". Follow that.
- Never write a test that cannot fail. If a fixture would pass against the unfixed code, the fixture is wrong.

---

## File Structure

**Created:**
- `src/utils/log.test.ts` — tests for the ring. No test file exists for `log.ts` today.
- `src/ai/working-file.ts` — the `.jsonl` sink and its reader. Owns the on-disk format and nothing else; imports `transcript.ts` and `log.ts` and is imported by neither, so the dependency runs one way.
- `src/ai/working-file.test.ts`

**Modified:**
- `src/utils/log.ts` — add the ring; `emit` writes to both sinks.
- `src/ai/transcript.ts` — remove the gate; duration-scaled limit; `seedTranscript`.
- `src/ai/transcript.test.ts` — the "keeps nothing until somebody asks" case inverts.
- `src/scenario/scenario.ts:106-113` — drop `GenerateRequest.debug`.
- `src/config.ts:94` — drop `debugAi`.
- `src/ui/launcher/generate-config.tsx` — drop the `debug` state, the row, and the request field.
- `src/ui/launcher/pick-launch.tsx` — drop `setDebugAi`/`debugAi`; open the working file; size the transcript.
- `src/ui/launcher/generate-progress.tsx` — drop the `debug` prop; always offer `D`; add the `L` log pane.
- `src/ui/panels/transcript-view.tsx` — drop `recording`; render the log pane.
- `src/ui/hud-state.ts` — `panelTabs` loses its parameter.
- `src/ui/app.tsx` — stop passing `debugAi()`.
- `src/ui/panels/reader.tsx` — drop `debugAi`.
- `src/main.tsx` — drop `setDebugAi`; seed from the working file.
- `src/tools/author.ts:110` — drop the `--debug` flag.
- `src/ui/app.test.tsx`, `src/ui/launcher/generate-progress.test.tsx`, `src/ui/launcher/launcher.test.tsx` — the three test files that drive the gate.

---

### Task 1: A bounded log ring that captures at debug level always

`setDebugAi` used to lower the *file's* log level so that debug lines from the rest of the codebase would be recorded. That is the wrong lever: it makes `log.txt` grow on every run and still shows the player nothing, because the TUI owns stdout and the file is not somewhere they can read from. Split the two: the ring captures everything at debug level for the view, the file keeps obeying `LOG_LEVEL`.

**Files:**
- Modify: `src/utils/log.ts`
- Create: `src/utils/log.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LogLine` (`{ readonly at: number; readonly level: LogLevel; readonly text: string }`), `LOG_RING_LIMIT: number`, `logRing(): readonly LogLine[]`, `clearLogRing(): void`, `onLog(listener: () => void): () => void`. Task 3 subscribes via `onLog` and reads `logRing`; Task 5 reads `logRing`; Task 6 uses `LogLine`.

- [ ] **Step 1: Write the failing test**

Create `src/utils/log.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Two sinks, and the point is that they disagree.
 *
 * The file is for whoever set `LOG_LEVEL`; the ring is for the working view, which wants
 * the debug lines whether or not anybody asked the file for them. A ring that inherited
 * the file's threshold would be an empty pane on the one screen it exists to fill.
 *
 * `logFile` is read once at module load, so the temporary directory has to be in place
 * before the import — hence the dynamic import inside each test rather than at the top.
 */

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-log-"));
	process.env.LOG_FILE = path.join(dir, "log.txt");
	delete process.env.LOG_LEVEL;
	// Fresh module state per test: the threshold, the ring and the file path are all
	// module-level, and a ring left full by the previous test would make the limit
	// assertions below pass for the wrong reason.
	vi.resetModules();
});

afterEach(() => {
	delete process.env.LOG_FILE;
	delete process.env.LOG_LEVEL;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the log ring", () => {
	it("keeps a debug line the file's own threshold threw away", async () => {
		const { logger, logRing } = await import("./log.js");
		logger.debug("dropping late spec for committed site 42");

		expect(logRing().at(-1)?.text).toContain("committed site 42");
		expect(logRing().at(-1)?.level).toBe("debug");
		// The file is at `info` by default, so this line is deliberately not in it.
		expect(fs.existsSync(process.env.LOG_FILE as string)).toBe(false);
	});

	it("still writes to the file what the file asked for", async () => {
		const { logger } = await import("./log.js");
		logger.warn("gateway key is not set");

		const written = fs.readFileSync(process.env.LOG_FILE as string, "utf8");
		expect(written).toContain("WARN gateway key is not set");
	});

	it("drops the oldest rather than growing without end", async () => {
		const { logger, logRing, LOG_RING_LIMIT } = await import("./log.js");
		for (let i = 0; i < LOG_RING_LIMIT + 5; i++) logger.debug(`line ${i}`);

		expect(logRing()).toHaveLength(LOG_RING_LIMIT);
		// The tail survives: the newest line is the one somebody is looking at.
		expect(logRing().at(-1)?.text).toBe(`line ${LOG_RING_LIMIT + 4}`);
		expect(logRing()[0]?.text).toBe("line 5");
	});

	it("tells a listener when a line lands, and stops when it is let go", async () => {
		const { logger, onLog } = await import("./log.js");
		let heard = 0;
		const off = onLog(() => {
			heard++;
		});
		logger.info("one");
		logger.info("two");
		off();
		logger.info("three");

		expect(heard).toBe(2);
	});

	it("folds the extra arguments into the line, the way the file does", async () => {
		const { logger, logRing } = await import("./log.js");
		logger.debug("brief", { premise: "a drowned archipelago" });

		expect(logRing().at(-1)?.text).toContain("a drowned archipelago");
	});
});
```

Add `vi` to the import: the first line of the file becomes

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/utils/log.test.ts`

Expected: FAIL — `logRing`, `LOG_RING_LIMIT` and `onLog` are not exported from `./log.js`.

- [ ] **Step 3: Add the ring**

In `src/utils/log.ts`, replace the module doc comment's second paragraph and add the ring. The full set of edits:

Replace the doc comment above `let threshold`:

```ts
/**
 * The TUI owns stdout, so logs go to a file. `LOG_LEVEL` gates them and
 * `LOG_FILE` relocates them; both default to something sane for a dev run.
 *
 * Two sinks rather than one, and they deliberately disagree about what counts. The
 * *file* is for whoever set `LOG_LEVEL`. The *ring* below is for the working view, which
 * wants the debug lines whether or not anybody asked the file for them — and a file is
 * not somewhere a player can read from anyway, since they are inside a full-screen
 * terminal application at the time.
 *
 * This replaces a worse arrangement, where asking for the prompt-by-prompt view lowered
 * the file's threshold globally for the rest of the run. That made `log.txt` grow on
 * every run that wanted the view and still showed the player nothing.
 *
 * `setLogLevel` remains, because `LOG_LEVEL=debug` is still how somebody asks the *file*
 * for everything.
 */
```

Then, after the `threshold`/`logFile` declarations, add:

```ts
export interface LogLine {
	/** Epoch milliseconds, so a reader can show the gap between two lines. */
	readonly at: number;
	readonly level: LogLevel;
	/** The formatted line, without the timestamp and level the file prefixes. */
	readonly text: string;
}

/**
 * How many lines the ring holds.
 *
 * A generation run writes tens of lines, not thousands; this is sized for a whole
 * session of play on top of one, and bounded rather than unbounded because the
 * alternative is a debug feature that eventually ends the session it exists to explain.
 */
export const LOG_RING_LIMIT = 2000;

const ring: LogLine[] = [];
const listeners = new Set<() => void>();

export function logRing(): readonly LogLine[] {
	return ring;
}

/** Reset between tests, and between one generation run and the next. */
export function clearLogRing(): void {
	ring.length = 0;
	announce();
}

export function onLog(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function announce(): void {
	for (const listener of listeners) listener();
}
```

Replace `emit` entirely:

```ts
function emit(level: LogLevel, data: unknown, params: unknown[]) {
	const extra = params.length > 0 ? ` ${params.map(format).join(" ")}` : "";
	const text = `${format(data)}${extra}`;
	const at = Date.now();

	/*
	 * The ring first, and unconditionally.
	 *
	 * Formatting eagerly is what this costs, and the early return it replaces was
	 * guarding nothing worth guarding: every `logger.debug` in the codebase is once per
	 * model call, once per beat or once per authored site — none is inside chunk
	 * generation or any per-tile loop. So the price of a line nobody reads is a template
	 * string, and the price of not doing it is an empty pane on the working view.
	 */
	ring.push({ at, level, text });
	if (ring.length > LOG_RING_LIMIT) ring.splice(0, ring.length - LOG_RING_LIMIT);
	announce();

	if (LEVELS[level] < threshold) return;
	write(`[${new Date(at).toISOString()}] ${level.toUpperCase()} ${text}\n`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/utils/log.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 5: Confirm nothing else broke**

Run: `npm run typecheck && npx vitest run src/utils src/ai`

Expected: PASS. `emit`'s signature is unchanged, so no call site moves.

- [ ] **Step 6: Commit**

```bash
git add src/utils/log.ts src/utils/log.test.ts
git commit -m "Give the log a second sink the working view can read

The file is for whoever set LOG_LEVEL. The ring is for the view, which wants
the debug lines regardless — and asking for it used to mean lowering the file's
threshold for the whole run, which grew log.txt on every run that wanted the
view and still showed the player nothing, a file being no use to somebody
inside a full-screen program.

Formatting is eager now, which the early return was guarding against for no
gain: every logger.debug in the codebase is once per model call, per beat or
per authored site, and none is in chunk generation or a per-tile loop.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Remove the gate and size the transcript by duration

The recording is complete and correct; it is simply switched off. Deleting the switch is most of this task. The limit becomes duration-scaled because eviction drops from the *head*, so a retry-heavy `long` run currently throws away the shape and lore passes — the two most interesting exchanges in the file.

**Files:**
- Modify: `src/ai/transcript.ts`
- Modify: `src/ai/transcript.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `sizeTranscript(duration: Duration | undefined): void`, `transcriptLimit(): number`, `DEFAULT_TRANSCRIPT_LIMIT: number`, `seedTranscript(exchanges: readonly Exchange[]): void`. Removed: `setDebugAi`, `debugAi`, `TRANSCRIPT_LIMIT`. Task 3 calls `seedTranscript`; Task 4 calls `sizeTranscript`; Tasks 4–7 delete the callers of the removed names.

- [ ] **Step 1: Write the failing test**

In `src/ai/transcript.test.ts`, replace the whole file's header block, imports, hooks and the first test. The remaining tests lose their `setDebugAi(true)` lines.

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearTranscript,
	DEFAULT_TRANSCRIPT_LIMIT,
	recordExchange,
	seedTranscript,
	sizeTranscript,
	transcript,
	transcriptLimit,
} from "./transcript.js";

/**
 * Keeping the working.
 *
 * It used to be off unless asked for, and the off case carried the weight of this file.
 * That switch is gone: a debug view nobody can find is a debug view nobody uses, and the
 * cost it was protecting against — holding every prompt of a run — is bounded by the
 * limit below and paid only while a world is being written.
 */

const CALL = {
	kind: "site" as const,
	model: "google/gemini-2.5-flash",
	system: "You name places.",
	prompt: "A village on a river.\nTwelve buildings.",
	millis: 812,
	attempt: 1,
};

beforeEach(() => {
	sizeTranscript(undefined);
	clearTranscript();
});

afterEach(() => {
	sizeTranscript(undefined);
	clearTranscript();
});

describe("keeping the working", () => {
	it("keeps the exchange without being asked to", () => {
		recordExchange({
			...CALL,
			usage: { inputTokens: 2000, outputTokens: 400 },
			object: { name: "Millford" },
		});

		const [kept] = transcript();
		expect(kept?.seq).toBe(1);
		// The prompt verbatim, newlines and all. Flowed into a paragraph it would be
		// unreadable, and unreadable is the same as not kept.
		expect(kept?.prompt).toBe(CALL.prompt);
		expect(kept?.system).toBe(CALL.system);
		expect(kept?.response).toContain("Millford");
		expect(kept?.cost).toBeCloseTo((2000 * 0.3 + 400 * 2.5) / 1e6, 9);
	});

	it("keeps a failed call, with the reason instead of an answer", () => {
		// The run somebody most wants to read back is the one that went wrong, so a
		// failure that left no trace would miss the entire point.
		recordExchange({ ...CALL, attempt: 2, error: new Error("This operation was aborted") });

		const [kept] = transcript();
		expect(kept?.error).toContain("aborted");
		expect(kept?.response).toBeUndefined();
		// And says which attempt it was, so three lines about one call read as retries
		// rather than as three separate towns having failed.
		expect(kept?.attempt).toBe(2);
	});

	it("keeps what the model actually said when the schema refused it", () => {
		// The most common failure in the pipeline, and on its own the least useful
		// sentence in it: "did not match schema" says a model said something wrong
		// without saying what. Whether it wrote prose instead of JSON, dropped a field,
		// or produced something good that the schema was too strict to admit is the
		// entire question, and only the raw text answers it.
		const refused = Object.assign(
			new Error("No object generated: response did not match schema."),
			{
				name: "AI_NoObjectGeneratedError",
				text: '{"nodes": [], "entry": "hello"}',
			},
		);
		recordExchange({ ...CALL, error: refused });

		const [kept] = transcript();
		expect(kept?.error).toContain("did not match schema");
		expect(kept?.error).toContain('"entry": "hello"');
	});

	it("drops the oldest rather than growing without end", () => {
		for (let i = 0; i < DEFAULT_TRANSCRIPT_LIMIT + 10; i++) {
			recordExchange({ ...CALL, prompt: `call ${i}` });
		}
		const kept = transcript();
		expect(kept).toHaveLength(DEFAULT_TRANSCRIPT_LIMIT);
		// The tail survives: the newest exchange is the one somebody is looking for.
		expect(kept.at(-1)?.prompt).toBe(`call ${DEFAULT_TRANSCRIPT_LIMIT + 9}`);
		expect(kept[0]?.prompt).toBe("call 10");
	});

	it("starts a fresh run at one, so two worlds do not read as one", () => {
		recordExchange({ ...CALL });
		clearTranscript();
		recordExchange({ ...CALL });
		expect(transcript()[0]?.seq).toBe(1);
	});

	it("holds more of a long world than of a short one", () => {
		// Eviction takes the head, so on a run with more calls than room the exchanges
		// lost are the shape, the lore and the regions — the three somebody reading a bad
		// world wants first. A `long` world with a flaky model is three attempts a call
		// over a hundred and twenty calls, which is why one number cannot serve both.
		sizeTranscript("tiny");
		const small = transcriptLimit();
		sizeTranscript("long");
		expect(transcriptLimit()).toBeGreaterThan(small);
	});

	it("evicts against the size in force, not the default", () => {
		sizeTranscript("tiny");
		const limit = transcriptLimit();
		for (let i = 0; i < limit + 5; i++) recordExchange({ ...CALL, prompt: `call ${i}` });
		expect(transcript()).toHaveLength(limit);
	});

	it("takes a transcript read back off disk, so a world can be read after the fact", () => {
		// The in-game view for a scenario this process did not write. Numbering continues
		// from what was seeded, so a live call afterwards does not collide with #1.
		seedTranscript([
			{
				seq: 1,
				kind: "lore",
				model: "google/gemini-2.5-flash",
				system: "You write worlds.",
				prompt: "A drowned archipelago.",
				millis: 900,
				cost: 0,
				attempt: 1,
			},
		]);
		recordExchange({ ...CALL });

		expect(transcript()).toHaveLength(2);
		expect(transcript()[1]?.seq).toBe(2);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ai/transcript.test.ts`

Expected: FAIL — `DEFAULT_TRANSCRIPT_LIMIT`, `sizeTranscript`, `transcriptLimit` and `seedTranscript` are not exported.

- [ ] **Step 3: Rewrite the gate out of `transcript.ts`**

In `src/ai/transcript.ts`:

Add the import at the top, after the existing ones:

```ts
import type { Duration } from "../core/world/brief.js";
```

Replace the paragraph in the module doc comment that begins "Off by default and deliberately so." with:

```
 * On always. It used to be a switch that defaulted to off, on the grounds that holding
 * every prompt of a long run is tens of megabytes of live strings — which is true, and is
 * why the buffer is bounded and sized to the world being written. What the switch actually
 * bought was a debug view nobody could find, on the one screen where somebody watching
 * four minutes of authoring go wrong most wants one.
```

Replace the `TRANSCRIPT_LIMIT` block and the `enabled` declaration:

```ts
/**
 * How many exchanges to keep, by how large a world is being written.
 *
 * One number cannot serve both ends. Eviction takes the *head*, so a run with more calls
 * than room loses the shape, the lore and the region passes — the first three somebody
 * reading a bad world asks about. A `long` world is around 120 calls, and a model that
 * needs its retries turns that into three exchanges each, which the old flat 400 could
 * not hold.
 */
export const TRANSCRIPT_LIMITS: Readonly<Record<Duration, number>> = {
	tiny: 200,
	short: 400,
	medium: 800,
	long: 1600,
};

/** What an unsized run holds: playing a world, or a caller that never said. */
export const DEFAULT_TRANSCRIPT_LIMIT = TRANSCRIPT_LIMITS.medium;

let limit: number = DEFAULT_TRANSCRIPT_LIMIT;
let nextSeq = 1;
const kept: Exchange[] = [];

/**
 * Set the buffer to the size of the world about to be written.
 *
 * Called once, before the first pass. `undefined` means the default — a caller with no
 * duration in hand is not a caller who wants the smallest buffer.
 */
export function sizeTranscript(duration: Duration | undefined): void {
	limit = duration ? TRANSCRIPT_LIMITS[duration] : DEFAULT_TRANSCRIPT_LIMIT;
	evict();
}

export function transcriptLimit(): number {
	return limit;
}
```

Delete `setDebugAi` and `debugAi` entirely, and delete the now-unused `setLogLevel` from the import on line 1, leaving:

```ts
import { logger } from "../utils/log.js";
```

In `recordExchange`, delete the `if (!enabled) return;` line and replace the tail of the function — the `kept.push`/splice block and the `logger.debug` block — with:

```ts
	kept.push(exchange);
	evict();

	/*
	 * No copy to the log.
	 *
	 * The whole exchange used to go to `logger.debug` as well, because the in-memory
	 * buffer died with the process and the file was the only thing that survived a run
	 * that ended badly. `working-file.ts` is that survivor now, and it holds the same
	 * text in a form something can read back — so writing it twice would only be a way
	 * for the two copies to disagree.
	 */
	announce();
}

/**
 * Trim to the limit in force, from the head.
 *
 * The head and not the tail: an exchange the buffer has dropped is one the reader can no
 * longer scroll back to, and the oldest is the one they are least likely to want.
 */
function evict(): void {
	if (kept.length > limit) kept.splice(0, kept.length - limit);
}

/**
 * Adopt a transcript read back off disk.
 *
 * For the in-game view of a world this process did not write: the exchanges are the ones
 * `working-file.ts` recorded during authoring. Numbering continues past what was seeded so
 * a live call afterwards cannot collide with a seeded `#1`.
 */
export function seedTranscript(exchanges: readonly Exchange[]): void {
	kept.push(...exchanges);
	evict();
	nextSeq = Math.max(nextSeq, ...kept.map((exchange) => exchange.seq + 1));
	announce();
}
```

Add a `logger` use so the import is not orphaned — in `clearTranscript` there is none, so instead keep `logger` only if something still uses it. Check with `npm run lint`; if `logger` is now unused, delete the import line entirely.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ai/transcript.test.ts`

Expected: PASS, 8 tests.

- [ ] **Step 5: See what the removal broke, and note it**

Run: `npm run typecheck`

Expected: FAIL, with errors naming every remaining caller of `setDebugAi`/`debugAi`: `src/main.tsx`, `src/ui/app.tsx`, `src/ui/panels/reader.tsx`, `src/ui/launcher/pick-launch.tsx`, `src/tools/author.ts`, and the three test files. Tasks 4–7 clear these. Do not fix them here — this task's deliverable is the module and its tests.

- [ ] **Step 6: Commit**

```bash
git add src/ai/transcript.ts src/ai/transcript.test.ts
git commit -m "Keep the working without being asked to, and size it to the world

The switch defaulted to off to avoid holding every prompt of a long run. That
cost is real and is what the bounded buffer is for; what the switch actually
bought was a debug view nobody could find, on the one screen where somebody
watching four minutes of authoring go wrong most wants one.

The limit is per duration now, because eviction takes the head: a long world
with a model that needs its retries is three exchanges a call over a hundred
and twenty calls, and the ones a flat 400 threw away were the shape, the lore
and the regions — the first three anybody asks about.

The log copy of each exchange goes too. working-file.ts survives the process
now, and two copies of the same text is only a way for them to disagree.

Typecheck is red until the callers of the removed switch are cleared.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The working file on disk

Both streams append to one `.jsonl` beside the artifact, so a run that ended badly leaves a record and a world can be read after the process that wrote it has gone. Written for every run including a discarded one — this is diagnostics, not content, and the log of a failed run is exactly the log worth keeping.

**Files:**
- Create: `src/ai/working-file.ts`
- Create: `src/ai/working-file.test.ts`

**Interfaces:**
- Consumes: `onLog`, `logRing`, `LogLine` from Task 1; `onTranscript`, `transcript`, `seedTranscript`, `Exchange` from Task 2.
- Produces: `workingPath(id: string): string`, `workingDir(): string`, `beginWorking(id: string): void`, `endWorking(): void`, `readWorking(id: string): WorkingRecord[] | undefined`, `loadWorkingInto(id: string): boolean`. Task 4 calls `beginWorking`/`endWorking`; Task 6 calls `loadWorkingInto`.

- [ ] **Step 1: Write the failing test**

Create `src/ai/working-file.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearLogRing, logger } from "../utils/log.js";
import { clearTranscript, recordExchange, transcript } from "./transcript.js";
import {
	beginWorking,
	endWorking,
	loadWorkingInto,
	readWorking,
	workingDir,
	workingPath,
} from "./working-file.js";

/**
 * The record that outlives the run.
 *
 * The in-memory buffers die with the process, which makes them useless for the question
 * somebody actually has — "the world I wrote last night came out wrong, why?" — and for
 * the in-game view of any world this process did not write. So both streams land in one
 * file beside the artifact, appended as they arrive rather than at the end, because a run
 * that ended badly is the run most worth reading.
 */

const CALL = {
	kind: "site" as const,
	model: "google/gemini-2.5-flash",
	system: "You name places.",
	prompt: "A village on a river.",
	millis: 812,
	attempt: 1,
};

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-working-"));
	process.env.AUTO_ADVENTURE_SCENARIOS = dir;
	clearTranscript();
	clearLogRing();
});

afterEach(() => {
	endWorking();
	delete process.env.AUTO_ADVENTURE_SCENARIOS;
	clearTranscript();
	clearLogRing();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the working file", () => {
	it("writes an exchange as it lands rather than at the end", () => {
		beginWorking("the-tide-glass");
		recordExchange({ ...CALL, object: { name: "Millford" } });

		// Read while the run is still notionally going: a run that dies mid-pass must
		// leave what it had, which is the whole reason this appends.
		const lines = fs.readFileSync(workingPath("the-tide-glass"), "utf8").trim().split("\n");
		const exchanges = lines.map((line) => JSON.parse(line)).filter((r) => r.kind === "exchange");
		expect(exchanges).toHaveLength(1);
		expect(exchanges[0].exchange.prompt).toBe(CALL.prompt);
	});

	it("writes the log beside it, in the same file", () => {
		beginWorking("the-tide-glass");
		logger.debug("dropping late spec for committed site 42");

		const records = readWorking("the-tide-glass") ?? [];
		expect(records.some((r) => r.kind === "log" && r.line.text.includes("site 42"))).toBe(true);
	});

	it("never writes the same entry twice, however often it is told", () => {
		beginWorking("the-tide-glass");
		recordExchange({ ...CALL });
		// A log line fires the same drain as an exchange does, so a sink that wrote the
		// whole buffer each time would duplicate every exchange before it.
		logger.info("wrote a thing");
		logger.info("wrote another");

		const records = readWorking("the-tide-glass") ?? [];
		expect(records.filter((r) => r.kind === "exchange")).toHaveLength(1);
	});

	it("starts a fresh file per run rather than appending to the last world's", () => {
		beginWorking("the-tide-glass");
		recordExchange({ ...CALL, prompt: "first run" });
		endWorking();

		clearTranscript();
		beginWorking("the-tide-glass");
		recordExchange({ ...CALL, prompt: "second run" });

		const records = readWorking("the-tide-glass") ?? [];
		const prompts = records
			.filter((r): r is Extract<typeof r, { kind: "exchange" }> => r.kind === "exchange")
			.map((r) => r.exchange.prompt);
		expect(prompts).toEqual(["second run"]);
	});

	it("stops writing once the run is over", () => {
		beginWorking("the-tide-glass");
		endWorking();
		recordExchange({ ...CALL });

		expect(readWorking("the-tide-glass")?.filter((r) => r.kind === "exchange")).toHaveLength(0);
	});

	it("reads a run back into the transcript, for a world this process did not write", () => {
		beginWorking("the-tide-glass");
		recordExchange({ ...CALL, object: { name: "Millford" } });
		endWorking();
		clearTranscript();

		expect(loadWorkingInto("the-tide-glass")).toBe(true);
		expect(transcript()).toHaveLength(1);
		expect(transcript()[0]?.prompt).toBe(CALL.prompt);
	});

	it("says so rather than throwing when a world has no working file", () => {
		expect(loadWorkingInto("never-written")).toBe(false);
		expect(readWorking("never-written")).toBeUndefined();
	});

	it("keeps out of the way of the scenarios themselves", () => {
		beginWorking("the-tide-glass");
		recordExchange({ ...CALL });

		// `listScenarios` reads root-level *.json only, so the working file has to be
		// neither at the root nor named .json — or a diagnostic would show up on the
		// launcher's shelf as a world to play.
		expect(workingDir()).not.toBe(dir);
		expect(fs.readdirSync(dir).filter((e) => e.endsWith(".json"))).toHaveLength(0);
	});

	it("survives a file it cannot write without taking the run down with it", () => {
		// A generation run must not die because a diagnostic could not be appended.
		beginWorking("the-tide-glass");
		fs.rmSync(workingDir(), { recursive: true, force: true });
		fs.writeFileSync(workingDir(), "not a directory");

		expect(() => recordExchange({ ...CALL })).not.toThrow();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ai/working-file.test.ts`

Expected: FAIL — cannot resolve `./working-file.js`.

- [ ] **Step 3: Write the sink**

Create `src/ai/working-file.ts`:

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scenarioRoot } from "../paths.js";
import { type LogLine, logRing, onLog } from "../utils/log.js";
import { type Exchange, onTranscript, seedTranscript, transcript } from "./transcript.js";

/**
 * The record of a run, on disk, outliving the process that made it.
 *
 * Both in-memory buffers die when the program does, which makes them no use for the
 * question somebody actually has — "the world I wrote last night came out wrong, why?" —
 * and no use for the in-game view of any world this process did not write itself. So both
 * streams land in one file beside the artifact.
 *
 * Appended as entries arrive rather than written at the end, because a run that died
 * mid-pass is the run most worth reading, and it is exactly the run that never reaches an
 * end. Written for *every* run, including one whose artifact is thrown away: this is
 * diagnostics rather than content, and the log of a failed attempt is the log worth having.
 *
 * Kept in a subdirectory and not named `.json`, because `listScenarios` reads root-level
 * `*.json` and a diagnostic must never appear on the launcher's shelf as a world to play.
 *
 * The dependency runs one way. This module reads `transcript.ts` and `log.ts`; neither
 * knows it exists. A sink they had to be told about would be a third thing to keep in step.
 */

export type WorkingRecord =
	| { readonly kind: "exchange"; readonly exchange: Exchange }
	| { readonly kind: "log"; readonly line: LogLine };

/** Where the working files live. Hidden, so it reads as bookkeeping rather than content. */
export function workingDir(): string {
	return join(scenarioRoot(), ".working");
}

export function workingPath(id: string): string {
	return join(workingDir(), `${id}.jsonl`);
}

/**
 * What has already been written, so a drain appends only the tail.
 *
 * Both streams announce into the same drain, so an exchange landing and a log line landing
 * each ask for everything new. Counting what went out is what keeps that from writing the
 * whole buffer again on every line.
 */
interface Sink {
	readonly path: string;
	exchanges: number;
	log: number;
	readonly off: readonly (() => void)[];
	/** Set once a write has failed, so a broken file costs one attempt and not a run. */
	broken: boolean;
}

let sink: Sink | undefined;
let draining = false;

/**
 * Open the record for a run, replacing whatever the last one left.
 *
 * Truncated rather than appended to: two runs of the same world in one file would read as
 * one run that asked everything twice.
 */
export function beginWorking(id: string): void {
	endWorking();
	const path = workingPath(id);
	try {
		mkdirSync(workingDir(), { recursive: true });
		writeFileSync(path, "");
	} catch {
		// No file, no record, and no complaint: a diagnostic that cannot be written must
		// not stop a world being written. Reported through the log, which has its own sink.
		return;
	}
	sink = { path, exchanges: 0, log: 0, off: [onTranscript(drain), onLog(drain)], broken: false };
	drain();
}

/** Close the record. Safe to call when none is open, which is what makes it usable in a finally. */
export function endWorking(): void {
	if (!sink) return;
	for (const off of sink.off) off();
	sink = undefined;
}

/**
 * Append everything that has landed since the last drain.
 *
 * Re-entrancy is the hazard: `onLog` fires from inside `emit`, so a failure reported
 * through the logger from in here would call this again from inside itself. The flag makes
 * that a no-op, and a sink that has failed once stops trying.
 */
function drain(): void {
	if (!sink || sink.broken || draining) return;
	draining = true;
	try {
		const exchanges = transcript();
		const log = logRing();
		const lines: string[] = [];
		for (let i = sink.exchanges; i < exchanges.length; i++) {
			lines.push(JSON.stringify({ kind: "exchange", exchange: exchanges[i] }));
		}
		for (let i = sink.log; i < log.length; i++) {
			lines.push(JSON.stringify({ kind: "log", line: log[i] }));
		}
		if (lines.length > 0) appendFileSync(sink.path, `${lines.join("\n")}\n`);
		sink.exchanges = exchanges.length;
		sink.log = log.length;
	} catch {
		// Marked rather than retried. A file that cannot be appended to now will not
		// start working later in the same run, and a diagnostic must never be the reason
		// four minutes of authoring is lost.
		sink.broken = true;
	} finally {
		draining = false;
	}
}

/**
 * Every record of a run, or nothing where there is no file.
 *
 * A malformed line is skipped rather than fatal: the file is appended to live and a run
 * killed mid-write can leave a partial last line, which is not a reason to refuse the
 * hundred good ones above it.
 */
export function readWorking(id: string): WorkingRecord[] | undefined {
	const path = workingPath(id);
	if (!existsSync(path)) return undefined;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const records: WorkingRecord[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			records.push(JSON.parse(line) as WorkingRecord);
		} catch {
			continue;
		}
	}
	return records;
}

/**
 * Put a world's recorded exchanges into the live transcript.
 *
 * What makes the in-game working page useful for a scenario somebody else generated, or
 * one generated last week. Returns whether there was anything to read, so a caller can
 * tell "no record" from "an empty record".
 *
 * Only the exchanges. The log lines are in the file for whoever reads it, but seeding them
 * into this session's ring would mix last week's authoring with this session's play in one
 * list with no way to tell which was which.
 */
export function loadWorkingInto(id: string): boolean {
	const records = readWorking(id);
	if (!records) return false;
	const exchanges = records
		.filter((record): record is Extract<WorkingRecord, { kind: "exchange" }> => record.kind === "exchange")
		.map((record) => record.exchange);
	if (exchanges.length === 0) return false;
	seedTranscript(exchanges);
	return true;
}

/** Delete a run's record. For tests, and for a world being deleted. */
export function deleteWorking(id: string): void {
	rmSync(workingPath(id), { force: true });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ai/working-file.test.ts`

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ai/working-file.ts src/ai/working-file.test.ts
git commit -m "Keep a run's working beside the world it wrote

Both in-memory buffers die with the process, which makes them no use for the
question somebody actually has — last night's world came out wrong, why — and
none for the in-game view of a world this process did not write. So both
streams land in one jsonl beside the artifact, appended as entries arrive
because a run that died mid-pass is the one worth reading and the one that
never reaches an end.

Written for every run including a discarded one: this is diagnostics, not
content, and a failed attempt's log is the log worth having. Kept in a hidden
subdirectory under a name that is not .json, so listScenarios cannot mistake a
diagnostic for a world to play.

Two hazards handled rather than hoped about: both streams announce into one
drain, so writes are counted to keep a log line from re-writing every exchange
before it; and onLog fires from inside emit, so a failure reported through the
logger from inside the drain would re-enter it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Take the toggle off the generate page and open the record for the run

**Files:**
- Modify: `src/scenario/scenario.ts:106-113`
- Modify: `src/ui/launcher/generate-config.tsx`
- Modify: `src/ui/launcher/pick-launch.tsx`
- Modify: `src/ui/launcher/launcher.test.tsx:561`
- Test: `src/ui/launcher/launcher.test.tsx`

**Interfaces:**
- Consumes: `sizeTranscript` (Task 2), `beginWorking`, `endWorking` (Task 3).
- Produces: `GenerateRequest` without `debug`. `GenerateProgress` keeps its `debug` prop until Task 5 removes it — this task passes nothing new to it.

- [ ] **Step 1: Write the failing test**

In `src/ui/launcher/launcher.test.tsx`, find the assertion around line 561 containing `debug: true`. It asserts the request the config page emits. Change that expectation so it no longer contains a `debug` field, and add a test that the row is gone. Add to the config-page describe block:

```ts
	it("no longer asks whether to keep the working, because it always is", () => {
		// The row it replaces defaulted to off, which made the prompt-by-prompt view a
		// thing you had to know to ask for on the screen you asked for a world.
		const { lastFrame, unmount } = renderInk(
			<GenerateConfig
				columns={80}
				rows={24}
				depth="truecolor"
				tilePacks={[]}
				contentPacks={[]}
				onBegin={() => undefined}
				onBack={() => undefined}
			/>,
		);
		expect(lastFrame()).not.toContain("Keep the working");
		unmount();
	});
```

Match the surrounding file's existing render helper and import style rather than the sketch above if they differ — read the file's other `GenerateConfig` tests first and follow them.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/launcher/launcher.test.tsx`

Expected: FAIL — the frame still contains "Keep the working", and the request still carries `debug: true`.

- [ ] **Step 3: Remove the field, the state and the row**

In `src/scenario/scenario.ts`, delete the whole `debug` member of `GenerateRequest` including its doc comment (lines 106-113), leaving `liveInGame` as the last member.

In `src/ui/launcher/generate-config.tsx`:
- Delete `const [debug, setDebug] = useState(false);` (line 145).
- Delete the entire `{ id: "debug", … }` entry from `items` (lines 244-251).
- Delete the `case "debug":` arm from `cycle` (lines 287-289).
- Delete `...(debug ? { debug: true } : {}),` from the `onBegin` call (line 330).

In `src/ui/launcher/pick-launch.tsx`:
- Change the import on line 3 to `import { clearTranscript, sizeTranscript } from "../../ai/transcript.js";` and add `import { beginWorking, endWorking } from "../../ai/working-file.js";`.
- Replace the `if (request.debug) { … }` block (lines 142-148) with:

```ts
	// Before the first call, or the first pass is the one exchange nobody can read.
	// Cleared as well as sized: the launcher may have been round this loop already, and a
	// transcript that opens on the previous world's prompts is worse than none.
	clearTranscript();
	sizeTranscript(request.brief.duration);
```

- After `const id = ...` is available. It is not — the id is chosen inside `generateScenario`. So instead, open the record where the id first exists. In `generateAndLaunch`, the id is not known until `generateScenario` returns; the record has to be open *before* the calls. Resolve this by having `generateScenario` open it: see the next bullet, and leave `pick-launch.tsx` closing it.
- Wrap the `generateScenario` call so the record is always closed:

```ts
	try {
		outcome = await generateScenario(request, { … });
	} finally {
		endWorking();
	}
```

  Keep the existing `{ signal, onProgress }` argument exactly as it is; only the `try`/`finally` is new. `outcome` is already declared with `let` above, so change `outcome = await generateScenario(...)` to sit inside the `try`.

In `src/scenario/generate.ts`, open the record as soon as the id is chosen. After the `logger.info(\`generating scenario …\`)` line (line 135), add:

```ts
	// Opened here rather than by the caller, because here is where the id first exists and
	// the record is named after it. Closed by the caller, which is the only thing that knows
	// when the run — including a polish pass — is actually over.
	beginWorking(id);
```

and add the import: `import { beginWorking } from "../ai/working-file.js";`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui/launcher src/scenario/generate.test.ts && npm run typecheck`

Expected: tests PASS. Typecheck still reports the Task 2 removals in `main.tsx`, `app.tsx`, `reader.tsx`, `tools/author.ts` and two test files — those are Tasks 5–7.

- [ ] **Step 5: Commit**

```bash
git add src/scenario/scenario.ts src/scenario/generate.ts src/ui/launcher/generate-config.tsx src/ui/launcher/pick-launch.tsx src/ui/launcher/launcher.test.tsx
git commit -m "Stop asking whether to keep the working, and start keeping it

The row defaulted to off, which put the prompt-by-prompt view behind a
question asked on the same screen as the one that costs four minutes — so the
run that most wanted it was reliably the run that did not have it.

The record opens where the id first exists, in generateScenario, since it is
named after the id; and closes in the caller, which is the only thing that
knows when the run is over, polish pass included. The transcript is sized to
the duration at the same moment.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `D` always works, and `L` shows the log

**Files:**
- Modify: `src/ui/panels/transcript-view.tsx`
- Modify: `src/ui/launcher/generate-progress.tsx`
- Test: `src/ui/launcher/generate-progress.test.tsx`

**Interfaces:**
- Consumes: `logRing`, `LogLine`, `onLog` (Task 1).
- Produces: `TranscriptViewProps` without `recording` and with `readonly log?: readonly LogLine[]`. `GenerateProgressProps` without `debug`.

- [ ] **Step 1: Write the failing test**

In `src/ui/launcher/generate-progress.test.tsx`, in the "reading the working" describe block: delete the `setDebugAi(false)` and `setDebugAi(true)` lines, change every `mount({ debug: true })` to `mount({})`, and change the `debug: true` inside the props object near line 285 to nothing. Then add:

```ts
	it("offers the working whether or not anybody asked for it", () => {
		const m = mount({});
		expect(m.screen()).toContain("D for the working");
		m.ink.unmount();
	});

	it("shows the log beside the exchanges, on a key of its own", () => {
		// The other half of the answer to "why did this world come out like that". The
		// exchanges say what was asked; the log says what the pipeline did with the answer
		// — dropped a late spec, escalated to a dearer model, replayed a remembered reply.
		logger.debug("dropping late spec for committed site 42");
		recordExchange({
			kind: "site",
			model: "google/gemini-2.5-flash",
			system: "You name places.",
			prompt: "A village on a river.",
			millis: 812,
			attempt: 1,
			object: { name: "Millford" },
		});

		const m = mount({});
		m.press("d");
		expect(m.screen()).toContain("L log");
		m.press("l");
		expect(m.screen()).toContain("committed site 42");
		m.ink.unmount();
	});
```

Import `logger` and `clearLogRing` from `../../utils/log.js` at the top of the test file, and call `clearLogRing()` in the same hook that calls `clearTranscript()`. Use the file's existing `mount`/`press` helpers — read them first and match their signatures exactly; the sketch above assumes `m.press(key)` and `m.screen()`, which is what the existing tests around line 255 use.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/launcher/generate-progress.test.tsx`

Expected: FAIL — "L log" is not in the frame, and the footer says "ESC to stop" without the working.

- [ ] **Step 3: Add the log pane and drop the gate**

In `src/ui/panels/transcript-view.tsx`:

Replace the `recording` prop with the log, in `TranscriptViewProps`:

```ts
	/** Running totals, shown above the list. Absent where the caller shows its own. */
	readonly totals?: TelemetrySnapshot;
	/**
	 * The debug log, when the caller wants it under the exchange.
	 *
	 * The other half of the answer to "why did this world come out like that": the
	 * exchanges say what was asked and what came back, and this says what the pipeline then
	 * did with it — dropped a late spec, escalated to a dearer model, replayed a remembered
	 * reply. Absent means the caller is not showing it, which is the ordinary case.
	 */
	readonly log?: readonly LogLine[];
```

Add the import: `import type { LogLine } from "../../utils/log.js";`

Change the destructure from `recording` to `log`, and replace the empty-list branch:

```ts
	if (exchanges.length === 0) {
		return (
			<>
				<Rule width={width} label="the working" />
				<Text color="gray" wrap="truncate">
					Nothing has been asked of a model yet.
				</Text>
			</>
		);
	}
```

Then, where the detail lines are rendered, give the log the bottom of the pane when it is present. Replace the `listRows`/`detailRows` computation and the final `shown.map(...)` block:

```ts
	// Two rules and the summary line come off the top; the rest is split. The log, when it
	// is up, takes a third of what is left of the detail — enough to read the last few
	// lines, which is what a reader wants beside an exchange rather than the whole file.
	const listRows = Math.max(2, Math.floor((rows - 3) * LIST_SHARE));
	const logRows = log && log.length > 0 ? Math.max(2, Math.floor((rows - 3 - listRows) / 3)) : 0;
	const detailRows = Math.max(2, rows - 3 - listRows - logRows - (logRows > 0 ? 1 : 0));
```

and after the existing `shown.map(...)`:

```ts
			{logRows > 0 ? (
				<>
					<Rule width={width} label="log" />
					{(log ?? []).slice(-logRows).map((line, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: log lines are positional
						<Text
							key={index}
							wrap="truncate"
							color={line.level === "error" || line.level === "warn" ? "yellow" : undefined}
							dimColor={line.level === "debug"}
						>
							{clampLine(`${stamp(line.at)} ${line.text}`, width)}
						</Text>
					))}
				</>
			) : null}
```

Add at the bottom of the file:

```ts
/** `hh:mm:ss`, so two lines can be told apart by when rather than only by what. */
function stamp(at: number): string {
	return new Date(at).toISOString().slice(11, 19);
}
```

In `src/ui/launcher/generate-progress.tsx`:
- Add the import `import { type LogLine, logRing, onLog } from "../../utils/log.js";`
- Delete the `debug?: boolean` prop and its doc comment (lines 90-96), and `debug = false,` from the destructure.
- Add `const [showLog, setShowLog] = useState(false);` beside the other transcript state.
- In the `useEffect` that subscribes, add `const offLog = onLog(redraw);` and return it alongside the others.
- Add `const log: readonly LogLine[] = showing && showLog ? logRing() : [];` beside the `exchanges` line.
- In the `showing` branch of `useInput`, add before the `space`/`return` case:

```ts
				if (letter === "l") {
					setShowLog((up) => !up);
					setOffset(0);
					return;
				}
```

- Change `if (debug && letter === "d")` to `if (letter === "d")`.
- Pass the log to the view and drop `recording`:

```tsx
						<TranscriptView
							exchanges={exchanges}
							cursor={cursor}
							offset={offset}
							part={part}
							width={columns - CHROME}
							rows={Math.max(6, rows - FRAME_CHROME - PAGE_CHROME)}
							totals={spend}
							{...(log.length > 0 ? { log } : {})}
						/>
```

- Change the transcript screen's footer to advertise the key:

```tsx
					<Text dimColor wrap="truncate">
						↑↓ exchange · ←→ question/answer · L log · SPACE down · B up · D or ESC back
					</Text>
```

- In the running footer, replace the `debug ? … : "ESC to stop"` ternary with `"ESC to stop · D for the working"`.
- In the `Review` component, delete the `debug` prop from its signature and its call site, and change the key line to always offer `D`:

```tsx
				<Text color="cyan" wrap="truncate">
					{[
						canPolish ? "P to have it read back and the faults written out" : "",
						"D to read the working",
						"any other key to play it",
					]
						.filter(Boolean)
						.join(" · ")}
				</Text>
```

- Delete `debug={debugAi()}` from `pick-launch.tsx`'s `view()` and the now-unused `debugAi` import there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui/launcher && npm run typecheck`

Expected: launcher tests PASS. Typecheck still reports `main.tsx`, `app.tsx`, `reader.tsx`, `tools/author.ts`, `app.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/ui/panels/transcript-view.tsx src/ui/launcher/generate-progress.tsx src/ui/launcher/pick-launch.tsx src/ui/launcher/generate-progress.test.tsx
git commit -m "Always offer the working, and put the log under it

D is on the footer of every run now rather than only the ones that thought to
ask. L brings up the log beside the exchange, which is the other half of the
answer to why a world came out as it did: the exchanges say what was asked and
what came back, the log says what the pipeline then did with it.

A third of the detail pane, and the tail of it — what a reader wants next to an
exchange is the last few lines, not the whole file.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The in-game working tab, always there and useful for any world

**Files:**
- Modify: `src/ui/hud-state.ts:44-48`
- Modify: `src/ui/app.tsx:94`
- Modify: `src/ui/panels/reader.tsx:164-185`
- Modify: `src/main.tsx:136-142`
- Test: `src/ui/app.test.tsx:743-780`

**Interfaces:**
- Consumes: `loadWorkingInto` (Task 3), `logRing` (Task 1).
- Produces: `panelTabs(): readonly PanelTab[]` — no parameter.

- [ ] **Step 1: Write the failing test**

In `src/ui/app.test.tsx`, in the "the working page" describe block: delete the `setDebugAi(false)` and `setDebugAi(true)` lines and the `debugAi` import. Change the existing "shows what was asked and what came back, once they are" test to drop its `setDebugAi(true)`. Add:

```ts
	it("is on the strip for every world, not only one that was just written", () => {
		// The tab used to appear only when this process had done the writing, which made it
		// missing for exactly the case somebody wants it: a world generated last week that
		// is behaving oddly now.
		const { lastFrame, unmount } = renderInk(<App initialTab="debug" />, {
			…the same options the neighbouring test uses…
		});
		expect(lastFrame()).toContain("the working");
		unmount();
	});
```

Read the neighbouring test at line 775 first and copy its render options exactly.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/app.test.tsx`

Expected: FAIL — `setDebugAi` no longer exists, so the file does not compile; and once the imports are fixed, the tab is absent because `panelTabs(false)` omits it.

- [ ] **Step 3: Make the tab unconditional**

In `src/ui/hud-state.ts`, replace `panelTabs` and its comment:

```ts
/**
 * The tabs on offer.
 *
 * `debug` used to come and go with whether the recording was on, so that a page most
 * players have no use for was not one everybody had to step past. It is always here now
 * for the same reason the recording is always on: a world is read back from the file its
 * authoring wrote, so the page has something in it for any scenario, not only one this
 * process happened to write.
 *
 * Still a function rather than a constant, because the reducer has to agree with the
 * strip: stepping is modular arithmetic over this list, so a screen drawing four tabs
 * while the reducer cycled five would leave one that could be reached and not seen.
 */
export function panelTabs(): readonly PanelTab[] {
	return [...PANEL_TABS, "debug"];
}
```

In `src/ui/app.tsx`: change line 94 to `const tabs = panelTabs();`, and remove `debugAi` from the `../ai/transcript.js` import, keeping `transcript`.

In `src/ui/panels/reader.tsx`:
- Change the import on line 3 to `import { transcript } from "../../ai/transcript.js";` and add `import { logRing } from "../../utils/log.js";`
- In `WorkingReader`, replace the `recording={debugAi()}` prop with the log, and update the doc comment's third paragraph:

```tsx
function WorkingReader({
	hud,
	width,
	rows,
}: {
	readonly hud: HudState;
	readonly width: number;
	readonly rows: number;
}) {
	const exchanges = transcript();
	const log = logRing();
	return (
		<TranscriptView
			exchanges={exchanges}
			cursor={hud.cursor}
			offset={hud.detail * DETAIL_PAGE}
			part="both"
			width={width}
			rows={rows}
			totals={telemetrySnapshot()}
			{...(log.length > 0 ? { log } : {})}
		/>
	);
}
```

  and in its doc comment replace "Only on the strip when the recording is on, so this is never a tab most people have to step past." with "On the strip for every world. A scenario carries its own authoring record beside it, so this page has something in it even for a world written last week by somebody else."

In `src/main.tsx`:
- Delete the `import { setDebugAi } from "./ai/transcript.js";` line and add `import { loadWorkingInto } from "./ai/working-file.js";`
- Replace the `DEBUG_AI` comment block and `if (CONFIG.debugAi) setDebugAi(true);` (lines 137-142) with nothing, and after `if (!choice) return;` add:

```ts
	// A scenario carries the record of its own authoring beside it, so the working page has
	// the prompts that produced this world even though this process did not write it. Silent
	// when there is none: a hand-authored scenario never had a model near it, and a world
	// written before this existed simply has nothing to read.
	if (choice.scenario) loadWorkingInto(choice.scenario.id);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui && npm run typecheck`

Expected: PASS. Typecheck now reports only `src/tools/author.ts` and `src/config.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/ui/hud-state.ts src/ui/app.tsx src/ui/panels/reader.tsx src/main.tsx src/ui/app.test.tsx
git commit -m "Put the working on the strip for every world

The tab appeared only when this process had done the writing, which made it
missing for exactly the case it is wanted in: a world generated last week that
is behaving oddly now. A scenario carries its authoring record beside it, so
the page is read from the file and has something in it for any world.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Remove `DEBUG_AI` and the `--debug` flag, then verify the whole repo

The last two callers, and the sweep that proves nothing was left half-removed.

**Files:**
- Modify: `src/config.ts:94`
- Modify: `src/tools/author.ts:17,106-110`
- Modify: `README.md`, `docs/scenarios.md` — wherever `DEBUG_AI` or "keep the working" is documented.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Find every remaining mention**

Run:

```bash
TOKENSAVE_DISABLE_GREP_HOOK=1 grep -rn "DEBUG_AI\|debugAi\|setDebugAi\|Keep the working\|keep the working\|TRANSCRIPT_LIMIT" src README.md docs .claude 2>/dev/null
```

Expected: matches in `src/config.ts`, `src/tools/author.ts`, and any docs. Every one is removed or reworded in this task. `TRANSCRIPT_LIMIT` should have no matches — if it does, Task 2 left a caller behind.

- [ ] **Step 2: Remove them**

In `src/config.ts`, delete the `debugAi: envFlag("DEBUG_AI"),` line and the `debugAi` member of the config interface, plus any doc comment naming `DEBUG_AI`.

In `src/tools/author.ts`, delete the `setDebugAi` import (line 17) and replace the comment block and `if (args.has("debug")) setDebugAi(true);` (lines 106-110) with nothing. If the tool's usage/help text lists `--debug`, remove that line too.

In the docs, replace any instruction to set `DEBUG_AI=1` or turn on "keep the working" with a sentence saying the working is always kept and reachable with `D` while a world is written and from the game's own menu afterwards. Read the surrounding prose and match its voice.

- [ ] **Step 3: Verify the whole repo**

Run: `npm run check`

Expected: typecheck clean, Biome clean, all tests PASS. If Biome reports an unused import — most likely `logger` in `transcript.ts` or `clampLine` in `transcript-view.tsx` — remove it.

- [ ] **Step 4: Verify by hand, in the real program**

Run: `npm run author -- --id smoke-working --duration tiny`

This needs `AI_GATEWAY_API_KEY`. If there is no key, skip to Step 5 and say so in the commit body rather than claiming a check that did not happen.

Expected: the run completes and `.scenarios/.working/smoke-working.jsonl` exists, containing both `"kind":"exchange"` and `"kind":"log"` lines. Confirm with:

```bash
TOKENSAVE_DISABLE_GREP_HOOK=1 grep -c '"kind":"exchange"' .scenarios/.working/smoke-working.jsonl
TOKENSAVE_DISABLE_GREP_HOOK=1 grep -c '"kind":"log"' .scenarios/.working/smoke-working.jsonl
```

Both should be non-zero. Then confirm the diagnostic stayed off the shelf:

```bash
ls .scenarios/*.json | TOKENSAVE_DISABLE_GREP_HOOK=1 grep -c working
```

Expected: `0`. Then delete the smoke artifacts: `rm -f .scenarios/smoke-working.json .scenarios/.working/smoke-working.jsonl`

- [ ] **Step 5: Add the working directory to `.gitignore`**

Check whether `.scenarios/` is committed (it is — four artifacts live there). So the working files must be ignored explicitly. Add to `.gitignore`:

```
# Diagnostics from a generation run, not content. See src/ai/working-file.ts.
.scenarios/.working/
```

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/tools/author.ts .gitignore README.md docs
git commit -m "Take out the last of the debug switch

DEBUG_AI and the author tool's --debug flag both did what is now the default,
and a variable that turns on something already on is a variable that misleads
whoever finds it. The working directory is ignored: it is diagnostics from a
run, and .scenarios itself is committed content.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Every item in Part A's Design section maps to a task: ungate → Task 2 (module) and Tasks 4–7 (callers); the split log sinks with `LOG_RING_LIMIT = 2000` → Task 1; duration-scaled `TRANSCRIPT_LIMITS` at 200/400/800/1600 → Task 2; the `.jsonl` with a `kind` discriminator in `.scenarios/.working/`, written for every run and invisible to `listScenarios` → Task 3; seeding the in-game view from the file → Tasks 3 and 6; `D` always working and `L` toggling the log → Task 5; the always-present in-game tab → Task 6. The spec's five testing bullets are covered by Task 1 Step 1 (ring vs file), Task 2 Step 1 (recording with no setup, sizing), Task 3 Step 1 (round-trip, and `listScenarios` ignoring the directory).

**Type consistency.** `LogLine`, `logRing`, `onLog`, `LOG_RING_LIMIT` are defined in Task 1 and used under those exact names in Tasks 3, 5 and 6. `seedTranscript`, `sizeTranscript`, `transcriptLimit`, `DEFAULT_TRANSCRIPT_LIMIT` are defined in Task 2 and used under those names in Tasks 3 and 4. `WorkingRecord`, `beginWorking`, `endWorking`, `readWorking`, `loadWorkingInto`, `workingDir`, `workingPath` are defined in Task 3 and used in Tasks 4 and 6. `panelTabs` drops its parameter in Task 6, which is also where both its callers are fixed.

**Two known rough edges, deliberately left to the implementer** because they need the file in front of you rather than a guess from here:

1. Task 4's ordering. The record has to be open before the first model call, and the id is not chosen until inside `generateScenario` — so `beginWorking` goes there and `endWorking` in `pick-launch.tsx`'s `finally`. That split is asymmetric and worth a comment at both ends, which the task says to write.
2. The test-helper signatures in Tasks 4, 5 and 6 are sketched from the existing tests' shape. Read the real `mount`/`press`/`renderInk` helpers in each file first and match them; a sketch that does not compile is faster to fix than to guess at from here.
