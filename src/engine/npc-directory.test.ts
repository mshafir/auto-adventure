import { describe, expect, it } from "vitest";
import { fallbackSite } from "../ai/director/fallback.js";
import { hashString } from "../core/rand/hash.js";
import { type Condition, evaluate } from "../core/rules/condition.js";
import { createInitialState } from "../core/rules/state.js";
import { siteContext } from "../core/world/context.js";
import { CHUNK } from "../core/world/coords.js";
import { type MacroSite, macroSite, sitesAround } from "../core/world/macro.js";
import { type WorldSeed, worldSeed } from "../core/world/recipe.js";
import { type NpcSpec, npcId, type SiteSpec } from "../core/world/spec.js";
import { ChunkManager } from "./chunk-manager.js";
import { GameEngine } from "./engine.js";
import { NpcDirectory } from "./npc-directory.js";
import { createWorldView } from "./world-view.js";

const SEED = hashString("npc-test");
const WORLD = worldSeed(SEED);

function findTown(world: WorldSeed): MacroSite {
	for (let radius = 0; radius < 16; radius++) {
		for (let my = -radius; my <= radius; my++) {
			for (let mx = -radius; mx <= radius; mx++) {
				const site = macroSite(world, mx, my);
				if (site.kind === "town" || site.kind === "village") return site;
			}
		}
	}
	throw new Error("no town found");
}

function populated(world: WorldSeed, site: MacroSite) {
	const spec: SiteSpec = fallbackSite(world.seed, site, siteContext(world, site));
	const chunks = new ChunkManager({
		world,
		specFor: (s) => (s.id === site.id ? spec.settlement : undefined),
	});
	// Build the whole settlement, which may straddle several chunks.
	const reach = Math.ceil(site.radius / CHUNK) + 1;
	chunks.prefetch({ cx: site.mx, cy: site.my }, reach);

	const npcs = new NpcDirectory(chunks, (id) => (id === site.id ? spec : undefined));
	npcs.populate([site]);
	return { chunks, npcs, spec };
}

