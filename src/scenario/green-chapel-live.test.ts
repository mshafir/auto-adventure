import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openingNode } from "../ai/dialogue/tree.js";
import { resolveOverride } from "../content/load.js";
import { resolveTileTheme } from "../content/tiles.js";
import { castleGateTiles } from "../core/gen/features/castle.js";
import { hasCaveMouth } from "../core/gen/features/cave.js";
import { dockPiers } from "../core/gen/features/docks.js";
import { getComplex, getInterior } from "../core/gen/features/interior.js";
import type { StructureKind } from "../core/gen/features/patch.js";
import { generateFeature } from "../core/gen/features/registry.js";
import { arcOutline, beatEffects, branchKey, orderedBeats } from "../core/rules/arc.js";
import { type Condition, evaluate } from "../core/rules/condition.js";
import { pickEnding } from "../core/rules/ending.js";
import { macroSite } from "../core/world/macro.js";
import { npcId } from "../core/world/spec.js";
import { resolveBarriers } from "../engine/barriers.js";
import { approaches, resolvePlacements } from "../engine/placements.js";
import { buildSession } from "../session.js";
import { artifactWorld, type ScenarioArtifact } from "./artifact.js";
import { assembleArtifact, ScenarioDraftSchema } from "./draft.js";
import { readScenarioFile, scenarioPath } from "./repo.js";
import { hasErrors, validateArtifact } from "./validate.js";

/**
 * The Arthurian scenario, in the world it asks for.
 *
 * `thornwick-live.test.ts` covers the gameplay vocabulary — a gate, a lock, a placed
 * item, a fork. This one covers the half that arrived with it and had no shipped
 * content exercising it: a scenario that *describes its world* rather than rolling for
 * one. Three of the four places here exist only because the recipe asked for them, and
 * each of the three declines to build rather than compromising, so "the castle is
 * there" is a real assertion and not a tautology.
 */

let home: string;
let artifact: ScenarioArtifact;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-green-chapel-"));
	process.env.AUTO_ADVENTURE_HOME = home;
	const read = readScenarioFile(scenarioPath("green-chapel"));
	if (!read) throw new Error("the shipped scenario does not load");
	artifact = read;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

const CAMELOT = 3199628140;
const HAUTDESERT = 3839432062;
const CHAPEL = 3868645844;
const FERRY = 347348444;

function start(worldId = "green-chapel-live") {
	const session = buildSession(
		{ worldId, seed: 0, flavour: "prebuilt", scenario: artifact },
		{ saveDebounceMs: 0 },
	);
	session.engine.dispatch({ t: "DismissCard" });

	const state = () => session.engine.getState();
	const goTo = (x: number, y: number) => {
		session.engine.dispatch({ t: "ApplyEffects", effects: [{ t: "Teleport", x, y }] });
	};
	const set = (key: string, value: string | number | boolean = true) => {
		session.engine.dispatch({ t: "ApplyEffects", effects: [{ t: "SetFlag", key, value }] });
	};
	const talkTo = async (siteId: number, slot: number) => {
		const person = session.engine.personById(npcId(siteId, slot));
		if (!person) return undefined;
		session.engine.dispatch({ t: "DialogueOpened", npcId: person.id, npcName: person.name });
		// The first line comes back through the dialogue service, and `talked` reads the
		// turn it records — so a zero-tick wait is not always long enough.
		await new Promise((resolve) => setTimeout(resolve, 20));
		return person;
	};

	return { session, state, goTo, set, talkTo };
}

/** The site a recipe put somewhere, found by the cell its coordinates fall in. */
function siteAt(x: number, y: number) {
	return macroSite(artifactWorld(artifact), Math.floor(x / 64), Math.floor(y / 64));
}

