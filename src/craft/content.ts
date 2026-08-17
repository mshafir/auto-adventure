import type { DialogueTree } from "../ai/dialogue/tree.js";
import { PLACEMENTS, STRUCTURE_KINDS } from "../ai/director/schemas.js";
import { authoredTiles } from "../core/gen/features/authored.js";
import type { AnchorKind, StructureKind } from "../core/gen/features/patch.js";
import type { AuthoredBarrier } from "../core/rules/lock.js";
import type { Placement } from "../core/rules/placement.js";
import type { Sign } from "../core/rules/signage.js";
import { elevationAt, elevationBand } from "../core/world/fields.js";
import { MACRO, macroSite, SETTLEMENT_KINDS } from "../core/world/macro.js";
import { type PlaceRecipe, type WorldRecipe, worldSeed } from "../core/world/recipe.js";
import { type NpcSpec, npcId, type SiteSpec } from "../core/world/spec.js";
import { resolvePlacements } from "../engine/placements.js";
import { artifactWorld, type ScenarioArtifact } from "../scenario/artifact.js";
import { describeReach, tilesBetween } from "../scenario/distance.js";
import { signpostsFor } from "../scenario/signposts.js";
import { buildsSomething, prospect } from "../scenario/survey.js";
import type { TerraformEdit } from "../scenario/terraform.js";
import { buildPassability, siteIndex } from "../scenario/validate.js";
import { type Args, CraftError } from "./args.js";
import { addTo, commit, filePath, idTaken, openWorkspace, phaseOf } from "./workspace.js";
import { requireId } from "./world.js";

/**
 * Commands about what is in the world: places, people, things, and the ground under them.
 *
 * Every one of these resolves what it is asked for *before* writing it. That is the whole
 * argument for the CLI existing rather than an agent editing JSON: a chest in a building
 * that does not exist is a call that fails here, with a sentence saying which buildings
 * there are, instead of an item that is nowhere and a quest that can never close.
 */

/**
 * Put a settlement somewhere, because nothing generated one.
 *
 * The world is land only, so every town in it is here because a story needed one. That is
 * the whole change: a village the seed scattered is a village with nobody in it and no
 * reason to exist, and a player who walks into one finds a place with a name, houses and
 * nothing to say. Founding writes two things at once — the recipe entry that makes the
 * generator build a settlement in that macro cell, and the spec that names it and says what
 * is in it — so the map and the story cannot come apart.
 *
 * Measured before it is written, and by laying the settlement out rather than by estimating:
 * the number of buildings that fit depends on the plots the footprint finds on that exact
 * ground, and a refusal here is a village that would have been half in a river.
 */