describe("npc placement", () => {
	it("puts everyone in the spec somewhere in the town", () => {
		const site = findTown(WORLD);
		const { npcs, spec } = populated(WORLD, site);
		expect(spec.npcs.length).toBeGreaterThan(0);
		expect(npcs.all().length).toBe(spec.npcs.length);
	});

	it("places them on ground the player can actually reach", () => {
		// An NPC inside a wall cannot be talked to and cannot be seen; this is the
		// whole reason placement binds to generator-emitted anchors rather than to
		// a position the model was allowed to invent.
		const site = findTown(WORLD);
		const { chunks, npcs } = populated(WORLD, site);
		const view = createWorldView({ seed: SEED, chunkAt: (cx, cy) => chunks.get(cx, cy) });
		for (const npc of npcs.all()) {
			expect(view.isPassable(npc.x, npc.y), `${npc.name} stands in a wall`).toBe(true);
		}
	});

	it("never stands anybody in the only way into a building", () => {
		/*
		 * The failure this exists for has now shipped three times, wearing a different
		 * face each time: a porter in a castle arch, a green knight on the single step
		 * into a cave, and — the one this rule was originally written for — a shopkeeper
		 * on their own doorstep, in a village where that made every door unusable.
		 *
		 * It is invisible from inside the game. Walking into a person is how you talk to
		 * them, so a person on the sole approach to a door is somebody you talk to
		 * *instead of* going in, and nothing reports a problem because nothing has gone
		 * wrong from the engine's point of view. The player concludes the door is broken.
		 *
		 * The old guard named the dangerous anchor kinds. That works exactly as long as
		 * every generator agrees which names are dangerous, and twice they did not — the
		 * castle called its choke point `gate` and the cave called its step `square`. The
		 * rule is geometric now, so an anchor kind nobody has invented yet is covered.
		 */
		const site = findTown(WORLD);
		const { chunks, npcs } = populated(WORLD, site);
		const view = createWorldView({ seed: SEED, chunkAt: (cx, cy) => chunks.get(cx, cy) });
		const standing = new Set(npcs.all().map((npc) => `${npc.x},${npc.y}`));

		const reach = Math.ceil(site.radius / CHUNK) + 1;
		let doors = 0;
		for (let dy = -reach; dy <= reach; dy++) {
			for (let dx = -reach; dx <= reach; dx++) {
				for (const building of chunks.buildingsIn(site.mx + dx, site.my + dy)) {
					const { x, y } = building.door;
					expect(standing.has(`${x},${y}`), `somebody is in the ${building.kind} doorway`).toBe(
						false,
					);
					const ways = [
						{ x: x + 1, y },
						{ x: x - 1, y },
						{ x, y: y + 1 },
						{ x, y: y - 1 },
					].filter((way) => view.isPassable(way.x, way.y));
					if (ways.length === 0) continue;
					doors++;
					expect(
						ways.some((way) => !standing.has(`${way.x},${way.y}`)),
						`the ${building.kind} at ${x},${y} has ${ways.length} way(s) in and somebody on every one`,
					).toBe(true);
				}
			}
		}
		// The assertion above is vacuous if the town built nothing.
		expect(doors).toBeGreaterThan(0);
	});

	it("keeps a way in even with a crowd big enough to take every anchor", () => {
		// Every place kind, and enough people to fill the site. A roster of five leaves
		// most anchors empty, so a town passing the test above says less than it looks —
		// this is the version that would have caught the castle and the cave, because it
		// puts somebody on every anchor the generator emitted and then asks whether the
		// doors still work.
		for (const kind of ["town", "village", "fort", "castle", "docks", "cave"] as const) {
			const at = { x: 320, y: 320 };
			const world = worldSeed(SEED, { places: [{ at, kind, importance: 4 }] });
			const site = macroSite(world, Math.floor(at.x / CHUNK), Math.floor(at.y / CHUNK));
			const base: SiteSpec = fallbackSite(world.seed, site, siteContext(world, site));
			const crowd: SiteSpec = {
				...base,
				npcs: Array.from({ length: 40 }, (_, slot) => ({
					...(base.npcs[0] ?? {
						name: "somebody",
						role: "resident",
						glyph: "R",
						appearance: "",
						persona: "",
						disposition: 0,
						placement: "square" as const,
						knows: [],
					}),
					slot,
					name: `person ${slot}`,
				})),
			};

			const chunks = new ChunkManager({
				world,
				specFor: (s) => (s.id === site.id ? crowd.settlement : undefined),
			});
			const reach = Math.ceil(site.radius / CHUNK) + 1;
			chunks.prefetch({ cx: site.mx, cy: site.my }, reach);
			const npcs = new NpcDirectory(chunks, (id) => (id === site.id ? crowd : undefined));
			npcs.populate([site]);

			const view = createWorldView({ seed: SEED, chunkAt: (cx, cy) => chunks.get(cx, cy) });
			// Every tile anybody occupies at *any* hour: a schedule that moves the
			// blacksmith onto the only step at dusk seals the door just as completely as
			// standing there all day would.
			const standing = new Set(
				npcs
					.all()
					.flatMap((npc) => Object.values(npc.stations))
					.filter(Boolean)
					.map((station) => `${station.x},${station.y}`),
			);

			for (let dy = -reach; dy <= reach; dy++) {
				for (let dx = -reach; dx <= reach; dx++) {
					for (const building of chunks.buildingsIn(site.mx + dx, site.my + dy)) {
						const { x, y } = building.door;
						const ways = [
							{ x: x + 1, y },
							{ x: x - 1, y },
							{ x, y: y + 1 },
							{ x, y: y - 1 },
						].filter((way) => view.isPassable(way.x, way.y));
						if (ways.length === 0) continue;
						expect(
							ways.some((way) => !standing.has(`${way.x},${way.y}`)),
							`${kind}: the ${building.kind} at ${x},${y} is sealed by its own townsfolk`,
						).toBe(true);
					}
				}
			}
		}
	});

	it("never stacks two people on one tile", () => {
		const site = findTown(WORLD);
		const { npcs } = populated(WORLD, site);
		const spots = new Set(npcs.all().map((npc) => `${npc.x},${npc.y}`));
		expect(spots.size).toBe(npcs.all().length);
	});

	it("gives stable ids across a rebuild", () => {
		const site = findTown(WORLD);
		const before = populated(WORLD, site)
			.npcs.all()
			.map((npc) => npc.id);
		const after = populated(WORLD, site)
			.npcs.all()
			.map((npc) => npc.id);
		expect(after).toEqual(before);
	});

	it("finds an NPC by position and forgets them with their site", () => {
		const site = findTown(WORLD);
		const { npcs } = populated(WORLD, site);
		const someone = npcs.all()[0];
		expect(someone).toBeDefined();
		if (!someone) return;
		expect(npcs.at(someone.x, someone.y)?.id).toBe(someone.id);
		npcs.forget(site.id);
		expect(npcs.at(someone.x, someone.y)).toBeUndefined();
		expect(npcs.all()).toEqual([]);
	});
});