describe("the shipped Arthurian scenario", () => {
	it("validates with no errors", () => {
		const findings = validateArtifact(artifact);
		expect(findings.filter((f) => f.severity === "error").map((f) => f.message)).toEqual([]);
		expect(hasErrors(findings)).toBe(false);
	});

	it("carries a recipe, a tile pack and a clock into the world", () => {
		expect(artifact.recipe?.places).toHaveLength(4);
		expect(artifact.tiles).toBe("gramarye");
		// The world keeps its day. A fifteen-minute story cannot afford the lord of the
		// house to be in bed when the errand names him, and the only way to say that used
		// to be turning the clock off for everybody — which costs every village its
		// evening in order to pin one man. `stays` pins the cast instead.
		expect(artifact.time?.schedules).toBeUndefined();
		const pinned = Object.values(artifact.sites).flatMap((spec) =>
			spec.npcs.filter((npc) => npc.stays).map((npc) => npc.name),
		);
		expect(pinned).toContain("Bertilak de Hautdesert");
		expect(pinned).toContain("Hodierne the ferryman");
	});

	it("names a tile pack that is on disk and actually overrides things", () => {
		// `resolveTileTheme` falls back to the built-in look for *every* way a pack can be
		// wrong — missing, unparseable, a double-width glyph — and logs rather than
		// throwing. So a pack that has quietly stopped loading looks exactly like a pack
		// nobody asked for, and only the name can tell them apart.
		const theme = resolveTileTheme(artifact.tiles);
		expect(theme.name).toBe("gramarye");
		expect(theme.hasBitmaps).toBe(true);
		const sprites = [
			...Object.values(theme.sprites.byTerrain ?? {}),
			...Object.values(theme.sprites.byDecor ?? {}),
			...Object.values(theme.sprites.byGlyph ?? {}),
		];
		// All four spellings a pack may use, so a regression in any one of them shows up
		// as a missing kind rather than as a tile that silently fell back.
		expect(new Set(sprites.map((sprite) => sprite.kind))).toEqual(
			new Set(["shape", "density", "mask", "bitmap"]),
		);
	});
});

describe("the draft it was assembled from", () => {
	it("still produces exactly the artifact on disk", () => {
		/*
		 * The proof that the draft format is complete.
		 *
		 * The whole newer vocabulary — conditions, triggers, gates, placed items, forks,
		 * indoor people — used to be hand-written into the artifact *after* assembly, so
		 * the loop was: assemble once, patch by hand, then never re-assemble, because
		 * re-running the tool discarded every edit without saying so. A scenario that
		 * round-trips is a scenario where nothing is left that only hand-editing can say.
		 *
		 * Compared against the *file*, not against `readScenarioFile`'s value: reading one
		 * resolves the named content pack and inlines it, so the loaded artifact carries a
		 * `content` block the file does not. `authoredWith.at` is a timestamp and is the
		 * one field that legitimately differs.
		 */
		const raw = JSON.parse(readFileSync(join("drafts", "green-chapel.json"), "utf8"));
		const parsed = ScenarioDraftSchema.safeParse(raw);
		expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([]);
		if (!parsed.success) return;

		const onDisk = JSON.parse(readFileSync(scenarioPath("green-chapel"), "utf8"));
		const pack = resolveOverride(parsed.data.pack ?? "");
		const rebuilt = assembleArtifact(parsed.data, onDisk.authoredWith.at, {
			...(pack ? { pack } : {}),
		});
		expect(JSON.parse(JSON.stringify(rebuilt))).toEqual(onDisk);
	});
});