export function craftFound(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "found"));
	const artifact = workspace.artifact;
	const at = args.point("at");
	const kind = args.oneOf("kind", SETTLEMENT_KINDS, "village");
	const importance = args.int("importance", 3);
	const name = args.str("name");
	const short = args.str("short", name);
	const description = args.str("description");
	const walled = args.bool("walled");
	const hooks = args.list("hook");
	const structures = args.list("structure");
	args.refuseUnknown();

	const bounds = artifact.bounds;
	if (!bounds) throw new CraftError(`"${artifact.id}" has no bounds, so it has nowhere to put one`);
	if (importance < 1 || importance > 5) {
		throw new CraftError("--importance runs 1 to 5; it decides how big the place is");
	}

	// One place per macro cell, because a site's id is hashed from its cell: a second place
	// in the same cell would share the first one's id, and `macroSite` would only ever report
	// whichever came last.
	const cell = (point: { readonly x: number; readonly y: number }) =>
		`${Math.floor(point.x / MACRO)},${Math.floor(point.y / MACRO)}`;
	const sharing = (artifact.recipe?.places ?? []).find((place) => cell(place.at) === cell(at));
	if (sharing) {
		const world = artifactWorld(artifact);
		const mine = macroSite(world, Math.floor(at.x / MACRO), Math.floor(at.y / MACRO));
		const named = artifact.sites[String(mine.id)]?.name;
		throw new CraftError(
			`${at.x},${at.y} is in the same 64-tile cell as the ${sharing.kind} at ` +
				`${sharing.at.x},${sharing.at.y}${named ? ` ("${named}")` : ""}, and two places cannot ` +
				"share a cell. craft survey lists the cells that are free.",
		);
	}

	const asked = prospect(artifact.seed, artifact.recipe, bounds, { at, kind, importance });
	if ("refusal" in asked) throw new CraftError(asked.refusal);

	const siteId = asked.site.id;
	if (artifact.sites[String(siteId)]) {
		throw new CraftError(`site ${siteId} is already "${artifact.sites[String(siteId)]?.name}"`);
	}

	const budget = asked.budget;
	const parsed = structures.map((entry) => parseStructure(entry, budget));
	if (parsed.length > budget) {
		throw new CraftError(
			`a ${kind} on that ground holds ${budget} building(s) and ${parsed.length} were asked for. ` +
				"Raise --importance to make the place bigger, or found it somewhere with more room",
		);
	}

	const spec: SiteSpec = {
		siteId,
		name,
		shortName: short,
		description,
		settlement: { name, walled, structures: parsed },
		npcs: [],
		hooks,
	};
	workspace.artifact = {
		...artifact,
		recipe: withPlace(artifact.recipe, asked.place),
		sites: { ...artifact.sites, [String(siteId)]: spec },
	};
	commit(workspace, `founding "${name}"`);

	out(`founded "${name}" as site ${siteId} — a ${kind} at ${at.x},${at.y}, room for ${budget}`);
	if (parsed.length > 0) out(`  ${parsed.map((s) => s.name ?? s.kind).join(", ")}`);
	// How far it is from everything else, named rather than only counted. This is the number
	// the story turns on and the one that is hardest to see from coordinates: the first world
	// built this way put its two towns forty-seven tiles apart, which reads as one place.
	for (const other of artifact.recipe?.places ?? []) {
		const spec = Object.values(artifact.sites).find(
			(candidate) =>
				candidate.siteId ===
				macroSite(
					artifactWorld(artifact),
					Math.floor(other.at.x / MACRO),
					Math.floor(other.at.y / MACRO),
				).id,
		);
		out(`  ${describeReach(tilesBetween(at, other.at))} from ${spec?.name ?? other.kind}`);
	}
	out(`next: craft npc add ${artifact.id} --site ${siteId} --name "..." --role "..." --at square`);
}

/** The recipe with one more place in it. Appended: nothing already founded may be lost. */
function withPlace(recipe: WorldRecipe | undefined, place: PlaceRecipe): WorldRecipe {
	return { ...recipe, places: [...(recipe?.places ?? []), place] };
}

/** `kind:Name` or just `kind`, which is how a building is written on a command line. */
function parseStructure(
	entry: string,
	budget: number,
): SiteSpec["settlement"]["structures"][number] {
	const colon = entry.indexOf(":");
	const kind = (colon >= 0 ? entry.slice(0, colon) : entry).trim();
	const name = colon >= 0 ? entry.slice(colon + 1).trim() : undefined;
	if (!(STRUCTURE_KINDS as readonly string[]).includes(kind)) {
		throw new CraftError(
			`"${kind}" is not a kind of building. One of: ${STRUCTURE_KINDS.join(", ")}`,
		);
	}
	return {
		kind: kind as StructureKind,
		size: budget > 8 ? "medium" : "small",
		importance: name ? 4 : 1,
		...(name ? { name, required: true } : {}),
	};
}

