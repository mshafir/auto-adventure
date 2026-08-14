import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCraft } from "./cli.js";

/*
 * The CLI, run for real against a temporary scenario root.
 *
 * Through `runCraft` rather than a subprocess, because the property most worth testing is
 * that a *refused* command changed nothing on disk — and a subprocess would make each of
 * these cost a node start. `runCraft` returns the exit code instead of calling
 * `process.exit`, which is what makes that possible.
 */

const SLOW = { timeout: 120_000 };

let root: string;
let previous: string | undefined;
const said: string[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "craft-test-"));
	previous = process.env.AUTO_ADVENTURE_SCENARIOS;
	process.env.AUTO_ADVENTURE_SCENARIOS = root;
	said.length = 0;
});

afterEach(() => {
	if (previous === undefined) delete process.env.AUTO_ADVENTURE_SCENARIOS;
	else process.env.AUTO_ADVENTURE_SCENARIOS = previous;
	rmSync(root, { recursive: true, force: true });
});

/** Run a command and hand back its exit code and everything it said. */
async function craft(...argv: string[]): Promise<{ code: number; out: string }> {
	const lines: string[] = [];
	const code = await runCraft(argv, (line) => {
		lines.push(line);
		said.push(line);
	});
	return { code, out: lines.join("\n") };
}

/**
 * A scenario with two towns founded, which is the floor for most of what follows.
 *
 * Nothing generates a settlement, so both of these exist because this fixture put them there.
 * The two coordinates are cells `craft survey abbey` lists, one on each side of the spawn and
 * far enough apart that their footprints do not touch.
 */
const WENTHOLLOW = 4213455557;

async function twoTowns() {
	await craft(
		"new",
		"abbey",
		"--premise",
		"An abbey goes under.",
		"--duration",
		"short",
		"--seed",
		"abbey",
	);
	await craft(
		"found",
		"abbey",
		"--at",
		"32,-32",
		"--name",
		"Wenthollow",
		"--description",
		"A ferry village.",
		"--structure",
		"mill:Wenthollow Mill",
	);
	await craft(
		"found",
		"abbey",
		"--at",
		"-32,32",
		"--name",
		"Ash Hollow",
		"--description",
		"Five houses in a dip.",
	);
}

describe("craft new", () => {
	it("makes a directory the game can read", SLOW, async () => {
		const { code } = await craft(
			"new",
			"abbey",
			"--premise",
			"An abbey goes under.",
			"--seed",
			"abbey",
		);
		expect(code).toBe(0);
		for (const file of ["scenario.json", "story.md", "world/sites.json"]) {
			expect(existsSync(join(root, "abbey", file)), file).toBe(true);
		}
	});

	it(
		"gives the same name the same country, so an author can ask for that one again",
		SLOW,
		async () => {
			await craft("new", "abbey", "--premise", "x", "--seed", "abbey");
			const first = JSON.parse(readFileSync(join(root, "abbey", "scenario.json"), "utf8"));
			rmSync(join(root, "abbey"), { recursive: true });
			await craft("new", "abbey", "--premise", "x", "--seed", "abbey");
			const again = JSON.parse(readFileSync(join(root, "abbey", "scenario.json"), "utf8"));
			expect(again.seed).toBe(first.seed);
			expect(again.spawn).toEqual(first.spawn);
		},
	);

	it("refuses an id that is not a usable directory name", async () => {
		const { code, out } = await craft("new", "The Abbey", "--premise", "x");
		expect(code).toBe(1);
		expect(out).toContain("lower-case letters");
	});

	it("refuses to write over one that exists", SLOW, async () => {
		await craft("new", "abbey", "--premise", "x", "--seed", "abbey");
		const { code, out } = await craft("new", "abbey", "--premise", "y", "--seed", "abbey");
		expect(code).toBe(1);
		expect(out).toContain("already exists");
	});
});