describe("the three places the recipe asked for", () => {
	/*
	 * Each of these builds *nothing* when the ground is wrong — a castle with no level
	 * square, a dock with no shoreline, a cave with no hillside — and an empty patch
	 * leaves the wilderness exactly as it was. So the story hanging off them is only
	 * safe while these hold, and they hold because of where the recipe put them.
	 */

	it("stands Camelot and Hautdesert up, each with one way in", () => {
		const world = artifactWorld(artifact);
		for (const [siteId, at] of [
			[CAMELOT, { x: 16, y: -16 }],
			[HAUTDESERT, { x: -16, y: -120 }],
		] as const) {
			const spec = artifact.sites[String(siteId)];
			if (!spec) throw new Error(`no spec for ${siteId}`);
			const site = siteAt(at.x, at.y);
			expect(site.id).toBe(siteId);
			const patch = generateFeature(world, site, spec.settlement);
			expect(patch?.buildings.length ?? 0).toBeGreaterThan(2);
			// Three tiles wide: a gate on one tile of a three-wide arch is not a gate.
			expect(castleGateTiles(world, site)).toHaveLength(3);
		}
	});

	it("finds Holm Ferry a shoreline to moor against", () => {
		const world = artifactWorld(artifact);
		const site = siteAt(-48, -56);
		expect(site.id).toBe(FERRY);
		expect(dockPiers(world, site).length).toBeGreaterThan(0);
	});

	it("cuts the Green Chapel into a hillside, with three levels under it", () => {
		const world = artifactWorld(artifact);
		const site = siteAt(32, -112);
		expect(site.id).toBe(CHAPEL);
		const spec = artifact.sites[String(CHAPEL)];
		if (!spec) throw new Error("no spec for the chapel");
		const patch = generateFeature(world, site, spec.settlement);
		expect(patch && hasCaveMouth(patch)).toBe(true);

		const mouth = patch?.buildings[0];
		expect(mouth?.kind).toBe("cave");
		if (!mouth) return;
		const levels = getComplex(artifact.seed, mouth.interiorId, "cave");
		expect(levels).toHaveLength(3);
		// Every level reachable from the one above by a stair that lands on the stair
		// coming back up. Generated as one complex precisely so this is true by
		// construction rather than by two generators agreeing.
		for (const [index, level] of levels.entries()) {
			const down = level.portals.find((portal) => portal.kind === "down");
			if (index === levels.length - 1) {
				expect(down).toBeUndefined();
				continue;
			}
			expect(down?.to).toBe(index + 1);
			const below = levels[index + 1];
			const up = below?.portals.find((portal) => portal.kind === "up");
			expect(up?.to).toBe(index);
			expect({ x: up?.x, y: up?.y }).toEqual({ x: down?.x, y: down?.y });
		}
	});

	it("leaves the mound empty, on every level of it", () => {
		// Nobody lives in a hole in a hillside. A pack that says nothing about caves used
		// to fall straight through to the household of a *house*, so the least inhabited
		// place in the story generated a weaver, a cooper and a widow standing about in it
		// — and the player walked in expecting the Green Knight and found three villagers.
		const world = artifactWorld(artifact);
		const spec = artifact.sites[String(CHAPEL)];
		if (!spec) throw new Error("no spec for the chapel");
		const mouth = generateFeature(world, siteAt(32, -112), spec.settlement)?.buildings[0];
		if (!mouth) throw new Error("the mound did not open");

		const { session } = start();
		for (let level = 0; level < 3; level++) {
			expect(session.engine.getResidents().in(mouth.interiorId, "cave", level)).toEqual([]);
		}
		session.dispose();
	});
});

describe("the gate of Hautdesert", () => {
	/** One tile south of the middle of the gate span, facing north into the arch. */
	const APPROACH = { x: -12, y: -100 };

	function atTheGate() {
		const started = start();
		started.goTo(APPROACH.x, APPROACH.y);
		started.session.engine.getChunks().prefetch({ cx: -1, cy: -2 }, 2);
		started.session.engine.populateNpcs({ cx: -1, cy: -2 });
		started.session.engine.dispatch({ t: "Move", facing: "up" });
		return started;
	}

	it("names the castle's gate rather than copying its coordinates", () => {
		// The scenario says `{ siteId, at: "gate" }` and the span is resolved against the
		// generator when the world opens. That is the whole point: pasted coordinates go
		// stale the moment the recipe moves the castle, and a stale gate blocks nothing
		// while looking exactly like a gate that works.
		const barrier = artifact.barriers?.find((entry) => entry.id === "hautdesert-gate");
		expect(barrier?.tiles).toEqual({ siteId: HAUTDESERT, at: "gate" });

		const { resolved, unresolved } = resolveBarriers(artifact.barriers, {
			world: artifactWorld(artifact),
			bounds: artifact.bounds,
		});
		expect(unresolved).toEqual([]);
		const span = castleGateTiles(artifactWorld(artifact), siteAt(-16, -120));
		expect(resolved[0]?.tiles).toEqual(span.map((tile) => ({ x: tile.x, y: tile.y })));
	});

	it("refuses the arch until the porter has taken a name in", () => {
		const { session, state } = atTheGate();
		session.engine.dispatch({ t: "Move", facing: "up" });
		expect(state().notice).toContain("barred");
		expect(state().player.y).toBe(APPROACH.y);
		session.dispose();
	});

	it("opens once he has, on having met him and nothing else", async () => {
		/*
		 * `{ talked: <the porter> }`, not a beat flag.
		 *
		 * It was a beat flag, and the beat waited on a conversation with Sir Kay a
		 * hundred tiles away at Camelot — so a player who rode north without stopping to
		 * chat with the seneschal arrived at a gate, met the gatekeeper, heard him say
		 * "bar's up", and watched it stay shut. The gate is about the porter. Anything
		 * else in the condition is a way for the story to strand somebody.
		 */
		const barrier = artifact.barriers?.find((entry) => entry.id === "hautdesert-gate");
		expect(barrier?.opensWhen).toEqual({ talked: npcId(HAUTDESERT, 2) });

		const { session, state, talkTo } = atTheGate();
		await talkTo(HAUTDESERT, 2);
		session.engine.dispatch({ t: "CloseDialogue" });
		session.engine.dispatch({ t: "Move", facing: "up" });
		expect(state().flags["barrier:hautdesert-gate"]).toBe(true);
		session.engine.dispatch({ t: "Move", facing: "up" });
		expect(state().player.y).toBeLessThan(APPROACH.y);
		session.dispose();
	});

	it("stands the porter clear of the arch and of the road into it", () => {
		// Walking into somebody opens a conversation before anything else is considered,
		// so a gatekeeper on the gate — or on the tile the road leads to — is a gate that
		// can never be bumped, and therefore never opened.
		const { session, goTo } = start();
		goTo(APPROACH.x, APPROACH.y);
		session.engine.getChunks().prefetch({ cx: -1, cy: -2 }, 2);
		session.engine.populateNpcs({ cx: -1, cy: -2 });
		const porter = session.engine.personById(npcId(HAUTDESERT, 2));
		expect(porter, "the porter is nowhere").toBeDefined();
		const span = castleGateTiles(artifactWorld(artifact), siteAt(-16, -120));
		for (const tile of span) {
			expect({ x: porter?.x, y: porter?.y }).not.toEqual({ x: tile.x, y: tile.y });
		}
		expect({ x: porter?.x, y: porter?.y }).not.toEqual(APPROACH);
		session.dispose();
	});
});

