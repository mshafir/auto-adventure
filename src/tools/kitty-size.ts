/**
 * What a kitty frame costs on the wire, against the glyph renderer.
 *
 * Frame size is the number this project keeps score with — see the notes in
 * `sync-output.ts` and `compose.ts` — and the pixel path is the one change most
 * likely to move it. Both renderers are given the same terminal rectangle, and
 * the tile counts are printed alongside so it is obvious when a mode is buying
 * bytes by showing less world. (It is not: both show 44x34.)
 *
 *   vite-node src/tools/kitty-size.ts
 */
import { generateChunk } from "../core/gen/pipeline.js";
import { hashString } from "../core/rand/hash.js";
import { CHUNK } from "../core/world/coords.js";
import { worldSeed } from "../core/world/recipe.js";
import { encodeScene } from "../ui/render/ansi.js";
import { composeScene } from "../ui/render/compose.js";
import { placeholderRows, transmitFrame } from "../ui/render/kitty.js";
import { cellPixels } from "../ui/render/mode.js";
import { rasterScene, tileFit } from "../ui/render/raster.js";
import { expandScene, TILE_WIDTH, tilesAcross } from "../ui/render/scale.js";
import { createWorldTileSource } from "../ui/render/world-source.js";

const seed = hashString("alpha");
const columns = 88;
const rows = 34;
const cell = cellPixels();
const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;

for (const [cx, cy] of [
	[-3, 1],
	[4, 4],
	[2, 0],
	[0, 0],
] as const) {
	const { chunk } = generateChunk({ world: worldSeed(seed) }, { cx, cy });
	const source = createWorldTileSource({
		seed,
		chunkAt: (qx, qy) => (qx === cx && qy === cy ? chunk : undefined),
	});
	const origin = { x: cx * CHUNK, y: cy * CHUNK };
	const opts = { shadows: true, relief: true };

	const gCam = { ...origin, width: tilesAcross(columns), height: rows };
	const glyph = encodeScene(
		expandScene(composeScene(source, gCam, opts), TILE_WIDTH, gCam),
		"truecolor",
	).reduce((n, l) => n + Buffer.byteLength(l, "utf8"), 0);

	const fit = tileFit(columns, rows, cell);
	const kCam = { ...origin, width: fit.width, height: fit.height };
	const started = process.hrtime.bigint();
	const frame = rasterScene(composeScene(source, kCam, opts));
	const cols = Math.ceil(frame.width / cell.width);
	const crows = Math.ceil(frame.height / cell.height);
	const bytes =
		Buffer.byteLength(transmitFrame({ ...frame, columns: cols, rows: crows }), "utf8") +
		placeholderRows(cols, crows).reduce((n, l) => n + Buffer.byteLength(l, "utf8"), 0);
	const ms = Number(process.hrtime.bigint() - started) / 1e6;

	process.stdout.write(
		`${String(`${cx},${cy}`).padStart(5)}  glyph ${kb(glyph).padStart(8)} ${gCam.width}x${gCam.height}t` +
			`   kitty ${kb(bytes).padStart(8)} ${fit.width}x${fit.height}t ${frame.width}x${frame.height}px  ${ms.toFixed(0)}ms\n`,
	);
}