describe("craft reseed", () => {
	it("shops for a different world", SLOW, async () => {
		await craft("new", "abbey", "--premise", "x", "--seed", "abbey");
		const before = JSON.parse(readFileSync(join(root, "abbey", "scenario.json"), "utf8")).seed;
		const { code } = await craft("reseed", "abbey", "--seed", "elsewhere");
		expect(code).toBe(0);
		expect(JSON.parse(readFileSync(join(root, "abbey", "scenario.json"), "utf8")).seed).not.toBe(
			before,
		);
	});

	/*
	 * Site ids are a function of the seed, so a reseeded scenario would carry correctly-named
	 * towns standing nowhere — and nothing at runtime reports it. Refusing is the only honest
	 * answer once anything has been claimed.
	 */
	it("refuses once a town has been founded", SLOW, async () => {
		await twoTowns();
		const { code, out } = await craft("reseed", "abbey", "--seed", "elsewhere");
		expect(code).toBe(1);
		expect(out).toContain("towns that do not exist");
	});
});

describe("founding and populating", () => {
	it("refuses ground outside the world, and says where the ground is", SLOW, async () => {
		await craft("new", "abbey", "--premise", "x", "--seed", "abbey");
		const { code, out } = await craft(
			"found",
			"abbey",
			"--at",
			"9999,9999",
			"--name",
			"Nowhere",
			"--description",
			"x",
		);
		expect(code).toBe(1);
		expect(out).toContain("outside it");
		expect(out).toContain("can stand on runs from");
	});

	it("refuses two places in one 64-tile cell, because they would share an id", SLOW, async () => {
		// A site's id is hashed from its cell, so the second would overwrite the first as far as
		// `macroSite` is concerned — and the spec written for one would name the other.
		await twoTowns();
		const { code, out } = await craft(
			"found",
			"abbey",
			"--at",
			"40,-40",
			"--name",
			"Twin",
			"--description",
			"x",
		);
		expect(code).toBe(1);
		expect(out).toContain("same 64-tile cell");
		expect(out).toContain("Wenthollow");
	});

	it("refuses a place whose footprint would run into one already there", SLOW, async () => {
		// Legal for the generator and wrong for a player: two footprints that touch read as one
		// sprawling place, which is never what founding a second town meant.
		await twoTowns();
		const { code, out } = await craft(
			"found",
			"abbey",
			"--at",
			"32,32",
			"--kind",
			"town",
			"--importance",
			"5",
			"--name",
			"Sprawl",
			"--description",
			"x",
		);
		expect(code).toBe(1);
		expect(out).toContain("read as one");
	});

	it("refuses more buildings than the ground has room for", SLOW, async () => {
		await craft("new", "abbey", "--premise", "x", "--seed", "abbey");
		const structures = Array.from({ length: 30 }, () => ["--structure", "house"]).flat();
		const { code, out } = await craft(
			"found",
			"abbey",
			"--at",
			"-32,32",
			"--name",
			"Ash Hollow",
			"--description",
			"x",
			...structures,
		);
		expect(code).toBe(1);
		expect(out).toContain("building(s) and 30 were asked for");
	});

	it("writes the recipe entry as well as the spec, so the map builds it", SLOW, async () => {
		// The point of founding rather than claiming: one call produces both the thing the
		// generator lays out and the thing the story names, so they cannot come apart.
		await twoTowns();
		const artifact = JSON.parse(readFileSync(join(root, "abbey", "scenario.json"), "utf8"));
		expect(artifact.recipe.places).toHaveLength(2);
		expect(artifact.recipe.places[0]).toMatchObject({ at: { x: 32, y: -32 }, kind: "village" });
	});

	it("names somebody and hands back the id everything else refers to them by", SLOW, async () => {
		await twoTowns();
		const { code, out } = await craft(
			"npc",
			"add",
			"abbey",
			"--site",
			String(WENTHOLLOW),
			"--name",
			"Ilse Wentworth",
			"--role",
			"ferryman",
			"--at",
			"square",
		);
		expect(code).toBe(0);
		expect(out).toContain("npc:4213455557:0");
	});

	it("refuses a building the town does not have, and lists the ones it does", SLOW, async () => {
		await twoTowns();
		const { code, out } = await craft(
			"npc",
			"add",
			"abbey",
			"--site",
			String(WENTHOLLOW),
			"--name",
			"Somebody",
			"--role",
			"cooper",
			"--in",
			"The Custom House",
		);
		expect(code).toBe(1);
		expect(out).toContain("Wenthollow Mill");
	});

	it("refuses to share the words of somebody who has none written", SLOW, async () => {
		await twoTowns();
		const { code, out } = await craft(
			"npc",
			"add",
			"abbey",
			"--site",
			String(WENTHOLLOW),
			"--name",
			"Somebody",
			"--role",
			"cooper",
			"--like",
			"npc:4213455557:9",
		);
		expect(code).toBe(1);
		expect(out).toContain("has none");
	});
});

