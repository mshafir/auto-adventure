/**
 * Per-tile bit flags. Stored in a `Uint8Array` alongside terrain, so the whole
 * set has to fit in 8 bits — add sparingly, and prefer deriving from terrain
 * where the answer is a pure function of the terrain id.
 */
export const TFlag = {
	Passable: 1 << 0,
	BlocksSight: 1 << 1,
	Water: 1 << 2,
	Deep: 1 << 3,
	Road: 1 << 4,
	Wall: 1 << 5,
	Door: 1 << 6,
	Interior: 1 << 7,
} as const;

export type TFlagName = keyof typeof TFlag;

export function hasFlag(flags: number, flag: number): boolean {
	return (flags & flag) !== 0;
}
