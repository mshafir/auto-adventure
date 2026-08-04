import { describe, expect, it } from "vitest";
import { isBriefEmpty, isDuration, normalizeBrief, type ScenarioBrief } from "./brief.js";

describe("normalizeBrief", () => {
	it("trims every field", () => {
		const brief = normalizeBrief({
			premise: "  a drowned archipelago  ",
			setting: "\tthe tithe-ships\n",
			tone: " wry ",
		});
		expect(brief).toEqual({
			premise: "a drowned archipelago",
			setting: "the tithe-ships",
			tone: "wry",
		});
	});

	it("drops blank fields rather than passing them on as instructions", () => {
		const brief = normalizeBrief({ premise: "a debt-collector's world", setting: "   ", tone: "" });
		expect(brief).toEqual({ premise: "a debt-collector's world" });
		expect(brief).not.toHaveProperty("setting");
		expect(brief).not.toHaveProperty("tone");
	});

	it("collapses an all-blank brief to undefined", () => {
		expect(normalizeBrief({ premise: "  ", setting: "", storyline: "\n" })).toBeUndefined();
		expect(normalizeBrief({})).toBeUndefined();
		expect(normalizeBrief(undefined)).toBeUndefined();
	});

	it("keeps a duration even when every prose field is blank", () => {
		expect(normalizeBrief({ premise: " ", duration: "short" })).toEqual({ duration: "short" });
	});

	it("survives a hand-edited save whose brief is not an object", () => {
		// `migrate.ts` funnels untrusted JSON through here, so a string where an
		// object belongs must read as "no brief" rather than throw on load.
		expect(normalizeBrief("a pirate story" as unknown as ScenarioBrief)).toBeUndefined();
	});
});

describe("isBriefEmpty", () => {
	it("treats absent and contentless briefs alike", () => {
		expect(isBriefEmpty(undefined)).toBe(true);
		expect(isBriefEmpty({})).toBe(true);
	});

	it("counts any single field as content", () => {
		expect(isBriefEmpty({ avoid: "dragons" })).toBe(false);
		expect(isBriefEmpty({ duration: "long" })).toBe(false);
	});

	it("does not count whitespace as content", () => {
		expect(isBriefEmpty({ premise: "   " })).toBe(true);
		expect(isBriefEmpty({ premise: "\t\n", avoid: " " })).toBe(true);
	});
});

describe("isDuration", () => {
	it("accepts the three known durations", () => {
		expect(isDuration("short")).toBe(true);
		expect(isDuration("medium")).toBe(true);
		expect(isDuration("long")).toBe(true);
	});

	it("rejects anything else", () => {
		expect(isDuration("epic")).toBe(false);
		expect(isDuration("")).toBe(false);
		expect(isDuration("Short")).toBe(false);
	});
});