describe("what the story hides and where", () => {
	it("puts every authored item somewhere that exists", () => {
		const { resolved, unresolved } = resolvePlacements(artifact.placements, {
			world: artifactWorld(artifact),
			siteSpec: (siteId) => artifact.sites[String(siteId)],
			bounds: artifact.bounds,
		});
		expect(unresolved).toEqual([]);
		expect(resolved).toHaveLength(artifact.placements?.length ?? 0);

		// Named, not guessed. The girdle used to land in the Lady's Bower only because it
		// was the roster's only `house` — true until somebody adds a second one.
		const girdle = (artifact.placements ?? []).find((p) => p.id === "the-green-girdle");
		expect(girdle?.at).toMatchObject({ structure: "The Lady's Bower" });

		// And two storeys down. The cave has three levels and everything below the mouth
		// used to be unreachable by anything a scenario could write, because a placement
		// keyed on the interior id alone would have appeared on every one of them.
		const whetstone = resolved.find((entry) => entry.id === "the-whetstone");
		expect(whetstone?.level).toBe(2);
		const holly = resolved.find((entry) => entry.id === "the-holly-bob");
		expect(whetstone?.interiorId).toBe(holly?.interiorId);
		expect(holly?.level ?? 0).toBe(0);
	});

	it("puts nothing where the player cannot stand beside it", () => {
		/*
		 * Searching is a *faced* gesture in four directions, so a tile whose every
		 * orthogonal neighbour is blocked cannot be searched however visible it is. The
		 * axe shipped in a crate against the north wall of the keep with a crate on
		 * either side of it and a resident on the fourth: marked, drawn, and impossible.
		 * Nothing anywhere had gone wrong.
		 */
		const world = artifactWorld(artifact);
		const sites = new Map(
			[...Array(13).keys()]
				.flatMap((i) => [...Array(13).keys()].map((j) => macroSite(world, i - 6, j - 6)))
				.map((site) => [site.id, site]),
		);
		// Which room each interior id is, taken from the sites themselves — a building's
		// kind decides its floor plan, so asking with the wrong one measures a room that
		// does not exist.
		const kinds = new Map<number, StructureKind>();
		for (const spec of Object.values(artifact.sites)) {
			const site = sites.get(spec.siteId);
			if (!site) continue;
			for (const building of generateFeature(world, site, spec.settlement)?.buildings ?? []) {
				kinds.set(building.interiorId, building.kind);
			}
		}

		const { resolved } = resolvePlacements(artifact.placements, {
			world,
			siteSpec: (siteId) => artifact.sites[String(siteId)],
			bounds: artifact.bounds,
		});
		for (const entry of resolved) {
			if (entry.interiorId === undefined) continue;
			const kind = kinds.get(entry.interiorId);
			expect(kind, `${entry.id} is in a building no site built`).toBeDefined();
			if (!kind) continue;
			const interior = getInterior(artifact.seed, entry.interiorId, kind, entry.level ?? 0);
			expect(
				approaches(interior, entry.x, entry.y).length,
				`${entry.id} has no tile the player can search it from`,
			).toBeGreaterThan(0);
		}
	});

	it("puts the Lady in her bower rather than on its doorstep", () => {
		// The locked door now opens onto a scene instead of an empty box. Her id is still
		// the site's own, which is what lets the beat anchored to her, the dialogue tree
		// written for her and the `talk` objective naming her all work unchanged.
		const spec = artifact.sites[String(HAUTDESERT)];
		const lady = spec?.npcs.find((npc) => npc.name === "the Lady of Hautdesert");
		expect(lady?.indoors).toBe(true);
		expect(lady?.structureName).toBe("The Lady's Bower");

		const beat = artifact.arc?.beats.find((entry) => entry.id === "the-ladys-gift");
		expect(beat?.npcSlot).toBe(lady?.slot);

		const { session, goTo } = start();
		goTo(-2, -122);
		session.engine.getChunks().prefetch({ cx: -1, cy: -2 }, 2);
		const bower = [-1, 0, 1]
			.flatMap((dy) => [-1, 0, 1].map((dx) => ({ dx, dy })))
			.flatMap(({ dx, dy }) => [...session.engine.getChunks().buildingsIn(-1 + dx, -2 + dy)])
			.find((building) => building.name === "The Lady's Bower");
		expect(bower, "the bower was not built").toBeDefined();
		if (!bower) return;
		expect(
			session.engine
				.getResidents()
				.in(bower.interiorId, bower.kind)
				.some((person) => person.name === "the Lady of Hautdesert"),
		).toBe(true);
		session.dispose();
	});

	it("still has her there once the player is standing in the room", () => {
		/*
		 * The same question, asked the way the game asks it — from inside.
		 *
		 * The test above passes with the player outdoors, and that is the whole reason it
		 * missed this: working out who a scenario put in a room means finding the building
		 * with that interior id, which means searching the chunks around the player — and
		 * indoors `player.x/y` are local to the interior grid. A bower at (-1,-122) reads
		 * as (5,7), so the search ran three chunks from the world origin, found nothing,
		 * and the room filled up with household strangers instead. Nothing errored. The
		 * Lady was simply not in her bower, and the beat anchored to her could not open.
		 */
		const { session, goTo, set } = start();
		set("arc:the-exchange-of-winnings"); // the bower door is latched until the covenant
		goTo(-1, -121);
		session.engine.getChunks().prefetch({ cx: -1, cy: -2 }, 2);

		// In through the door on foot, rather than by writing `inside` into the state:
		// the bug lived in the difference between the two.
		for (let step = 0; step < 4 && !session.engine.getState().player.inside; step++) {
			session.engine.dispatch({ t: "Move", facing: "up" });
		}
		const inside = session.engine.getState().player.inside;
		expect(inside?.name, "the player never got through the bower door").toBe("The Lady's Bower");

		const lady = session.engine.personById(npcId(HAUTDESERT, 1));
		expect(lady?.name).toBe("the Lady of Hautdesert");
		if (!lady) return;
		// And solid, so walking into her is a conversation.
		expect(session.engine.personAt(lady.x, lady.y)?.id).toBe(npcId(HAUTDESERT, 1));
		session.dispose();
	});

	it("makes her a scene: speaking to her opens the beat and the girdle is in the room", () => {
		/*
		 * The other half of "nothing happens in there". An indoor person keeps the id they
		 * would have had in the street, and this is what that buys: the beat anchored to
		 * her opens on an ordinary conversation, the beat's flag is what the girdle's
		 * placement waits on, and so the room she talks about the girdle in is the room it
		 * appears in. No indoor beat machinery anywhere in that chain.
		 */
		const { session, state, goTo, set } = start();
		set("arc:the-exchange-of-winnings");
		goTo(-1, -121);
		session.engine.getChunks().prefetch({ cx: -1, cy: -2 }, 2);
		for (let step = 0; step < 4 && !state().player.inside; step++) {
			session.engine.dispatch({ t: "Move", facing: "up" });
		}
		const inside = state().player.inside;
		if (!inside) throw new Error("the player never got through the bower door");

		const lady = session.engine.personById(npcId(HAUTDESERT, 1));
		if (!lady) throw new Error("the Lady is not in her bower");
		expect(state().flags["arc:the-ladys-gift"]).toBeUndefined();
		expect(
			session.engine.markedPlacements(),
			"the girdle is in the room before she has offered it",
		).toEqual([]);

		session.engine.dispatch({ t: "DialogueOpened", npcId: lady.id, npcName: lady.name });
		expect(state().flags["arc:the-ladys-gift"]).toBe(true);

		// Marked, not hidden. She says it is within arm's reach of the chair she sat you
		// in, and a room the player has to search tile by tile to find it in makes a liar
		// of her.
		const here = session.engine.markedPlacements();
		expect(here.map((entry) => entry.placement.item.name)).toEqual(["Green Girdle"]);
		expect(here[0]?.interiorId).toBe(inside.interiorId);
		session.dispose();
	});

	it("gives her the girdle even if the player rummaged the bower first", () => {
		/*
		 * The order a player actually walks it. The door opens on the covenant, so they
		 * are in the room before she has said anything — and the one thing to do in a
		 * strange room is open the furniture. Under a positional taken-flag that search
		 * consumed the girdle before it existed, and the errand the quest log was pointing
		 * at could not be finished by any means.
		 */
		const { session, state, goTo, set } = start();
		set("arc:the-exchange-of-winnings");
		goTo(-1, -121);
		session.engine.getChunks().prefetch({ cx: -1, cy: -2 }, 2);
		for (let step = 0; step < 4 && !state().player.inside; step++) {
			session.engine.dispatch({ t: "Move", facing: "up" });
		}
		const inside = state().player.inside;
		if (!inside) throw new Error("the player never got through the bower door");

		// Where it will be, found the way the resolver finds it, and emptied now.
		const { resolved } = resolvePlacements(artifact.placements, {
			world: artifactWorld(artifact),
			siteSpec: (siteId) => artifact.sites[String(siteId)],
			bounds: artifact.bounds,
		});
		const girdle = resolved.find((entry) => entry.id === "the-green-girdle");
		if (!girdle) throw new Error("the girdle resolves nowhere");
		session.engine.dispatch({
			t: "ApplyEffects",
			effects: [{ t: "Teleport", x: girdle.x, y: girdle.y + 1 }],
		});
		session.engine.dispatch({ t: "Interact" });
		expect(state().inventory.some((item) => item.name === "Green Girdle")).toBe(false);

		const lady = session.engine.personById(npcId(HAUTDESERT, 1));
		if (!lady) throw new Error("the Lady is not in her bower");
		session.engine.dispatch({ t: "DialogueOpened", npcId: lady.id, npcName: lady.name });
		session.engine.dispatch({ t: "CloseDialogue" });

		session.engine.dispatch({ t: "Interact" });
		expect(state().inventory.some((item) => item.name === "Green Girdle")).toBe(true);
		session.dispose();
	});

	it("keeps the Green Knight out of the world until you have met his other face", async () => {
		const { session, state, goTo, set, talkTo } = start();
		goTo(30, -107);
		session.engine.getChunks().prefetch({ cx: 0, cy: -2 }, 2);
		session.engine.populateNpcs({ cx: 0, cy: -2 });

		expect(session.engine.personById(npcId(CHAPEL, 0))).toBeUndefined();
		expect(await talkTo(CHAPEL, 0)).toBeUndefined();

		set("arc:the-exchange-of-winnings");
		expect(session.engine.personById(npcId(CHAPEL, 0))?.name).toBe("the Green Knight");
		expect(state().flags["arc:the-exchange-of-winnings"]).toBe(true);
		session.dispose();
	});

	it("sends the player back to the lord if they ride out before the reckoning", () => {
		/*
		 * He is on stage from the moment the covenant is sworn, which is two days before
		 * the beat he anchors can open — so a player who rides straight north gets the
		 * whole finale delivered at them and nothing happens, with nothing on screen to
		 * say why. The opening that turns them round is the difference between a story
		 * that waits for you and one that appears to be broken.
		 */
		const tree = artifact.trees?.[npcId(CHAPEL, 0)];
		expect(tree?.entry[0]).toBe("not-yet");
		// In front of `revisit` as well: `openingNode` consults the revisit list first on
		// every meeting after the first, and a plain revisit node requires nothing.
		expect(tree?.revisit?.[0]).toBe("not-yet");

		const gate = tree?.nodes["not-yet"]?.requires;
		expect(gate).toEqual({
			all: [{ not: { flag: "arc:yield-the-girdle" } }, { not: { flag: "arc:keep-the-girdle" } }],
		});

		// And it goes away the moment either arm is taken, or it would shadow the finale.
		for (const arm of ["arc:yield-the-girdle", "arc:keep-the-girdle"]) {
			const { session, state, set } = start();
			set(arm);
			expect(evaluate(gate as Condition, state())).toBe(false);
			session.dispose();
		}
	});
});