export function craftNpcAdd(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "npc add"));
	const artifact = workspace.artifact;
	const siteId = args.int("site");
	const site = artifact.sites[String(siteId)];
	if (!site) {
		throw new CraftError(
			`site ${siteId} does not exist — nothing is built until it is founded. ` +
				`"craft survey ${artifact.id}" says where one can go`,
		);
	}

	const name = args.str("name");
	const role = args.str("role");
	const at = args.oneOf("at", PLACEMENTS as readonly AnchorKind[], "square");
	const inside = args.has("in") ? args.str("in") : undefined;
	const indoors = args.bool("indoors");
	const glyph = args.str("glyph", name.trim()[0]?.toUpperCase() ?? "P");
	const appearance = args.str("appearance", `${role} of ${site.name}.`);
	const persona = args.str("persona", `A ${role}, and talks like one.`);
	const disposition = args.int("disposition", 0);
	const knows = args.list("knows");
	const stays = args.bool("stays");
	const live = args.bool("live");
	const like = args.has("like") ? args.str("like") : undefined;
	args.refuseUnknown();

	if (!/^[A-Za-z]$/.test(glyph)) throw new CraftError(`--glyph wants one letter, not "${glyph}"`);
	if (inside && !site.settlement.structures.some((s) => (s.name ?? s.kind) === inside)) {
		throw new CraftError(
			`${site.name} has no building called "${inside}". It has: ${site.settlement.structures.map((s) => s.name ?? s.kind).join(", ") || "none yet"}`,
		);
	}
	if (indoors && !inside) throw new CraftError("--indoors wants --in to say which building");

	const slot = site.npcs.length;
	const id = npcId(siteId, slot);
	if (like && !artifact.trees?.[like]) {
		throw new CraftError(
			`--like wants somebody with a written conversation; "${like}" has none. Written so far: ${Object.keys(artifact.trees ?? {}).join(", ") || "nobody"}`,
		);
	}

	const spec: NpcSpec = {
		slot,
		name,
		role,
		glyph,
		appearance,
		persona,
		disposition,
		placement: at,
		knows,
		...(inside ? { structureName: inside } : {}),
		...(indoors ? { indoors: true } : {}),
		...(stays ? { stays: true } : {}),
		...(live ? { live: true } : {}),
		...(like ? { treeAlias: like } : {}),
	};

	workspace.artifact = {
		...artifact,
		sites: { ...artifact.sites, [String(siteId)]: { ...site, npcs: [...site.npcs, spec] } },
	};
	commit(workspace, `adding ${name} to ${site.name}`);

	out(`${name} is ${id}, at the ${at} of ${site.name}${inside ? ` (${inside})` : ""}`);
	if (like) out(`  speaks with ${like}'s words`);
	if (live) out("  may improvise, so the story must not hang on them");
	else if (!like) out(`next: craft tree ${artifact.id} --npc ${id} --init`);
}

/**
 * Scaffold a conversation for somebody to write into.
 *
 * The one command whose output is meant to be hand-edited afterwards. What it writes is a
 * valid tree with a way out, because a tree with no way out traps the panel open and a tree
 * with a dangling `goto` ends a conversation abruptly — both silent at runtime, both easy to
 * write by hand, and neither worth making an author rediscover.
 */
export function craftTree(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "tree"));
	const who = args.str("npc");
	args.bool("init");
	args.refuseUnknown();

	const known = new Set<string>();
	for (const site of Object.values(workspace.artifact.sites)) {
		for (const npc of site.npcs) known.add(npcId(site.siteId, npc.slot));
	}
	if (!known.has(who)) {
		throw new CraftError(
			`nobody in this world is "${who}". There is: ${[...known].join(", ") || "nobody yet"}`,
		);
	}
	if (workspace.artifact.trees?.[who])
		throw new CraftError(`${who} already has a written conversation`);

	const tree: DialogueTree = {
		npcId: who,
		entry: ["opening"],
		nodes: {
			opening: {
				id: "opening",
				speech: "Say something here.",
				choices: [{ text: "Goodbye.", goto: null }],
			},
		},
	};
	workspace.artifact = {
		...workspace.artifact,
		trees: { ...workspace.artifact.trees, [who]: tree },
	};
	commit(workspace, `writing a conversation for ${who}`);

	out(`wrote ${filePath(workspace, "trees", `${who}.json`)}`);
	out("  one node with a way out. Edit the prose directly; the shape is already valid.");
}

/**
 * What the player is carrying when the world opens.
 *
 * A hole in the format until now: a story that begins with a letter to deliver has to begin
 * with the letter, and the only alternative was the first conversation telling the player they
 * had been given something they could not find in their own pack.
 *
 * The first call replaces the default handful of coins rather than adding to it, so a world
 * can start somebody with nothing but the clothes they stand in — say `--item Gold` explicitly
 * if the coins are wanted alongside.
 */
export function craftCarry(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "carry"));
	const artifact = workspace.artifact;
	const name = args.str("item");
	const description = args.str("description");
	const quantity = args.int("quantity", 1);
	args.refuseUnknown();

	if (quantity < 1) throw new CraftError("--quantity is how many, so it starts at 1");
	const already = artifact.startsWith ?? [];
	if (already.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
		throw new CraftError(`the player already starts with "${name}"`);
	}

	const startsWith = [...already, { name, description, quantity }];
	workspace.artifact = { ...artifact, startsWith };
	commit(workspace, `starting with ${name}`);

	out(`the player starts carrying ${quantity} × ${name}`);
	if (already.length === 0) out("  which replaces the default handful of coins");
	out(
		`  the whole pack: ${startsWith.map((item) => `${item.quantity} × ${item.name}`).join(", ")}`,
	);
}

