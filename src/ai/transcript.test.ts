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
 * cost it was protecting against — holding every prompt of a run — is bounded by the limit
 * below and paid only while a world is being written.
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
		// over a hundred and twenty calls, which is why one number cannot serve both ends.
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

	it("trims immediately when the size is lowered under a full buffer", () => {
		// Sizing happens before the first call in the ordinary run, but nothing about the
		// buffer should depend on that: a limit that only took effect on the next
		// `recordExchange` would leave a buffer over its own stated size.
		sizeTranscript("long");
		for (let i = 0; i < 250; i++) recordExchange({ ...CALL });
		sizeTranscript("tiny");
		expect(transcript()).toHaveLength(transcriptLimit());
	});

	it("takes a transcript read back off disk, so a world can be read after the fact", () => {
		// The in-game view for a scenario this process did not write. Numbering continues
		// past what was seeded, so a live call afterwards does not collide with a seeded #1.
		seedTranscript([
			{
				seq: 1,
				kind: "bible",
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