describe("a town placed before its ground exists", () => {
	/**
	 * The failure this guards against left a fully authored town deserted.
	 *
	 * `populate` runs for every site in the macro halo, which reaches far past the
	 * chunks that have been built — and in a prebuilt scenario every spec exists from
	 * the first frame, so distant towns were placed against chunks containing nothing.
	 * That empty roster was then cached as an answer and never revisited, because
	 * `populate` skipped any site it had already seen. Nothing reported it: you walked
	 * into the town the story hangs on and there was simply no one there.
	 */
	function unbuilt(world: WorldSeed, site: MacroSite) {
		const spec: SiteSpec = fallbackSite(world.seed, site, siteContext(world, site));
		const chunks = new ChunkManager({
			world,
			specFor: (s) => (s.id === site.id ? spec.settlement : undefined),
		});
		const npcs = new NpcDirectory(chunks, (id) => (id === site.id ? spec : undefined));
		return { chunks, npcs, spec };
	}

	it("places nobody while the ground is missing", () => {
		const site = findTown(WORLD);
		const { npcs } = unbuilt(WORLD, site);
		npcs.populate([site]);
		expect(npcs.atSite(site.id)).toEqual([]);
	});

	it("fills the town in once its chunks are built", () => {
		const site = findTown(WORLD);
		const { chunks, npcs, spec } = unbuilt(WORLD, site);
		npcs.populate([site]);

		chunks.prefetch({ cx: site.mx, cy: site.my }, Math.ceil(site.radius / CHUNK) + 1);
		npcs.populate([site]);
		expect(npcs.atSite(site.id).length).toBe(spec.npcs.length);
	});

	it("leaves a settled roster alone when its edges are evicted", () => {
		// The other half of the same problem: re-deriving on every chunk change would
		// move people who are already standing where they belong, because a placement
		// made from a partly evicted footprint sees fewer anchors than the real one.
		const site = findTown(WORLD);
		const { chunks, npcs } = populated(WORLD, site);
		const before = npcs.all().map((npc) => `${npc.id}@${npc.x},${npc.y}`);
		expect(before.length).toBeGreaterThan(0);

		chunks.invalidateRect({
			x: site.site.x + site.radius,
			y: site.site.y + site.radius,
			w: CHUNK,
			h: CHUNK,
		});
		npcs.populate([site]);
		expect(npcs.all().map((npc) => `${npc.id}@${npc.x},${npc.y}`)).toEqual(before);
	});
});