export function craftPlace(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "place"));
	const phase = phaseOf(workspace, args.has("phase") ? args.str("phase") : undefined);

	// Three things a scenario puts in a place, and they share a verb because to an author they
	// are one gesture: "there is something here".
	if (args.bool("sign")) {
		placeSign(workspace, args, phase, out);
		return;
	}
	if (args.bool("gate")) {
		placeGate(workspace, args, phase, out);
		return;
	}
	placeItem(workspace, args, phase, out);
}

type Phase = ReturnType<typeof phaseOf>;
type Workspace = ReturnType<typeof openWorkspace>;

function placeItem(
	workspace: Workspace,
	args: Args,
	phase: Phase,
	out: (line: string) => void,
): void {
	const artifact = workspace.artifact;
	const item = args.str("item");
	const description = args.str("description");
	const siteId = args.int("site");
	const inside = args.has("in") ? args.str("in") : undefined;
	const anchor = args.has("anchor")
		? args.oneOf("anchor", PLACEMENTS as readonly AnchorKind[])
		: undefined;
	const requires = args.has("requires") ? args.str("requires") : undefined;
	const show = args.bool("show");
	const quantity = args.int("quantity", 1);
	const id = args.str("id", slug(item));
	const emptyText = args.has("empty") ? args.str("empty") : undefined;
	args.refuseUnknown();

	if (idTaken(artifact, "placements", id))
		throw new CraftError(`there is already a placement called "${id}"`);
	if (!artifact.sites[String(siteId)])
		throw new CraftError(`site ${siteId} does not exist; nothing has been founded there`);

	const placement: Placement = {
		id,
		at: {
			kind: "site",
			siteId,
			...(inside ? { structure: inside } : {}),
			...(anchor ? { anchor } : {}),
		},
		item: { name: item, description, ...(quantity > 1 ? { quantity } : {}) },
		...(requires ? { requires: { flag: requires } } : {}),
		...(show ? { showDecor: true } : {}),
		...(emptyText ? { emptyText } : {}),
	};

	// Resolved before it is written, which is the point of this command existing. An item that
	// is nowhere is a `have` objective that can never be satisfied and nothing on screen to say
	// why — and it is invisible until somebody plays that far.
	const { resolved, unresolved } = resolvePlacements([placement], {
		world: artifactWorld(artifact),
		siteSpec: (id) => artifact.sites[String(id)],
		bounds: artifact.bounds,
	});
	const failed = unresolved[0];
	if (failed) throw new CraftError(`"${item}" cannot be placed: ${failed.reason}`);

	addTo(workspace, phase, "placements", placement);
	commit(workspace, `placing "${item}"`);

	const landed = resolved[0];
	out(
		`"${item}" is ${id}, in ${artifact.sites[String(siteId)]?.name}${inside ? `'s ${inside}` : ""}`,
	);
	if (landed)
		out(
			`  lands at ${landed.interiorId ? `interior ${landed.interiorId} ` : ""}${landed.x},${landed.y}`,
		);
	if (phase) out(`  from "${phase.name}" onward`);
}

function placeSign(
	workspace: Workspace,
	args: Args,
	phase: Phase,
	out: (line: string) => void,
): void {
	const artifact = workspace.artifact;
	const at = args.point("at");
	const arms = args.list("arm").map(Number);
	const note = args.has("note") ? args.str("note") : undefined;
	const id = args.str("id", `sign-${at.x}-${at.y}`);
	args.refuseUnknown();

	if (idTaken(artifact, "signs", id))
		throw new CraftError(`there is already a sign called "${id}"`);
	if (arms.length === 0) throw new CraftError("--arm wants at least one site id to point at");
	for (const arm of arms) {
		if (!artifact.sites[String(arm)]) {
			throw new CraftError(`a board cannot point at site ${arm}, which is not claimed`);
		}
	}

	const sign: Sign = {
		id,
		x: at.x,
		y: at.y,
		arms: arms.map((armSite) => ({ siteId: armSite })),
		...(note ? { note } : {}),
	};
	addTo(workspace, phase, "signs", sign);
	commit(workspace, `putting up ${id}`);

	out(`${id} stands at ${at.x},${at.y}`);
	out(`  points at ${arms.map((arm) => artifact.sites[String(arm)]?.name).join(", ")}`);
	out("  the bearing and the distance are worked out from where those places really are");
}

