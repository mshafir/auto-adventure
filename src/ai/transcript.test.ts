import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearTranscript,
	debugAi,
	recordExchange,
	setDebugAi,
	TRANSCRIPT_LIMIT,
	transcript,
} from "./transcript.js";

/**
 * Keeping the working, and — mostly — not keeping it.
 *
 * The off case carries the weight. A debug switch whose cost is paid whether or not
 * anybody turned it on is a debug switch that gets removed again six months later,
 * because holding every prompt of every run is tens of megabytes of live strings for a
 * feature nobody asked for.
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
	setDebugAi(false);
	clearTranscript();
});

afterEach(() => {
	setDebugAi(false);
	clearTranscript();
});

describe("keeping the working", () => {
	it("keeps nothing at all until somebody asks", () => {
		recordExchange({ ...CALL, object: { name: "Millford" } });
		expect(transcript()).toHaveLength(0);
		expect(debugAi()).toBe(false);
	});

	it("keeps the whole exchange once it is on", () => {
		setDebugAi(true);
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
		setDebugAi(true);
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
		setDebugAi(true);
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
		setDebugAi(true);
		for (let i = 0; i < TRANSCRIPT_LIMIT + 10; i++) {
			recordExchange({ ...CALL, prompt: `call ${i}` });
		}
		const kept = transcript();
		expect(kept).toHaveLength(TRANSCRIPT_LIMIT);
		// The tail survives: the newest exchange is the one somebody is looking for.
		expect(kept.at(-1)?.prompt).toBe(`call ${TRANSCRIPT_LIMIT + 9}`);
		expect(kept[0]?.prompt).toBe("call 10");
	});

	it("starts a fresh run at one, so two worlds do not read as one", () => {
		setDebugAi(true);
		recordExchange({ ...CALL });
		clearTranscript();
		recordExchange({ ...CALL });
		expect(transcript()[0]?.seq).toBe(1);
	});
});
