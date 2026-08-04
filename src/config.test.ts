import { describe, expect, it } from "vitest";
import { briefFromEnv, resolveSeed } from "./config.js";

describe("briefFromEnv", () => {
	it("is undefined when nothing was asked for", () => {
		expect(briefFromEnv({})).toBeUndefined();
	});

	it("reads the freeform prompt into the premise", () => {
		expect(briefFromEnv({ SCENARIO_PROMPT: "a drowned archipelago" })).toEqual({
			premise: "a drowned archipelago",
		});
	});

	it("reads every field", () => {
		const brief = briefFromEnv({
			SCENARIO_PROMPT: "a drowned archipelago",
			SCENARIO_SETTING: "the tithe-ships",
			SCENARIO_STORYLINE: "hunting a sibling",
			SCENARIO_TONE: "wry",
			SCENARIO_PROTAGONIST: "a debt-clerk",
			SCENARIO_AVOID: "dragons",
			SCENARIO_DURATION: "short",
		});
		expect(brief).toEqual({
			premise: "a drowned archipelago",
			setting: "the tithe-ships",
			storyline: "hunting a sibling",
			tone: "wry",
			protagonist: "a debt-clerk",
			avoid: "dragons",
			duration: "short",
		});
	});

	it("treats an empty variable as unset", () => {
		// `SCENARIO_TONE=` in a .env file is how someone disables a field, not how
		// they ask for a world with no tone.
		expect(briefFromEnv({ SCENARIO_PROMPT: "a quiet valley", SCENARIO_TONE: "" })).toEqual({
			premise: "a quiet valley",
		});
	});

	it("drops an unrecognised duration rather than failing to start", () => {
		// Duration only means something to the offline authoring tool, which is
		// where a bad value deserves a real error. Here it must not cost the player
		// a playable game.
		expect(briefFromEnv({ SCENARIO_PROMPT: "a quiet valley", SCENARIO_DURATION: "epic" })).toEqual({
			premise: "a quiet valley",
		});
	});

	it("does not invent a brief from a duration alone being invalid", () => {
		expect(briefFromEnv({ SCENARIO_DURATION: "epic" })).toBeUndefined();
	});
});

describe("resolveSeed", () => {
	it("hashes a word and passes a number through", () => {
		expect(resolveSeed("hollowmoor")).toBe(resolveSeed("hollowmoor"));
		expect(resolveSeed("hollowmoor")).not.toBe(resolveSeed("thornwick"));
		expect(resolveSeed("42")).toBe(42);
		expect(resolveSeed("-7")).toBe(-7);
	});
});
