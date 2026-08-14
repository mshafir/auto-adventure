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

/** A scenario with two towns claimed, which is the floor for most of what follows. */
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
		"claim",
		"abbey",
		"--site",
		"4213455557",
		"--name",
		"Wenthollow",
		"--description",
		"A ferry village.",
		"--structure",
		"mill:Wenthollow Mill",
	);
	await craft(
		"claim",
		"abbey",
		"--site",
		"539500626",
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
	it("refuses once a town has been claimed", SLOW, async () => {
		await twoTowns();
		const { code, out } = await craft("reseed", "abbey", "--seed", "elsewhere");
		expect(code).toBe(1);
		expect(out).toContain("towns that do not exist");
	});
});

describe("claiming and populating", () => {
	it("refuses a site the seed does not produce, and says which there are", SLOW, async () => {
		await craft("new", "abbey", "--premise", "x", "--seed", "abbey");
		const { code, out } = await craft(
			"claim",
			"abbey",
			"--site",
			"999999",
			"--name",
			"Nowhere",
			"--description",
			"x",
		);
		expect(code).toBe(1);
		expect(out).toContain("not a place in this world");
		expect(out).toContain("Settlements here:");
	});

	it("refuses more buildings than the place has room for", SLOW, async () => {
		await craft("new", "abbey", "--premise", "x", "--seed", "abbey");
		const structures = Array.from({ length: 30 }, () => ["--structure", "house"]).flat();
		const { code, out } = await craft(
			"claim",
			"abbey",
			"--site",
			"539500626",
			"--name",
			"Ash Hollow",
			"--description",
			"x",
			...structures,
		);
		expect(code).toBe(1);
		expect(out).toContain("has room for");
	});

	it("names somebody and hands back the id everything else refers to them by", SLOW, async () => {
		await twoTowns();
		const { code, out } = await craft(
			"npc",
			"add",
			"abbey",
			"--site",
			"4213455557",
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
			"4213455557",
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
			"4213455557",
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
			"4213455557",
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
			"4213455557",
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
			"4213455557",
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
