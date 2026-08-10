import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PACK } from "../core/content/default.js";
import { mergePack } from "../core/content/pack.js";
import { PackOverrideSchema } from "../core/content/schema.js";
import type { AnchorKind } from "../core/gen/features/patch.js";
import { registeredStructures } from "../core/gen/features/structures.js";
import { DECOR, decorDef } from "../core/tiles/decor.js";
import { TERRAIN, terrainByKey } from "../core/tiles/terrain.js";
import { DEFAULT_PALETTE } from "../ui/render/palette.js";
import { resolveTheme } from "../ui/render/theme.js";
import { compilePack, TilePackSchema } from "../ui/render/tile-pack.js";
import { previewRows } from "../ui/render/tile-preview.js";
import { listPacks, packPath } from "./load.js";
import { listTilePacks, readTilePack, tilePackRoot } from "./tiles.js";

/**
 * Every pack in the gallery, held to what a shipped pack has to be.
 *
 * This exists because a pack is three hundred lines of hand-written JSON, which is
 * exactly where a typo hides, and because the loaders are deliberately *lenient*:
 * `readOverride` and `readTilePack` log and fall back rather than throwing, so that a
 * bad pack can never stop a player getting into a game. That policy is right for the
 * runtime and useless for the author — a misspelt terrain key produces a pack that
 * loads, looks nearly right, and silently ignores the line that was the point of
 * writing it.
 *
 * So this suite is the strict reading of the same files. What the schema cannot say is
 * said here: that keys refer to things that exist, that colours resolve, that a pack
 * whose whole purpose is to be *chosen from a list* carries the line the list shows.
 */

const STRUCTURE_KINDS = new Set(registeredStructures().map((def) => def.id));
const TERRAIN_KEYS = new Set(TERRAIN.map((def) => def.key));
const DECOR_KEYS = new Set(DECOR.map((def) => def.key));

/**
 * Where a pack may stand somebody, which is {@link AnchorKind} written out.
 *
 * A placement naming an anchor the generator never emits is a person who is quietly
 * never placed, and the symptom is a shop with nobody outside it rather than an error.
 */
