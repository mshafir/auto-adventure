import { DEFAULT_PACK } from "../../content/default.js";
import type { ContentPack, Household } from "../../content/pack.js";
import { rngFor } from "../../rand/rng.js";
import { isContainer } from "../../rules/loot.js";
import { TFlag } from "../../tiles/flags.js";
import { personName } from "../../world/names.js";
import type { NpcSpec } from "../../world/spec.js";
import type { Interior } from "./interior.js";
import type { StructureKind } from "./patch.js";

/**
 * Who is inside a building.
 *
 * Every interior in the game was empty. You could walk into a house, a barracks or
 * a temple, read the furniture, search a crate and walk out, and the only people in
 * a town of twenty buildings were the three or four standing outdoors. It read as a
 * film set, and worse, it made the interiors pointless: there was never a reason to
 * go in twice.
 *
 * Derived, not authored, and that is the deliberate trade. The town's *principals*
 * come from the director — named by a model, with things they know and a part in the
 * story — because there are three or four of them per town and they are what the
 * player is sent to find. Residents are the other thirty: a model call each would be
 * ten times the cost of the whole world for people whose function is to be somebody
 * home when you knock. So the engine decides that a house has a weaver and a child
 * in it, and the *dialogue* is where a model earns its keep — a live world improvises
 * with them, a scenario falls back to the deterministic tree.
 *
 * Pure in `(seed, interiorId, kind)`, like everything else about an interior, so
 * they survive eviction and reload without being stored: the same house always has
 * the same people in it, and their ids are stable enough to remember a conversation
 * against.
 *
 * Who lives where, what they look like and what they will talk about all come from
 * the content pack, so a scenario can be peopled by fellers and tallymen rather than
 * by weavers and coopers without a line of code changing.
 */

/**
 * Shaped to match `PlacedNpc` where it is read, not where it is built.
 *
 * `name`, `role` and `glyph` are lifted out of the spec even though they are in it,
 * because every consumer — the reducer's `npcAt`, the renderer, the examine verb —
 * already reads them that way off an outdoor NPC. Duplicating three fields is the
 * whole cost of those call sites not needing to know which kind of person they have.
 */
export interface Resident {
	/** `npc:in:{interiorId}:{slot}` — a different space from a site's own people. */
	readonly id: string;
	readonly name: string;
	readonly role: string;
	readonly glyph: string;
	/** Interior-local position. Not a world coordinate. */
	readonly x: number;
	readonly y: number;
	readonly spec: NpcSpec;
}

/** Ids are namespaced so an interior slot can never collide with a site slot. */
export function residentId(interiorId: number, slot: number): string {
	return `npc:in:${interiorId >>> 0}:${slot}`;
}

export function isResidentId(id: string): boolean {
	return id.startsWith("npc:in:");
}

/**
 * How many people a building holds, and what they do.
 *
 * `house` is the fallback, so a pack need not enumerate every structure kind — and a
 * pack that lists none at all leaves every building empty rather than crashing, which
 * is a legible way for a bad pack to fail.
 */
function householdFor(pack: ContentPack, kind: StructureKind): Household {
	return pack.households[kind] ?? pack.households.house ?? { count: [0, 0], roles: [] };
}

export function residentsOf(
	seed: number,
	interiorId: number,
	kind: StructureKind,
	interior: Interior,
	pack: ContentPack = DEFAULT_PACK,
): readonly Resident[] {
	const household = householdFor(pack, kind);
	const rng = rngFor(seed, "residents", interiorId);
	const [low, high] = household.count;
	const count = low + (high > low ? rng.int(high - low + 1) : 0);
	if (count === 0 || household.roles.length === 0) return [];

	const spots = standingRoom(interior);
	if (spots.length === 0) return [];
	const chosen = rng.shuffled(spots).slice(0, Math.min(count, spots.length));

	// Roles are shuffled rather than indexed, so the second person in a house is not
	// always the same trade as the second person in every other house.
	const roles = rng.shuffled([...household.roles]);

	return chosen.map((spot, slot) => {
		const role = roles[slot % roles.length] ?? "resident";
		const spec: NpcSpec = {
			slot,
			// Keyed on the interior id, so a house's people are stable and are nobody
			// else's: two buildings in one town cannot produce the same person.
			name: personName(seed, interiorId, slot, pack),
			role,
			glyph: (role[0] ?? "p").toUpperCase(),
			appearance: appearanceFor(pack, role, kind),
			persona: personaFor(pack, role),
			// Somebody in their own house, spoken to civilly, starts out mildly warm.
			// The principals outdoors start at zero; a household is not a stranger.
			disposition: 8,
			// Not used indoors — placement here comes from the interior's own floor —
			// but the field is part of the shape every dialogue path expects.
			placement: "doorstep",
			knows: [],
		};
		return {
			id: residentId(interiorId, slot),
			name: spec.name,
			role: spec.role,
			glyph: spec.glyph,
			x: spot.x,
			y: spot.y,
			spec,
		};
	});
}

/**
 * Floor a person can stand on without being in the way.
 *
 * Excludes the entrance and the tile in front of it: somebody standing in the
 * doorway would be spoken to the instant the player walked in, before they had seen
 * the room, and — because walking into a person opens a conversation rather than a
 * step — could not be walked around in a corridor one tile wide.
 *
 * Excludes containers too, so a resident never sits on top of the crate the player
 * was sent to search.
 */
function standingRoom(interior: Interior): { x: number; y: number }[] {
	const spots: { x: number; y: number }[] = [];
	for (let y = 1; y < interior.height - 1; y++) {
		for (let x = 1; x < interior.width - 1; x++) {
			const i = y * interior.width + x;
			if ((interior.flags[i] ?? 0) & TFlag.Interior) {
				// Passable interior floor. Decor that blocks is not walkable anyway, but a
				// container is walkable and must stay reachable.
				const decor = interior.decor[i] ?? 0;
				if (isContainer(decor)) continue;
				if (x === interior.entrance.x && y >= interior.entrance.y - 1) continue;
				spots.push({ x, y });
			}
		}
	}
	return spots;
}

/**
 * One telling detail per trade, from the pack.
 *
 * A role the pack says nothing about still gets a line rather than a bare noun,
 * which is what lets an author add `tallyman` to a household without also having to
 * write his appearance before the game will run.
 */
function appearanceFor(pack: ContentPack, role: string, kind: StructureKind): string {
	const written = pack.appearance[role];
	if (written) return written;
	// A kind not in the table still gets something better than a bare role name.
	if (kind === "barracks") return `A ${role} off duty, boots off and belt hung up.`;
	if (kind === "inn") return `A ${role}, flushed from the hearth and the room.`;
	return `A ${role}, at work on something that does not stop for visitors.`;
}

/** What they will talk about, which is what the canned dialogue leans on. */
function personaFor(pack: ContentPack, role: string): string {
	const about =
		pack.talksAbout[role] ?? `the ${role === "labourer" ? "work" : role}'s work and the weather`;
	return `Talks about ${about}.`;
}