describe("bumping into people", () => {
	it("opens a conversation instead of walking through them", () => {
		const site = findTown(WORLD);
		const spec = fallbackSite(SEED, site, siteContext(WORLD, site));
		const state = createInitialState(
			{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
			site.site,
		);
		const engine = new GameEngine(state, {
			runEffect: () => undefined,
			specFor: (s) => (s.id === site.id ? spec.settlement : undefined),
			siteSpec: (id) => (id === site.id ? spec : undefined),
		});
		engine.getChunks().prefetch({ cx: site.mx, cy: site.my }, 2);
		engine.populateNpcs({ cx: site.mx, cy: site.my });

		const target = engine.getNpcs().all()[0];
		expect(target, "no one was placed in this town").toBeDefined();
		if (!target) return;

		// Stand beside them and walk in. The first press only turns.
		engine.dispatch({
			t: "ApplyEffects",
			effects: [{ t: "Teleport", x: target.x - 1, y: target.y }],
		});
		engine.dispatch({ t: "Move", facing: "right" });
		engine.dispatch({ t: "Move", facing: "right" });

		expect(engine.getState().dialogue?.npcId).toBe(target.id);
		// And the player did not move onto their tile.
		expect(engine.getState().player.x).toBe(target.x - 1);
	});
});

describe("schedules", () => {
	it("sends people home at night and back to work in the morning", () => {
		// This used to assert that *fewer* people were present at night, which is how
		// the bug got in: a station left absent does not put somebody indoors, it
		// removes them from the world. Everyone is still somewhere at two in the
		// morning — just not where they stand at noon.
		const site = findTown(WORLD);
		const { npcs } = populated(WORLD, site);

		npcs.setHour(11);
		const byDay = npcs.all().length;
		const dayPlaces = npcs
			.all()
			.map((n) => `${n.x},${n.y}`)
			.sort()
			.join("|");
		expect(byDay).toBeGreaterThan(0);

		npcs.setHour(2);
		expect(npcs.all().length).toBe(byDay);

		npcs.setHour(11);
		expect(npcs.all().length).toBe(byDay);
		expect(
			npcs
				.all()
				.map((n) => `${n.x},${n.y}`)
				.sort()
				.join("|"),
		).toBe(dayPlaces);
	});

	it("still resolves an NPC by id while they are indoors", () => {
		// A conversation must survive the hour ticking over mid-sentence.
		const site = findTown(WORLD);
		const { npcs } = populated(WORLD, site);
		npcs.setHour(11);
		const someone = npcs.all()[0];
		expect(someone).toBeDefined();
		if (!someone) return;

		npcs.setHour(2);
		expect(npcs.byNpcId(someone.id)?.name).toBe(someone.name);
	});

	it("bumps its revision when the day moves on, so the map repaints", () => {
		const site = findTown(WORLD);
		const { npcs } = populated(WORLD, site);
		npcs.setHour(11);
		const before = npcs.revision;
		npcs.setHour(21);
		expect(npcs.revision).toBeGreaterThan(before);
		// Within the same bucket nothing changes and nothing repaints.
		const settled = npcs.revision;
		npcs.setHour(22);
		expect(npcs.revision).toBe(settled);
	});
});

describe("towns whose halos overlap", () => {
	/** Every settlement in a block, each with its own fallback spec. */
	function populatedRegion(world: WorldSeed, cc: { cx: number; cy: number }) {
		const sites = sitesAround(world, cc.cx, cc.cy);
		const specs = new Map<number, SiteSpec>();
		for (const site of sites)
			specs.set(site.id, fallbackSite(world.seed, site, siteContext(world, site)));

		const chunks = new ChunkManager({
			world,
			capacity: 64,
			specFor: (s) => specs.get(s.id)?.settlement,
		});
		chunks.prefetch(cc, 2);
		const npcs = new NpcDirectory(chunks, (id) => specs.get(id));
		npcs.populate(sites);
		npcs.setHour(11);
		return { sites, npcs };
	}

	it("keeps everyone inside their own settlement", () => {
		// The search for a site's anchors runs in whole-chunk steps, so it reaches
		// past a small town into its neighbours. Without a bounds filter a
		// village's blacksmith takes up station on another village's doorstep.
		const { sites, npcs } = populatedRegion(WORLD, { cx: 0, cy: 0 });
		const byId = new Map(sites.map((site) => [site.id, site]));

		for (const npc of npcs.all()) {
			const home = byId.get(npc.siteId);
			expect(home, `${npc.name} belongs to no known site`).toBeDefined();
			if (!home) continue;
			const distance = Math.hypot(npc.x - home.site.x, npc.y - home.site.y);
			expect(
				distance,
				`${npc.name} is ${Math.round(distance)} tiles from ${home.kind}`,
			).toBeLessThanOrEqual(home.radius + 2);
		}
	});

	it("never puts two people on the same tile across sites", () => {
		const { npcs } = populatedRegion(WORLD, { cx: 0, cy: 0 });
		const spots = npcs.all().map((npc) => `${npc.x},${npc.y}`);
		expect(new Set(spots).size).toBe(spots.length);
	});
});

describe("a town is never empty", () => {
	/**
	 * Reported from play: arrived somewhere to hand over a delivery and there was
	 * nobody there to hand it to.
	 *
	 * Only nocturnal roles were given a `night` station and only nocturnal or early
	 * ones a `dawn`, so for eight hours in every twenty-four almost every station
	 * was absent, `reindex` skipped almost everybody, and the town held nobody at
	 * all. They were not indoors either — placement is in world coordinates and an
	 * interior is its own space — so any errand needing a person could not be
	 * progressed for a third of the clock, with nothing to suggest waiting.
	 */
	it("has somebody findable at every hour of the day", () => {
		const site = findTown(WORLD);
		const { npcs } = populated(WORLD, site);
		const roster = npcs.atSite(site.id).length;
		expect(roster).toBeGreaterThan(0);

		for (let hour = 0; hour < 24; hour++) {
			npcs.setHour(hour);
			expect(npcs.all().length, `nobody is anywhere at ${String(hour).padStart(2, "0")}:00`).toBe(
				roster,
			);
		}
	});

	it("still moves people about, so the day has a shape somewhere", () => {
		// The cheap way to satisfy the test above is to pin everyone to one tile for
		// the whole day, so at least one town has to actually vary. Searched across
		// seeds rather than asserted on one, because the evening move is to a bench,
		// stall or well and a small town may have none — in which case there is
		// genuinely nowhere else for its two residents to be.
		const moves = ["hollowmoor", "vale", "default", "harrow", "moss", "ember"].filter((name) => {
			const world = worldSeed(hashString(name));
			const { npcs } = populated(world, findTown(world));
			const seen = new Set<string>();
			for (let hour = 0; hour < 24; hour++) {
				npcs.setHour(hour);
				seen.add(
					npcs
						.all()
						.map((npc) => `${npc.x},${npc.y}`)
						.sort()
						.join("|"),
				);
			}
			return seen.size > 1;
		});
		expect(moves.length, "no town anywhere changes through the day").toBeGreaterThan(0);
	}, 30_000);
});

describe("standing outside a building", () => {
	/**
	 * Found while recording a demo of the game.
	 *
	 * A door's other three neighbours are its own wall, so the doorstep is the only
	 * tile it can be entered from — and walking into somebody talks to them rather
	 * than displacing them. Placement preferred exactly that tile, so in the
	 * measured village every one of the four doors had its own owner standing in
	 * it and not a single building could be entered at any hour of the day.
	 *
	 * It survived because it looks completely reasonable: a shopkeeper waiting
	 * outside their shop. Seed 23 is kept because towns have squares and stalls to
	 * absorb people, and it takes a village with nothing but doorsteps to show it.
	 */
	const STEPS = [
		[0, -1],
		[0, 1],
		[-1, 0],
		[1, 0],
	] as const;

	/** The one tile a door can be approached from, when there is only one. */
	function soleApproach(
		view: ReturnType<typeof createWorldView>,
		door: { x: number; y: number },
	): { x: number; y: number } | undefined {
		const open = STEPS.filter(([dx, dy]) => view.isPassable(door.x + dx, door.y + dy)).map(
			([dx, dy]) => ({ x: door.x + dx, y: door.y + dy }),
		);
		return open.length === 1 ? open[0] : undefined;
	}

	function village(world: WorldSeed) {
		const site = findTown(world);
		const { chunks, npcs } = populated(world, site);
		const view = createWorldView({ seed: world.seed, chunkAt: (cx, cy) => chunks.get(cx, cy) });
		const reach = Math.ceil(site.radius / CHUNK) + 1;
		const buildings = [];
		for (let dy = -reach; dy <= reach; dy++) {
			for (let dx = -reach; dx <= reach; dx++) {
				buildings.push(...chunks.buildingsIn(site.mx + dx, site.my + dy));
			}
		}
		return { site, npcs, view, buildings };
	}

	it("never stands in the only doorway a building has", () => {
		for (const seed of [23, 65, hashString("npc-test"), hashString("vale")]) {
			const { npcs, view, buildings } = village(worldSeed(seed));
			expect(buildings.length, `seed ${seed} has no buildings`).toBeGreaterThan(0);

			for (let hour = 0; hour < 24; hour += 2) {
				npcs.setHour(hour);
				const standing = new Set(npcs.all().map((npc) => `${npc.x},${npc.y}`));
				for (const building of buildings) {
					const step = soleApproach(view, building.door);
					if (!step) continue;
					expect(
						standing.has(`${step.x},${step.y}`),
						`seed ${seed}: the only way into a ${building.kind} is blocked at ${String(hour).padStart(2, "0")}:00`,
					).toBe(false);
				}
			}
		}
	}, 60_000);

	it("still puts people where their building is", () => {
		// The cheap way to satisfy the above is to move everybody to the square, at
		// which point a village is a crowd standing in a field.
		const { npcs, buildings } = village(worldSeed(23));
		npcs.setHour(11);
		const near = npcs
			.all()
			.filter((npc) =>
				buildings.some((b) => Math.abs(b.door.x - npc.x) + Math.abs(b.door.y - npc.y) <= 3),
			);
		expect(near.length, "nobody stands near any building").toBeGreaterThan(0);
	}, 30_000);
});

describe("people the story has not brought on yet", () => {
	/** The same town, with one resident gated behind a flag. */
	function gated(condition: Condition) {
		const site = findTown(WORLD);
		const spec: SiteSpec = fallbackSite(SEED, site, siteContext(WORLD, site));
		const hidden = spec.npcs[0] as NpcSpec;
		const withGate: SiteSpec = {
			...spec,
			npcs: spec.npcs.map((npc, i) => (i === 0 ? { ...npc, requires: condition } : npc)),
		};

		const chunks = new ChunkManager({
			world: WORLD,
			specFor: (s) => (s.id === site.id ? withGate.settlement : undefined),
		});
		chunks.prefetch({ cx: site.mx, cy: site.my }, Math.ceil(site.radius / CHUNK) + 1);
		const npcs = new NpcDirectory(chunks, (id) => (id === site.id ? withGate : undefined));
		npcs.populate([site]);
		return { npcs, site, hidden, id: npcId(site.id, hidden.slot), total: spec.npcs.length };
	}

	it("shows everybody when nothing has been gated", () => {
		// The default has to be "present", because every procedural and live world
		// leaves `requires` absent for everyone.
		const { npcs, total } = gated({ flag: "courier:arrived" });
		expect(npcs.all().length).toBe(total);
	});

	it("leaves out somebody whose condition is unmet", () => {
		const { npcs, total, id } = gated({ flag: "courier:arrived" });
		npcs.setGate((npc) => evaluate(npc.requires, blank()));
		expect(npcs.all().length).toBe(total - 1);
		expect(npcs.all().some((npc) => npc.id === id)).toBe(false);
	});

	it("cannot be walked into or talked to while absent", () => {
		// The failure this exists to prevent: somebody invisible who still answers
		// when you press SPACE at the tile they would have been standing on.
		const { npcs, hidden, id, site } = gated({ flag: "courier:arrived" });
		const station = npcs.all().find((npc) => npc.id === id);
		expect(station, `slot ${hidden.slot} of site ${site.id} was not placed`).toBeDefined();
		const { x, y } = station as { x: number; y: number };

		npcs.setGate((npc) => evaluate(npc.requires, blank()));
		expect(npcs.at(x, y)).toBeUndefined();
		expect(npcs.byNpcId(id)).toBeUndefined();
		// And they are not offered to the dialogue layer as somebody who is here.
		expect(npcs.atSite(site.id).some((npc) => npc.id === id)).toBe(false);
	});

	it("brings them on the moment the condition flips", () => {
		const { npcs, total, id } = gated({ flag: "courier:arrived" });
		npcs.setGate((npc) => evaluate(npc.requires, blank()));
		const before = npcs.revision;

		npcs.setGate((npc) => evaluate(npc.requires, blank({ "courier:arrived": true })));
		expect(npcs.all().length).toBe(total);
		expect(npcs.byNpcId(id)).toBeDefined();
		// The render layer memoises on the revision, so it has to move or the frame
		// keeps the old entity index and they stay invisible.
		expect(npcs.revision).toBeGreaterThan(before);
	});

	it("does not churn the revision when the answer has not changed", () => {
		// Re-asked after every command that touches flags, inventory or quests, which
		// is often; a bump per ask would rebuild the entity index on every step.
		const { npcs } = gated({ flag: "courier:arrived" });
		npcs.setGate((npc) => evaluate(npc.requires, blank()));
		const settled = npcs.revision;
		npcs.recheckGate();
		npcs.recheckGate();
		expect(npcs.revision).toBe(settled);
	});

	it("keeps their station reserved while they are away", () => {
		// Skipped at index time rather than at placement time, so nobody else is
		// shuffled onto the doorstep a returning character belongs on.
		const { npcs, id } = gated({ flag: "courier:arrived" });
		const before = npcs.all().find((npc) => npc.id === id);
		npcs.setGate((npc) => evaluate(npc.requires, blank()));
		npcs.setGate((npc) => evaluate(npc.requires, blank({ "courier:arrived": true })));
		const after = npcs.all().find((npc) => npc.id === id);
		expect({ x: after?.x, y: after?.y }).toEqual({ x: before?.x, y: before?.y });
	});
});

function blank(flags: Record<string, string | number | boolean> = {}) {
	const state = createInitialState(
		{ id: "t", name: "t", seed: SEED, createdAt: "" },
		{ x: 0, y: 0 },
	);
	return { ...state, flags };
}