const PLACEMENTS: ReadonlySet<AnchorKind> = new Set<AnchorKind>([
	"square",
	"well",
	"stall",
	"bench",
	"gate",
	"doorstep",
	"counter",
	"hearth",
	"backroom",
	"yard",
]);

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe.each(listPacks())("the content pack %s", (name) => {
	const raw = readJson(packPath(name));
	const parsed = PackOverrideSchema.safeParse(raw);

	it("parses under the pack schema", () => {
		// Reported by path rather than as a wall of zod, because the useful half of a
		// failure here is *which line of a three-hundred-line file* is wrong.
		const issue = parsed.error?.issues[0];
		expect(
			parsed.success,
			issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "",
		).toBe(true);
	});

	it("says in one line what world it is", () => {
		// The schema allows this to be missing, because a pack written before descriptions
		// existed is still a good pack. Nothing shipped from here on should be: a chooser
		// offering nine names is a chooser nobody can answer, and `sunspire` and `thalassa`
		// are both hot and dry.
		expect(parsed.data?.description, `${name} has no description`).toBeTruthy();
	});

	it("merges onto the default without leaving a hole in it", () => {
		const pack = mergePack(DEFAULT_PACK, parsed.data);
		expect(pack.names.given.length).toBeGreaterThan(0);
		expect(pack.names.family.length).toBeGreaterThan(0);
		for (const mood of ["wet", "green", "cold", "dry", "high", "plain"] as const) {
			expect(pack.names.heads[mood].length, `no ${mood} place-name heads`).toBeGreaterThan(0);
		}
		expect(pack.lore.title.length).toBeGreaterThan(0);
	});

	it("names only buildings the generator can build", () => {
		for (const kind of Object.keys(parsed.data?.households ?? {})) {
			expect(STRUCTURE_KINDS, `households.${kind} is not a structure kind`).toContain(kind);
		}
		for (const kind of Object.keys(parsed.data?.outdoorRoles ?? {})) {
			expect(STRUCTURE_KINDS, `outdoorRoles.${kind} is not a structure kind`).toContain(kind);
		}
		for (const kind of Object.keys(parsed.data?.goods?.stores ?? {})) {
			expect(STRUCTURE_KINDS, `goods.stores.${kind} is not a structure kind`).toContain(kind);
		}
	});

	it("stands its people somewhere the generator puts an anchor", () => {
		const placements = [
			...Object.entries(parsed.data?.outdoorRoles ?? {}).map(
				([kind, entry]) => [`outdoorRoles.${kind}`, entry.placement] as const,
			),
			...(parsed.data?.wanderers ?? []).map(
				(entry, i) => [`wanderers[${i}]`, entry.placement] as const,
			),
		];
		for (const [where, placement] of placements) {
			expect(PLACEMENTS, `${where} stands somebody at "${placement}"`).toContain(placement);
		}
	});

	it("forages and gathers from ground that exists", () => {
		for (const key of Object.keys(parsed.data?.goods?.yields ?? {})) {
			expect(terrainByKey(key), `goods.yields.${key} is not a terrain`).toBeDefined();
		}
		for (const key of Object.keys(parsed.data?.goods?.forageChance ?? {})) {
			expect(terrainByKey(key), `goods.forageChance.${key} is not a terrain`).toBeDefined();
		}
	});

	it("sends every trade to a catalogue somebody stocks", () => {
		// A trade whose kind has no catalogue is a shopkeeper with an empty shop, which the
		// player experiences as a shop that will not open rather than as a bad pack.
		const pack = mergePack(DEFAULT_PACK, parsed.data);
		for (const trade of parsed.data?.goods?.trades ?? []) {
			expect(
				pack.goods.catalogue[trade.kind],
				`goods.trades names "${trade.kind}", which nothing stocks`,
			).toBeDefined();
		}
	});

	it("describes people the world can actually contain", () => {
		// An appearance line keyed to a role nobody holds is a line that never prints. It
		// is the commonest way one of these files rots: a role gets renamed in `households`
		// and its two lines are left behind spelt the old way.
		const pack = mergePack(DEFAULT_PACK, parsed.data);
		const roles = new Set<string>();
		for (const household of Object.values(pack.households)) {
			for (const role of household.roles) roles.add(role);
		}
		for (const entry of Object.values(pack.outdoorRoles)) roles.add(entry.role);
		for (const entry of pack.wanderers) roles.add(entry.role);

		for (const role of Object.keys(parsed.data?.appearance ?? {})) {
			expect(roles, `appearance describes "${role}", who is nobody here`).toContain(role);
		}
		for (const role of Object.keys(parsed.data?.talksAbout ?? {})) {
			expect(roles, `talksAbout gives "${role}" a subject, and nobody is one`).toContain(role);
		}
	});
});

