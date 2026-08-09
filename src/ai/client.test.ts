import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * What happens when a model does not answer in the shape it was asked for.
 *
 * This used to be treated as permanent — "a schema mismatch will repeat, so retrying
 * only burns tokens to be told the same thing" — and a measured run falsified it
 * outright: `openai/gpt-5-mini` answered the dialogue schema 8 times out of 26 on the
 * same shape of prompt. Not a model that cannot do it. A model that does it two times
 * in three, whose other 18 conversations were thrown away on the first roll.
 *
 * The SDK is mocked because the property under test is the retry policy, and a test
 * that needed a key would be a test nobody runs.
 */

const generateObject = vi.fn();
const streamObject = vi.fn();

vi.mock("ai", () => ({
	generateObject: (...args: unknown[]) => generateObject(...args),
	streamObject: (...args: unknown[]) => streamObject(...args),
	NoObjectGeneratedError: { isInstance: () => true },
}));

const { structured } = await import("./client.js");
const { resetTelemetry, telemetrySnapshot } = await import("./telemetry.js");

const schema = z.object({ name: z.string() });

function request(extra: Record<string, unknown> = {}) {
	return {
		kind: "dialogue" as const,
		model: "provider/cheap",
		schema,
		system: "s",
		prompt: "p",
		// The backoff is real time, and three attempts of it would make this suite slow
		// for no property gained.
		retries: 2,
		...extra,
	};
}

/** The failure the whole policy is about. */
function mismatch() {
	return Object.assign(new Error("No object generated: response did not match schema."), {
		name: "AI_NoObjectGeneratedError",
	});
}

beforeEach(() => {
	process.env.AI_GATEWAY_API_KEY = "test-key";
	generateObject.mockReset();
	streamObject.mockReset();
	resetTelemetry();
});

afterEach(() => {
	delete process.env.AI_GATEWAY_API_KEY;
	resetTelemetry();
});

describe("a model that answers in the wrong shape", () => {
	it("is asked again rather than given up on", async () => {
		generateObject
			.mockRejectedValueOnce(mismatch())
			.mockResolvedValueOnce({ object: { name: "Millford" }, usage: {} });

		expect(await structured(request())).toEqual({ name: "Millford" });
		expect(generateObject).toHaveBeenCalledTimes(2);
	});

	it("gives up once the attempts are spent, without throwing", async () => {
		// The contract everything above this file depends on: a model call never throws
		// into gameplay, and every caller has a deterministic fallback ready.
		generateObject.mockRejectedValue(mismatch());
		expect(await structured(request())).toBeUndefined();
		expect(generateObject).toHaveBeenCalledTimes(3);
		expect(telemetrySnapshot().failures).toBe(1);
	});

	it("stops immediately when the caller has given up", async () => {
		// A player who pressed ESC is not a timeout worth another attempt.
		const stop = new AbortController();
		stop.abort();
		generateObject.mockRejectedValue(mismatch());
		expect(await structured(request({ signal: stop.signal }))).toBeUndefined();
		expect(generateObject).toHaveBeenCalledTimes(1);
	});
});

describe("escalating to a dearer model", () => {
	const models = () =>
		generateObject.mock.calls.map((call) => (call[0] as { model: string }).model);

	it("spends only the last attempt on it", async () => {
		generateObject.mockRejectedValue(mismatch());
		await structured(request({ escalateTo: "provider/dear" }));
		// Not the first two: escalating early would pay the dear price on every call
		// that was going to succeed anyway on its second roll.
		expect(models()).toEqual(["provider/cheap", "provider/cheap", "provider/dear"]);
	});

	it("costs nothing at all when the ordinary model answers", async () => {
		generateObject.mockResolvedValue({ object: { name: "Millford" }, usage: {} });
		await structured(request({ escalateTo: "provider/dear" }));
		expect(models()).toEqual(["provider/cheap"]);
	});

	it("bills the escalated call against the model that actually ran it", async () => {
		// Otherwise the cost display quietly understates a run by the difference between
		// the two prices, which is the whole reason somebody chose the cheap one.
		generateObject
			.mockRejectedValueOnce(mismatch())
			.mockRejectedValueOnce(mismatch())
			.mockResolvedValueOnce({
				object: { name: "Millford" },
				usage: { inputTokens: 1_000_000, outputTokens: 0 },
			});
		await structured(
			request({ model: "google/gemini-2.5-flash", escalateTo: "google/gemini-2.5-pro" }),
		);
		// The pro price, not the flash one.
		expect(telemetrySnapshot().totalCost).toBeCloseTo(1.25, 6);
	});

	it("simply runs out of attempts when there is nothing dearer to reach for", async () => {
		generateObject.mockRejectedValue(mismatch());
		await structured(request());
		expect(models()).toEqual(["provider/cheap", "provider/cheap", "provider/cheap"]);
	});
});
