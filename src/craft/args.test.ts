import { describe, expect, it } from "vitest";
import { Args, CraftError, parseArgs } from "./args.js";

const args = (...argv: string[]) => new Args(parseArgs(argv));

describe("parseArgs", () => {
	it("takes the leading bare words as the verb", () => {
		expect(parseArgs(["scene", "new", "the-abbey", "--at", "12"]).words).toEqual([
			"scene",
			"new",
			"the-abbey",
		]);
	});

	/*
	 * A positional after a flag belongs to that flag — `--path 4,4 9,9` takes two — so only the
	 * leading run of bare words can be the verb. Without this rule a two-position flag would
	 * silently contribute its second value to the verb and the verb would not be found.
	 */
	it("does not take a word after a flag as part of the verb", () => {
		const parsed = parseArgs(["terraform", "--path", "4,4", "9,9"]);
		expect(parsed.words).toEqual(["terraform"]);
		expect(parsed.flags.get("path")).toEqual(["4,4", "9,9"]);
	});

	it("takes both spellings of a flag", () => {
		for (const argv of [["--name", "Wenthollow"], ["--name=Wenthollow"]]) {
			expect(parseArgs(argv).flags.get("name"), argv.join(" ")).toEqual(["Wenthollow"]);
		}
	});

	it("collects a repeated flag in the order it was given", () => {
		expect(parseArgs(["--knows", "one", "--knows", "two"]).flags.get("knows")).toEqual([
			"one",
			"two",
		]);
	});

	it("records a bare flag as present rather than as absent", () => {
		expect(parseArgs(["--live"]).flags.has("live")).toBe(true);
	});

	it("keeps a value that looks like a negative number", () => {
		// Positions are written `x,y` so a leading minus is ordinary. Only `--` starts a flag.
		expect(parseArgs(["--at", "-99,90"]).flags.get("at")).toEqual(["-99,90"]);
	});
});

describe("reading options", () => {
	it("names the option when a required one is missing", () => {
		expect(() => args().str("name")).toThrow("--name is required");
	});

	it("falls back rather than refusing when a default was given", () => {
		expect(args().str("duration", "short")).toBe("short");
	});

	it("says what it wanted when a number is not one", () => {
		expect(() => args("--radius", "wide").int("radius")).toThrow(
			'--radius wants a whole number, not "wide"',
		);
	});

	/*
	 * A flag takes every bare word after it, so an unquoted `--name Ash Hollow` arrives as two
	 * values. Silently keeping the first would name the town "Ash" with nothing to say why — and
	 * an agent writing these calls cannot see the quoting it got wrong.
	 */
	it("refuses several values where one was wanted, and says to quote it", () => {
		expect(() => args("--name", "Ash", "Hollow").str("name")).toThrow(
			'--name wants one value but got 2 ("Ash Hollow") — quote it',
		);
	});

	it("reads a position as x,y", () => {
		expect(args("--at", "39,-31").point("at")).toEqual({ x: 39, y: -31 });
	});

	it("reads the second position of a two-position flag", () => {
		expect(args("--path", "4,4", "9,9").point("path", 1)).toEqual({ x: 9, y: 9 });
	});

	it("says so when a position is missing rather than reading a nonsense one", () => {
		expect(() => args("--path", "4,4").point("path", 1)).toThrow("wants 2 position(s)");
	});

	it("refuses a position that is not one", () => {
		expect(() => args("--at", "the square").point("at")).toThrow('"the square" is not one');
	});

	it("lists the allowed values when a closed set is missed", () => {
		expect(() => args("--surface", "gravel").oneOf("surface", ["path", "dirt", "cobble"])).toThrow(
			"--surface wants one of path, dirt, cobble",
		);
	});

	it("treats a bare flag as true and an absent one as false", () => {
		expect(args("--live").bool("live")).toBe(true);
		expect(args().bool("live")).toBe(false);
	});

	it("drops the empty placeholder from a bare flag's values", () => {
		// `--live` records one empty string so `has` can tell it apart from absent; `list` must
		// not hand that empty string back as if it were a value.
		expect(args("--live").list("live")).toEqual([]);
	});
});

describe("refusing a flag nothing asked about", () => {
	/*
	 * The worst failure a CLI can have when its caller is a program: the call succeeds and the
	 * world is not what was asked for. An agent writing `--desc` for `--description` gets a
	 * site with no description and nothing to tell it why.
	 */
	it("names the flag rather than ignoring it", () => {
		const a = args("--name", "Wenthollow", "--desc", "A ferry village");
		a.str("name");
		expect(() => a.refuseUnknown()).toThrow("does not take --desc");
	});

	it("says nothing when every flag was read", () => {
		const a = args("--name", "Wenthollow", "--live");
		a.str("name");
		a.bool("live");
		expect(() => a.refuseUnknown()).not.toThrow();
	});

	it("counts a flag as read even when it was absent and defaulted", () => {
		const a = args("--name", "Wenthollow");
		a.str("name");
		a.str("short", "Wenthollow");
		expect(() => a.refuseUnknown()).not.toThrow();
	});
});

describe("CraftError", () => {
	it("refuses by default rather than reporting an unreadable scenario", () => {
		// One is worth retrying with different arguments; the other is not, and an agent has to be
		// able to tell them apart without reading the message.
		expect(new CraftError("no").code).toBe(1);
		expect(new CraftError("gone", 2).code).toBe(2);
	});
});