describe("the girdle, and what is done with it", () => {
	/** Everything up to the moment the lord asks what you have won under his roof. */
	function atTheFork() {
		const started = start();
		started.goTo(-12, -122);
		started.session.engine.getChunks().prefetch({ cx: -1, cy: -2 }, 3);

		const arc = started.state().arc;
		if (!arc) throw new Error("the shipped scenario has no arc");
		for (const beat of orderedBeats(arc)) {
			if (beat.branch !== undefined || beat.optional) continue;
			if (beat.id === "the-green-chapel" || beat.id === "the-road-home") continue;
			started.session.engine.dispatch({ t: "ApplyEffects", effects: beatEffects(beat) });
		}
		while (started.state().card) started.session.engine.dispatch({ t: "DismissCard" });
		return started;
	}

	it("is a real choice: neither arm is taken until the player says so", () => {
		const { state, session } = atTheFork();
		expect(state().flags[branchKey("the-girdle")]).toBeUndefined();
		session.dispose();
	});

	it("takes the girdle back when it is handed over, and leaves it when it is not", () => {
		for (const [flag, kept] of [
			["gawain:yielded", false],
			["gawain:kept", true],
		] as const) {
			const { session, state, set } = atTheFork();
			session.engine.dispatch({
				t: "ApplyEffects",
				effects: [
					{
						t: "GrantItem",
						name: "Green Girdle",
						description: "Green silk, hemmed in gold.",
						quantity: 1,
					},
				],
			});
			set(flag);
			expect(state().inventory.some((item) => item.name === "Green Girdle")).toBe(kept);
			session.dispose();
		}
	});

	it("rejoins: the chapel opens on either arm, and the story can finish on both", () => {
		// The failure this exists for is silent and total. Gate the beat after a fork on
		// one arm's flag and the other arm dead-ends; gate it on the beat before the fork
		// and the fork can be skipped, so `remaining` never reaches zero. `{ any: [...] }`
		// is the only spelling that survives both, and until recently the validator was
		// the thing refusing it.
		for (const arm of ["yield-the-girdle", "keep-the-girdle"] as const) {
			const { session, state } = atTheFork();
			// Through `beatEffects`, not by setting the flag: opening an arm also records
			// `arc:branch:<group>`, and that is what bars the sibling and takes it out of
			// the main-line count. Setting only the flag leaves the other arm open forever,
			// which is the state this test would otherwise fail to distinguish from success.
			for (const id of [arm, "the-green-chapel", "the-road-home"]) {
				const beat = (state().arc?.beats ?? []).find((candidate) => candidate.id === id);
				if (beat) session.engine.dispatch({ t: "ApplyEffects", effects: beatEffects(beat) });
			}
			while (state().card) session.engine.dispatch({ t: "DismissCard" });
			session.engine.dispatch({
				t: "ApplyEffects",
				effects: state()
					.quests.filter((quest) => !quest.completed)
					.map((quest) => ({ t: "CompleteQuest" as const, id: quest.id })),
			});
			const outline = arcOutline(state().arc, state());
			expect(outline?.remaining, `${arm} left the story unfinished`).toBe(0);
			session.dispose();
		}
	});

	it("ends differently depending on what was handed over", () => {
		const outcomes: Record<string, string | undefined> = {};
		for (const flag of ["gawain:yielded", "gawain:kept"]) {
			const { session, state, set } = atTheFork();
			set(flag);
			const arc = state().arc;
			outcomes[flag] = arc ? pickEnding(arc, state())?.id : undefined;
			session.dispose();
		}
		expect(outcomes["gawain:yielded"]).toBe("the-clean-blow");
		expect(outcomes["gawain:kept"]).toBe("the-nick-in-the-neck");
	});

	it("says a different thing at the mound, too, and not only on the last card", () => {
		/*
		 * The ending card was already right on both arms. The scene before it was not:
		 * every route through the Green Knight's tree ran into one speech written for the
		 * man who kept the girdle back — "you loved your life a little", "Failed!" — so a
		 * player who handed it over was told to his face that he had failed the third
		 * test, and then read a card congratulating him. The card is the epilogue; this is
		 * the scene, and the scene is what the player is actually in.
		 */
		const tree = artifact.trees?.[npcId(CHAPEL, 0)];
		if (!tree) throw new Error("the Green Knight has no tree");

		// Every way to ask for the blow is offered on exactly one arm, and both arms are
		// offered everywhere it is asked for.
		const blows = Object.values(tree.nodes).flatMap((node) =>
			node.choices.filter((choice) => choice.goto === "strike" || choice.goto === "strike-clean"),
		);
		expect(blows.length).toBeGreaterThan(0);
		for (const choice of blows) {
			expect(choice.requires, `"${choice.text}" is offered on both arms`).toEqual({
				flag: choice.goto === "strike-clean" ? "girdle:given" : "girdle:hidden",
			});
		}

		// And the arm that gave it up is never told it failed.
		const clean = ["strike-clean", "morgan-clean", "verdict-clean"]
			.map((id) => tree.nodes[id]?.speech ?? "")
			.join(" ");
		expect(clean).not.toMatch(/fail/i);
		expect(clean.length).toBeGreaterThan(0);
	});

	it("and Arthur greets the man who came home clean as a different man", () => {
		// The homecoming was written once, for the knight with a scar and a green rag to
		// confess. Told to somebody who handed the girdle over and has neither, it read as
		// a second accusation — from the king, in his own hall, on the last page.
		const tree = artifact.trees?.[npcId(CAMELOT, 0)];
		if (!tree) throw new Error("Arthur has no tree");

		// A world of its own each time: sessions share a save file by world id, and with
		// the debounce off the second `start()` would load the first one's flags.
		const opening = (label: string, flags: Record<string, boolean>) => {
			const { session, state, set } = start(`arthur-${label}`);
			for (const [key, value] of Object.entries(flags)) if (value) set(key);
			const record = { id: npcId(CAMELOT, 0), totalTurns: 0 } as never;
			const node = openingNode(tree, state(), record);
			session.dispose();
			return node?.id;
		};

		expect(opening("clean", { "arc:the-green-chapel": true, "girdle:given": true })).toBe(
			"returned-clean",
		);
		expect(opening("kept", { "arc:the-green-chapel": true, "girdle:hidden": true })).toBe(
			"returned",
		);
		// And before the mound, neither: he is still sending the player north.
		expect(opening("fresh", {})).toBe("hall");
	});

	it("marks the souvenirs it tells the player to go back for", () => {
		// "Take it afterwards if you have the legs for it" is a promise, and an unmarked
		// tile two storeys down a three-level cave is not a place anybody finds by luck.
		const promised = ["the-whetstone", "the-holly-bob"];
		for (const id of promised) {
			const entry = artifact.placements?.find((placement) => placement.id === id);
			expect(entry?.showDecor, `${id} is invisible`).toBe(true);
		}
	});
});

describe("the errands", () => {
	it("hangs the lady's gift under the covenant as a step of it", () => {
		const beats = artifact.arc?.beats ?? [];
		const parent = beats.find((beat) => beat.id === "the-exchange-of-winnings");
		const child = beats.find((beat) => beat.id === "the-ladys-gift");
		expect(child?.quest?.parentId).toBe("the-exchange-of-winnings");
		expect(parent?.quest?.objectives).toEqual([
			{ kind: "quest", target: "the-ladys-gift", done: false },
		]);
	});

	it("leaves the ferryman's errand out of whether the story is told", () => {
		const aside = (artifact.arc?.beats ?? []).find((beat) => beat.id === "the-ferrymans-iron");
		expect(aside?.optional).toBe(true);
		expect(aside?.siteId).toBe(FERRY);
	});
});
