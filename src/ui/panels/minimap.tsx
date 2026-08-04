import { Text } from "ink";
import { questChunks } from "../../core/rules/quest-map.js";
import type { GameState } from "../../core/rules/state.js";
import { biomeAt } from "../../core/world/context.js";
import { CHUNK, chunkKey, toChunk } from "../../core/world/coords.js";
import { isSettlement, macroSite } from "../../core/world/macro.js";

export interface MinimapProps {
	readonly state: GameState;
	readonly width: number;
	readonly height: number;
}

/**
 * The explored world, one character per chunk.
 *
 * An infinite map needs something that makes the shape of a journey legible;
 * a list of coordinates does not. Only chunks the player has actually walked
 * into are drawn — everything else is blank, so the map fills in as a record of
 * where they have been rather than as a spoiler for where they have not.
 */
const BIOME_COLOR: Readonly<Record<string, string>> = {
	ocean: "blue",
	beach: "yellow",
	marsh: "green",
	grassland: "green",
	meadow: "green",
	shrubland: "green",
	forest: "green",
	rainforest: "green",
	taiga: "cyan",
	savanna: "yellow",
	desert: "yellow",
	badlands: "red",
	moor: "magenta",
	highland: "white",
	alpine: "white",
	glacier: "cyan",
};

const WATERY = new Set(["ocean", "marsh"]);
const WOODED = new Set(["forest", "rainforest", "taiga"]);
const HIGH = new Set(["highland", "alpine", "glacier"]);

export function Minimap({ state, width, height }: MinimapProps) {
	const here = toChunk(state.player.x, state.player.y);
	const seen = new Set(state.discovered);
	const errands = questChunks(state);

	// A row is `2 * half + 1` cells wide, so the half-width has to come off
	// `width - 1`. Getting this wrong overflows the panel by one column and Ink
	// wraps every row onto a second line, doubling the height of the map.
	const halfW = Math.max(3, Math.floor((width - 1) / 2));
	const halfH = Math.max(2, Math.floor((height - 1) / 2));

	const rows: React.ReactElement[] = [];
	for (let dy = -halfH; dy <= halfH; dy++) {
		const cells: React.ReactElement[] = [];
		for (let dx = -halfW; dx <= halfW; dx++) {
			const cx = here.cx + dx;
			const cy = here.cy + dy;
			const key = `${cx},${cy}`;

			if (dx === 0 && dy === 0) {
				cells.push(
					<Text key={key} bold color="green">
						@
					</Text>,
				);
				continue;
			}
			if (!seen.has(chunkKey(cx, cy))) {
				cells.push(<Text key={key}> </Text>);
				continue;
			}

			// Drawn over the settlement glyph rather than beside it: which town it is
			// matters less than that something is waiting there.
			if (errands.has(chunkKey(cx, cy))) {
				cells.push(
					<Text key={key} bold color="magenta">
						!
					</Text>,
				);
				continue;
			}

			const site = macroSite(state.world.seed, cx, cy);
			if (isSettlement(site.kind)) {
				cells.push(
					<Text key={key} bold color="yellow">
						{site.kind === "town" ? "▣" : "▪"}
					</Text>,
				);
				continue;
			}

			// Biome is recomputed rather than stored: it is a pure function of the
			// seed and the position, so remembering it would only be a way to get it
			// wrong after a schema change.
			const biome = biomeAt(state.world.seed, cx * CHUNK + CHUNK / 2, cy * CHUNK + CHUNK / 2);
			cells.push(
				<Text key={key} color={BIOME_COLOR[biome] ?? "gray"}>
					{glyphForBiome(biome)}
				</Text>,
			);
		}
		rows.push(
			<Text key={`row${dy}`} wrap="truncate">
				{cells}
			</Text>,
		);
	}

	return <>{rows}</>;
}

function glyphForBiome(biome: string): string {
	if (WATERY.has(biome)) return "~";
	if (WOODED.has(biome)) return "▲";
	if (HIGH.has(biome)) return "^";
	if (biome === "desert" || biome === "beach") return ".";
	return "░";
}
