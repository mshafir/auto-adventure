/**
 * Decor sits above terrain and below entities. It carries the things a tile
 * *has* rather than what it *is* — a signpost, a chest, a dropped coin — so
 * that removing it (looting, chopping) restores the terrain underneath.
 *
 * Id 0 is "no decor" and must stay at index 0: chunk decor arrays are
 * zero-filled on allocation.
 */
export type DecorId = number;

export interface DecorDef {
	readonly id: DecorId;
	readonly key: string;
	readonly name: string;
	/** Decor never makes a tile passable; it can only take passability away. */
	readonly blocks: boolean;
	readonly describe: string;
}

const DEFS = [
	{ key: "none", name: "", blocks: false, describe: "" },
	{ key: "sign", name: "sign", blocks: true, describe: "A painted board on a post." },
	{
		key: "signpost",
		name: "signpost",
		blocks: true,
		describe: "A crossroads signpost, arms pointing away.",
	},
	{
		key: "well",
		name: "well",
		blocks: true,
		describe: "A stone well. The rope is frayed but sound.",
	},
	{ key: "stall", name: "market stall", blocks: true, describe: "A trestle under a faded awning." },
	{ key: "bench", name: "bench", blocks: true, describe: "A weathered bench." },
	{ key: "barrel", name: "barrel", blocks: true, describe: "A sealed barrel." },
	{ key: "crate", name: "crate", blocks: true, describe: "A nailed-shut crate." },
	{ key: "chest", name: "chest", blocks: true, describe: "A banded chest." },
	{ key: "table", name: "table", blocks: true, describe: "A heavy table." },
	{ key: "chair", name: "chair", blocks: true, describe: "A plain chair." },
	{ key: "bed", name: "bed", blocks: true, describe: "A straw mattress on a frame." },
	{ key: "hearth", name: "hearth", blocks: true, describe: "A hearth, banked low." },
	{ key: "anvil", name: "anvil", blocks: true, describe: "A pitted anvil." },
	{ key: "counter", name: "counter", blocks: true, describe: "A shop counter." },
	{ key: "shelf", name: "shelf", blocks: true, describe: "Shelves crowded with oddments." },
	{ key: "statue", name: "statue", blocks: true, describe: "A statue, its face worn smooth." },
	{ key: "grave", name: "grave", blocks: true, describe: "A grave marker." },
	{ key: "shrine", name: "shrine", blocks: true, describe: "A small roadside shrine." },
	{ key: "campfire", name: "campfire", blocks: true, describe: "A campfire, still warm." },
	{ key: "lamp", name: "lamppost", blocks: true, describe: "An iron lamppost." },
	{ key: "item", name: "something", blocks: false, describe: "Something lies here." },
] as const satisfies readonly Omit<DecorDef, "id">[];

export const DECOR: readonly DecorDef[] = DEFS.map((def, id) => ({ ...def, id }));

type DecorKey = (typeof DEFS)[number]["key"];

export const D = Object.fromEntries(DECOR.map((def) => [def.key, def.id])) as Record<
	DecorKey,
	DecorId
>;

export function decorDef(id: DecorId): DecorDef {
	return DECOR[id] ?? (DECOR[0] as DecorDef);
}