/**
 * Put a board on the road out of every town the story walks between.
 *
 * Free, and derived: the arc already knows which places the story sends the player to and in
 * what order, so nothing has to be written down twice. This is the command to reach for
 * rather than placing boards one at a time — an author who writes them by hand has to keep
 * them in step with the arc, and a board pointing somewhere the story no longer goes is
 * worse than no board.
 */
export function craftSignposts(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "signposts"));
	args.refuseUnknown();
	const artifact = workspace.artifact;
	if (!artifact.arc)
		throw new CraftError("this world has no story yet, so there is nowhere to point");

	const plan = signpostsFor(artifact, buildPassability(artifact), siteIndex(artifact));
	if (plan.signs.length === 0) {
		out("nothing to sign: the story does not walk between places yet");
		for (const missed of plan.missed) out(`  ${missed}`);
		return;
	}

	workspace.artifact = { ...artifact, signs: plan.signs };
	commit(workspace, "putting up the signposts");

	out(`${plan.signs.length} board(s) up`);
	for (const missed of plan.missed) out(`  no board: ${missed}`);
}

function placeGate(
	workspace: Workspace,
	args: Args,
	phase: Phase,
	out: (line: string) => void,
): void {
	const artifact = workspace.artifact;
	const siteId = args.int("site");
	const opensWhen = args.str("opens-when");
	const lockedText = args.str("locked-text", "The gate is barred.");
	const opensText = args.has("opens-text") ? args.str("opens-text") : undefined;
	const id = args.str("id", `gate-${siteId}`);
	args.refuseUnknown();

	if (idTaken(artifact, "barriers", id))
		throw new CraftError(`there is already a gate called "${id}"`);
	if (!artifact.sites[String(siteId)])
		throw new CraftError(`site ${siteId} does not exist; nothing has been founded there`);

	const barrier: AuthoredBarrier = {
		id,
		tiles: { siteId, at: "gate" },
		opensWhen: { flag: opensWhen },
		lockedText,
		...(opensText ? { opensText } : {}),
	};
	addTo(workspace, phase, "barriers", barrier);
	commit(workspace, `barring the gate at site ${siteId}`);

	out(`${id} bars ${artifact.sites[String(siteId)]?.name} until "${opensWhen}"`);
}

export function craftTerraform(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "terraform"));
	// Moving the ground is a different thing from stamping tiles onto it, and it is spelled
	// as an option of the same verb because "change the ground" is one idea to an author.
	if (args.has("lower") || args.has("raise")) {
		earthwork(workspace, args, out);
		return;
	}

	const phase = phaseOf(workspace, args.has("phase") ? args.str("phase") : undefined);

	const edit = readEdit(args);
	args.refuseUnknown();

	if (idTaken(workspace.artifact, "terraform", edit.id)) {
		throw new CraftError(`there is already an edit called "${edit.id}"`);
	}
	const tiles = authoredTiles([edit]);
	if (tiles.size === 0) throw new CraftError("that edit changes no ground at all");

	addTo(workspace, phase, "terraform", edit);
	commit(workspace, `laying ${edit.id}`);

	out(`${edit.id}: ${tiles.size} tile(s)`);
	if (phase) out(`  from "${phase.name}" onward`);
	out("  terraform is a debt: it grows the scenario and makes the world look hand-mangled.");
}

/**
 * Move the ground itself, rather than stamping tiles onto it.
 *
 * The other terraform edits paint over the world: a path is a run of road tiles, a bridge is
 * a run of planks. This one changes the elevation field the world is *made of*, so everything
 * downstream of height moves with it — the coastline, the biome, where cliffs form, which
 * ground will hold a building, and the rivers, which run downhill and so will find a valley
 * that has been lowered for them. That is the whole reason it exists: a river cannot be
 * painted on, because a blue line across a hillside is not a river.
 *
 * It is a zone in the recipe rather than an edit in the scenario, which has two consequences
 * worth knowing. It is world-constant, so it cannot belong to a chapter — a chapter that
 * moved the coastline would move it under a town the player had already walked through.
 * And it is not free at play time in the way a tile stamp is: it is read on every elevation
 * sample, which is the hottest path in the generator, so a world with no earthworks skips it
 * on a boolean.
 */