describe("placing things", () => {
	/*
	 * The whole argument for the CLI existing rather than an agent editing JSON. An item that
	 * cannot land is a `have` objective that can never be satisfied, and nothing at runtime says
	 * why — so it has to be refused at the call, while the author still remembers what they asked.
	 */
	it("refuses an item that cannot land, and says why", SLOW, async () => {
		await twoTowns();
		const { code, out } = await craft(
			"place",
			"abbey",
			"--item",
			"Ledger",
			"--description",
			"Damp.",
			"--site",
			String(WENTHOLLOW),
			"--in",
			"The Custom House",
		);
		expect(code).toBe(1);
		expect(out).toContain("cannot be placed");
	});

	it("says where an item actually landed", SLOW, async () => {
		await twoTowns();
		const { code, out } = await craft(
			"place",
			"abbey",
			"--item",
			"Ledger",
			"--description",
			"Damp.",
			"--site",
			String(WENTHOLLOW),
			"--in",
			"Wenthollow Mill",
		);
		expect(code).toBe(0);
		expect(out).toContain("lands at");
	});

	it("refuses ground that changes nothing", SLOW, async () => {
		await twoTowns();
		const { code } = await craft("terraform", "abbey", "--clearing", "0,0", "--radius", "1");
		// A radius-1 clearing is five tiles, so this one succeeds — the guard is against an edit
		// that rasterises to nothing at all, which no valid shape does.
		expect(code).toBe(0);
	});
});

describe("check before write", () => {
	/*
	 * The property the whole workspace exists for. A refused command must be a no-op on disk, or
	 * every later failure is ambiguous — is the scenario broken because of this call or the one
	 * before it? — and an agent cannot bisect its own history.
	 */
	it("leaves the scenario exactly as it was when a command is refused", SLOW, async () => {
		await twoTowns();
		const before = readFileSync(join(root, "abbey", "world", "sites.json"), "utf8");

		const { code } = await craft(
			"npc",
			"add",
			"abbey",
			"--site",
			String(WENTHOLLOW),
			"--name",
			"Somebody",
			"--role",
			"cooper",
			"--in",
			"A Building That Is Not There",
		);
		expect(code).toBe(1);
		expect(readFileSync(join(root, "abbey", "world", "sites.json"), "utf8")).toBe(before);
	});

	it("keeps the scenario loadable after every command", SLOW, async () => {
		await twoTowns();
		expect((await craft("check", "abbey")).code).toBe(0);
	});
});

describe("the vocabulary", () => {
	it("says what it can do when asked for nothing", async () => {
		const { code, out } = await craft();
		expect(code).toBe(0);
		expect(out).toContain("craft new");
		expect(out).toContain("craft check");
	});

	it("names a command it does not have rather than failing silently", async () => {
		const { code, out } = await craft("summon", "a-demon");
		expect(code).toBe(1);
		expect(out).toContain('no such command "summon a-demon"');
	});

	it("tells an agent where to go next after every step", SLOW, async () => {
		await craft("new", "abbey", "--premise", "x", "--seed", "abbey");
		expect(said.join("\n")).toContain("next: craft survey abbey");
	});

	it("reports an unreadable scenario differently from a refused request", async () => {
		// One is worth retrying with different arguments and the other is not, and an agent has to
		// be able to tell them apart without reading the message.
		expect((await craft("check", "no-such-scenario")).code).toBe(2);
	});
});