describe.each(listTilePacks())("the tile pack %s", (name) => {
	const directory = join(tilePackRoot(), name);
	const raw = readJson(join(directory, "tiles.json"));
	const parsed = TilePackSchema.safeParse(raw);

	it("parses under the tile pack schema", () => {
		const issue = parsed.error?.issues[0];
		expect(
			parsed.success,
			issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "",
		).toBe(true);
	});

	it("says in one line what it looks like", () => {
		expect(parsed.data?.description, `${name} has no description`).toBeTruthy();
	});

	it("draws only tiles that exist", () => {
		const manifest = parsed.data;
		for (const key of Object.keys(manifest?.glyphs?.terrain ?? {})) {
			expect(TERRAIN_KEYS, `glyphs.terrain.${key} is not a terrain`).toContain(key);
		}
		for (const key of Object.keys(manifest?.glyphs?.decor ?? {})) {
			expect(DECOR_KEYS, `glyphs.decor.${key} is not a decor`).toContain(key);
		}
		for (const key of Object.keys(manifest?.sprites?.terrain ?? {})) {
			expect(TERRAIN_KEYS, `sprites.terrain.${key} is not a terrain`).toContain(key);
		}
		for (const key of Object.keys(manifest?.sprites?.decor ?? {})) {
			expect(DECOR_KEYS, `sprites.decor.${key} is not a decor`).toContain(key);
		}
	});

	it("recolours swatches the game actually has", () => {
		// A palette entry under a name nothing reads is the quietest failure a tile pack
		// has: the file is valid, the colour is right, and it is applied to nothing.
		for (const key of Object.keys(parsed.data?.palette ?? {})) {
			expect(DEFAULT_PALETTE, `palette.${key} is not a palette entry`).toHaveProperty(key);
		}
	});

	it("refers to colours it can resolve", () => {
		const palette = { ...DEFAULT_PALETTE, ...(parsed.data?.palette ?? {}) };
		const drafts = [
			...Object.entries(parsed.data?.glyphs?.terrain ?? {}),
			...Object.entries(parsed.data?.glyphs?.decor ?? {}),
		];
		for (const [key, draft] of drafts) {
			for (const [field, ref] of [
				["fg", draft.fg],
				["bg", draft.bg],
			] as const) {
				if (ref === undefined) continue;
				// A missing name renders magenta rather than throwing, by design. That is the
				// right runtime behaviour and the wrong thing to ship.
				if (ref.startsWith("#")) continue;
				expect(palette, `${key}.${field} is "${ref}", which is no colour`).toHaveProperty(ref);
			}
		}
	});

	it("references only atlas cells it ships", () => {
		const wantsAtlas = [
			...Object.values(parsed.data?.sprites?.terrain ?? {}),
			...Object.values(parsed.data?.sprites?.decor ?? {}),
			...Object.values(parsed.data?.sprites?.glyph ?? {}),
		].some((draft) => "atlas" in draft);
		if (!wantsAtlas) return;
		expect(
			existsSync(join(directory, "atlas.png")),
			`${name} points at atlas cells and ships no atlas.png`,
		).toBe(true);
	});

	it("compiles to a theme the renderer will accept", () => {
		// `readTilePack` swallows a refusal and falls back to the built-in look, so the
		// only way to find out that a pack was rejected for an unsafe glyph is to do what
		// it does and look at what comes back.
		const manifest = parsed.data;
		expect(manifest).toBeDefined();
		if (!manifest) return;
		const atlasPath = join(directory, "atlas.png");
		const atlas = existsSync(atlasPath) ? readFileSync(atlasPath) : undefined;
		expect(() => resolveTheme(compilePack(manifest, atlas))).not.toThrow();
	});

	it("can be previewed, which is how it is chosen", () => {
		const theme = readTilePack(directory);
		expect(theme, `${name} was refused by the loader`).toBeDefined();
		if (!theme) return;
		const rows = previewRows(theme);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			for (const cell of row) {
				expect(cell.ch.length, "a preview cell must be one character").toBe(1);
			}
		}
	});
});

describe("the gallery as a whole", () => {
	it("offers more than one world and more than one look", () => {
		// The batch this suite was written for exists to answer one question — whether the
		// pack format carries a *genre* — and a gallery of one cannot answer it.
		expect(listPacks().length).toBeGreaterThan(1);
		expect(listTilePacks().length).toBeGreaterThan(1);
	});

	it("names every decor it ships", () => {
		// Cheap, and it catches the one mistake appending to the registry invites: an entry
		// added for its id with the name left off the end.
		for (const def of DECOR) {
			if (def.key === "none") continue;
			expect(decorDef(def.id).name.length, `decor "${def.key}" has no name`).toBeGreaterThan(0);
		}
	});
});