function earthwork(
	workspace: ReturnType<typeof openWorkspace>,
	args: Args,
	out: (line: string) => void,
): void {
	const artifact = workspace.artifact;
	const lowering = args.has("lower");
	const at = args.point(lowering ? "lower" : "raise");
	const radius = args.int("radius", 24);
	const by = Number(args.str("by", "0.06"));
	const id = args.str("id", `${lowering ? "hollow" : "rise"}-${at.x}-${at.y}`);
	if (args.has("phase")) {
		throw new CraftError(
			"the ground is world-constant, so an earthwork cannot belong to a chapter: moving a " +
				"coastline halfway through would move it under a town the player has already walked through",
		);
	}
	args.refuseUnknown();

	if (!Number.isFinite(by) || by <= 0 || by > 0.5) {
		throw new CraftError("--by is how far to move the ground, from 0 to 0.5. 0.06 is a shore");
	}
	if ((artifact.recipe?.zones ?? []).some((zone) => zone.id === id)) {
		throw new CraftError(`there is already a zone called "${id}"`);
	}

	const zone = { id, at, radius, elevation: lowering ? -by : by };
	const recipe = { ...artifact.recipe, zones: [...(artifact.recipe?.zones ?? []), zone] };
	const after = worldSeed(artifact.seed, recipe);

	// Everything already standing has to survive the ground moving under it. `craft check`
	// would find this afterwards; refusing here is what keeps the scenario in a state where
	// the last command that succeeded is the last thing that changed anything.
	for (const spec of Object.values(artifact.sites)) {
		const site = macroSite(after, ...cellOf(artifact, spec.siteId));
		if (buildsSomething(after, site)) continue;
		throw new CraftError(
			`that would leave "${spec.name}" standing on ground that no longer holds a ${site.kind}. ` +
				"Shape the land before founding on it, or move the earthwork off the town",
		);
	}
	const { climate } = after.rules;
	if (elevationAt(after, artifact.spawn.x, artifact.spawn.y) < climate.seaLevel) {
		throw new CraftError("that would put the spawn under water");
	}

	workspace.artifact = { ...artifact, recipe };
	commit(workspace, `moving the ground at ${at.x},${at.y}`);

	const depth = (elevationAt(after, at.x, at.y) - elevationAt(artifactWorld(artifact), at.x, at.y))
		.toFixed(3)
		.replace("-0", "−0");
	out(
		`${id}: ${lowering ? "lowered" : "raised"} ${radius} tiles around ${at.x},${at.y} by ${depth}`,
	);
	out(
		`  the ground at the centre is now ${elevationBand(elevationAt(after, at.x, at.y), after.rules)}`,
	);
	out("  rivers run downhill, so run craft check and look at what moved.");
}

/**
 * The macro cell a founded site sits in.
 *
 * Site ids are hashed from the cell and the hash does not invert, so the only way back is
 * the recipe entry that put the place there — which every founded site has.
 */
function cellOf(artifact: ScenarioArtifact, siteId: number): [number, number] {
	for (const place of artifact.recipe?.places ?? []) {
		const cell: [number, number] = [Math.floor(place.at.x / MACRO), Math.floor(place.at.y / MACRO)];
		if (macroSite(artifactWorld(artifact), ...cell).id === siteId) return cell;
	}
	throw new CraftError(`site ${siteId} has no place in the recipe, so nothing knows where it is`);
}

function readEdit(args: Args): TerraformEdit {
	if (args.has("clearing")) {
		const at = args.point("clearing");
		return {
			t: "Clearing",
			id: args.str("id", `clearing-${at.x}-${at.y}`),
			at,
			radius: args.int("radius", 3),
		};
	}
	const kind = args.has("bridge") ? "bridge" : "path";
	const key = kind === "bridge" ? "bridge" : "path";
	const from = args.point(key, 0);
	const to = args.point(key, 1);
	const id = args.str("id", `${kind}-${from.x}-${from.y}`);
	if (kind === "bridge") return { t: "Bridge", id, from, to };
	const width = args.int("width", 1);
	return {
		t: "Path",
		id,
		from,
		to,
		surface: args.oneOf("surface", ["path", "dirt", "cobble"] as const, "path"),
		...(width > 1 ? { width } : {}),
	};
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "thing"
	);
}
