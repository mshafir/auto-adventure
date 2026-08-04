import { describe, expect, it } from "vitest";
import { fallbackSite } from "../ai/director/fallback.js";
import { hashString } from "../core/rand/hash.js";
import { createInitialState } from "../core/rules/state.js";
import { siteContext } from "../core/world/context.js";
import { CHUNK } from "../core/world/coords.js";
import { type MacroSite, macroSite, sitesAround } from "../core/world/macro.js";
import type { SiteSpec } from "../core/world/spec.js";
import { ChunkManager } from "./chunk-manager.js";
import { GameEngine } from "./engine.js";
import { NpcDirectory } from "./npc-directory.js";
import { createWorldView } from "./world-view.js";

const SEED = hashString("npc-test");

function findTown(seed: number): MacroSite {
	for (let radius = 0; radius < 16; radius++) {
		for (let my = -radius; my <= radius; my++) {
			for (let mx = -radius; mx <= radius; mx++) {
				const site = macroSite(seed, mx, my);
				if (site.kind === "town" || site.kind === "village") return site;
			}
		}
	}
	throw new Error("no town found");
}

function populated(seed: number, site: MacroSite) {
	const spec: SiteSpec = fallbackSite(seed, site, siteContext(seed, site));
	const chunks = new ChunkManager({
		seed,
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
		const site = findTown(SEED);
		const { npcs, spec } = populated(SEED, site);
		expect(spec.npcs.length).toBeGreaterThan(0);
		expect(npcs.all().length).toBe(spec.npcs.length);
	});

	it("places them on ground the player can actually reach", () => {
		// An NPC inside a wall cannot be talked to and cannot be seen; this is the
		// whole reason placement binds to generator-emitted anchors rather than to
		// a position the model was allowed to invent.
		const site = findTown(SEED);
		const { chunks, npcs } = populated(SEED, site);
		const view = createWorldView({ seed: SEED, chunkAt: (cx, cy) => chunks.get(cx, cy) });
		for (const npc of npcs.all()) {
			expect(view.isPassable(npc.x, npc.y), `${npc.name} stands in a wall`).toBe(true);
		}
	});

	it("never stacks two people on one tile", () => {
		const site = findTown(SEED);
		const { npcs } = populated(SEED, site);
		const spots = new Set(npcs.all().map((npc) => `${npc.x},${npc.y}`));
		expect(spots.size).toBe(npcs.all().length);
	});

	it("gives stable ids across a rebuild", () => {
		const site = findTown(SEED);
		const before = populated(SEED, site)
			.npcs.all()
			.map((npc) => npc.id);
		const after = populated(SEED, site)
			.npcs.all()
			.map((npc) => npc.id);
		expect(after).toEqual(before);
	});

	it("finds an NPC by position and forgets them with their site", () => {
		const site = findTown(SEED);
		const { npcs } = populated(SEED, site);
		const someone = npcs.all()[0];
		expect(someone).toBeDefined();
		if (!someone) return;
		expect(npcs.at(someone.x, someone.y)?.id).toBe(someone.id);
		npcs.forget(site.id);
		expect(npcs.at(someone.x, someone.y)).toBeUndefined();
		expect(npcs.all()).toEqual([]);
	});
});

describe("bumping into people", () => {
	it("opens a conversation instead of walking through them", () => {
		const site = findTown(SEED);
		const spec = fallbackSite(SEED, site, siteContext(SEED, site));
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
	it("sends most people indoors at night and brings them back in the morning", () => {
		const site = findTown(SEED);
		const { npcs } = populated(SEED, site);

		npcs.setHour(11);
		const byDay = npcs.all().length;
		expect(byDay).toBeGreaterThan(0);

		npcs.setHour(2);
		const atNight = npcs.all().length;
		expect(atNight).toBeLessThan(byDay);

		npcs.setHour(11);
		expect(npcs.all().length).toBe(byDay);
	});

	it("still resolves an NPC by id while they are indoors", () => {
		// A conversation must survive the hour ticking over mid-sentence.
		const site = findTown(SEED);
		const { npcs } = populated(SEED, site);
		npcs.setHour(11);
		const someone = npcs.all()[0];
		expect(someone).toBeDefined();
		if (!someone) return;

		npcs.setHour(2);
		expect(npcs.byNpcId(someone.id)?.name).toBe(someone.name);
	});

	it("bumps its revision when the day moves on, so the map repaints", () => {
		const site = findTown(SEED);
		const { npcs } = populated(SEED, site);
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
	function populatedRegion(seed: number, cc: { cx: number; cy: number }) {
		const sites = sitesAround(seed, cc.cx, cc.cy);
		const specs = new Map<number, SiteSpec>();
		for (const site of sites) specs.set(site.id, fallbackSite(seed, site, siteContext(seed, site)));

		const chunks = new ChunkManager({
			seed,
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
		const { sites, npcs } = populatedRegion(SEED, { cx: 0, cy: 0 });
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
		const { npcs } = populatedRegion(SEED, { cx: 0, cy: 0 });
		const spots = npcs.all().map((npc) => `${npc.x},${npc.y}`);
		expect(new Set(spots).size).toBe(spots.length);
	});
});
