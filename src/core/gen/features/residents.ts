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

interface Household {
	/** Inclusive range, rolled per building. */
	readonly count: readonly [number, number];
	readonly roles: readonly string[];
}

/**
 * How many people a building holds, and what they do.
 *
 * The counts are about what makes a room worth entering rather than about realism: a
 * barracks with one soldier in it is a disappointment, and a warehouse with a family
 * in it is a puzzle. Roles are plain nouns because they become the glyph and the
 * fallback dialogue, both of which read better for a "cooper" than for a "resident".
 */
const HOUSEHOLDS: Readonly<Record<string, Household>> = {
	inn: { count: [2, 4], roles: ["cook", "server", "drover", "traveller", "harpist"] },
	shop: { count: [1, 2], roles: ["shopkeeper", "porter"] },
	apothecary: { count: [1, 2], roles: ["herbalist", "apprentice"] },
	smithy: { count: [1, 2], roles: ["striker", "apprentice"] },
	temple: { count: [1, 3], roles: ["priest", "acolyte", "mourner"] },
	shrine: { count: [0, 1], roles: ["caretaker"] },
	barracks: { count: [2, 4], roles: ["soldier", "sergeant", "recruit", "cook"] },
	mill: { count: [1, 2], roles: ["miller", "carter"] },
	stable: { count: [1, 2], roles: ["groom", "farrier"] },
	warehouse: { count: [0, 2], roles: ["tallyman", "porter"] },
	barn: { count: [0, 1], roles: ["farmhand"] },
	tower: { count: [1, 2], roles: ["watchman", "signaller"] },
	// Nobody lives in a ruin. Something might, but that is a different feature.
	ruin: { count: [0, 0], roles: [] },
	house: {
		count: [1, 3],
		roles: ["weaver", "cooper", "carpenter", "widow", "child", "labourer", "brewer", "netmaker"],
	},
};

function householdFor(kind: StructureKind): Household {
	return HOUSEHOLDS[kind] ?? (HOUSEHOLDS.house as Household);
}

export function residentsOf(
	seed: number,
	interiorId: number,
	kind: StructureKind,
	interior: Interior,
): readonly Resident[] {
	const household = householdFor(kind);
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
			name: personName(seed, interiorId, slot),
			role,
			glyph: (role[0] ?? "p").toUpperCase(),
			appearance: appearanceFor(role, kind),
			persona: personaFor(role),
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
 * One telling detail per trade.
 *
 * Written out per role rather than generated from a template, because a template is
 * exactly what this reads as otherwise — the first draft gave nearly everybody "at
 * work on something that does not stop for visitors", and walking through a town of
 * thirty people saying the same sentence is worse than a town of nobody. This is the
 * line the examine verb prints, so it is read more often than any dialogue.
 */
const APPEARANCE: Readonly<Record<string, string>> = {
	weaver: "Sat at the loom, and not stopping it for you.",
	cooper: "Hands pale with shavings, a half-hooped barrel between the knees.",
	carpenter: "A pencil behind one ear and sawdust in the crease of both sleeves.",
	widow: "Neat, grey, and entirely composed. Black worn past the point of mourning.",
	child: "Small, unbothered, and entirely unsurprised to see you.",
	labourer: "Big hands, borrowed boots, asleep in the chair until you came in.",
	brewer: "Sleeves rolled past the elbow, forearms scalded pink.",
	netmaker: "Knotting by feel, watching you instead of the work.",
	cook: "Flour to the wrist, and a knife they have not put down.",
	server: "Carrying four things and looking for somewhere to put two of them.",
	drover: "Smells of the road and of somebody else's cattle.",
	traveller: "Boots by the fire, coat still on, ready to be somewhere else.",
	harpist: "Tuning something that will not stay tuned in this weather.",
	shopkeeper: "Counting the shelf again, having lost the count once already.",
	porter: "Waiting to be told which of two crates goes first.",
	herbalist: "Sorting cuttings into piles that look identical to you.",
	apprentice: "Young, watchful, and plainly not supposed to be talking to you.",
	striker: "Shoulders like a door, deaf on the side nearest the anvil.",
	priest: "Unhurried in the way of somebody whose day has no appointments in it.",
	acolyte: "Trimming lamps, and glad of the interruption.",
	mourner: "Sat where the light is worst, and not looking up.",
	soldier: "Off duty, boots off, belt hung on the bedpost.",
	sergeant: "Awake, dressed, and unimpressed by the door opening.",
	recruit: "Standing straighter than anyone else in the room.",
	miller: "White to the eyebrows, shouting a little out of habit.",
	carter: "One boot up on a sack, resting a leg that has been walked on all day.",
	groom: "Talking to a horse in the voice most people save for children.",
	farrier: "Apron scorched through in three places, hands black to the wrist.",
	tallyman: "A slate, a stub of chalk, and a very poor opinion of your timing.",
	farmhand: "Up to the shins in straw, and glad of a reason to stand still.",
	watchman: "Awake at the wrong end of the day, and making sure you know it.",
	signaller: "One eye on the window the whole time.",
	caretaker: "Sweeping something that does not need it, slowly.",
};

function appearanceFor(role: string, kind: StructureKind): string {
	const written = APPEARANCE[role];
	if (written) return written;
	// A kind not in the table still gets something better than a bare role name.
	if (kind === "barracks") return `A ${role} off duty, boots off and belt hung up.`;
	if (kind === "inn") return `A ${role}, flushed from the hearth and the room.`;
	return `A ${role}, at work on something that does not stop for visitors.`;
}

/** What they will talk about, which is what the canned dialogue leans on. */
const TALKS_ABOUT: Readonly<Record<string, string>> = {
	child: "the dog, the roof, and whatever you are carrying",
	widow: "who has died, who has left, and who is pretending not to have",
	soldier: "the watch, the food, and the officers",
	sergeant: "the watch, and what the watch is for",
	traveller: "the road behind them and the price of a bed",
	drover: "prices at the last three markets",
	priest: "the season, the dead, and the collection",
	tallyman: "what came in, what went out, and the difference",
	miller: "the grain, the water, and whoever is late",
	shopkeeper: "stock, and what nobody will buy",
};

function personaFor(role: string): string {
	const about =
		TALKS_ABOUT[role] ?? `the ${role === "labourer" ? "work" : role}'s work and the weather`;
	return `Talks about ${about}.`;
}
