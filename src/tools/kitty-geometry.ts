/**
 * Print the geometry the game would compute in *this* terminal.
 *
 * Written because the alternative was measuring pixels off a screenshot, which
 * is slow and gets the answer wrong. Everything that decides where the player
 * ends up on screen — the cell size, how many tiles fit, how the image maps
 * onto cells — is derived here exactly as `app.tsx` derives it.
 *
 *   vite-node src/tools/kitty-geometry.ts
 */
import {
	cellPixels,
	cellPixelsWereMeasured,
	lastCellReply,
	measureCellPixels,
	resolveTileMode,
} from "../ui/render/mode.js";
import { tileFit } from "../ui/render/raster.js";
import { tilesAcross } from "../ui/render/scale.js";
import { TILE_PX } from "../ui/render/sprite.js";

const SIDE_PANEL_WIDTH = 32;

async function main() {
	const out = process.stdout;
	const columns = out.columns ?? 0;
	const rows = out.rows ?? 0;

	await measureCellPixels();
	const cell = cellPixels();
	const mode = resolveTileMode();

	// The same arithmetic app.tsx does, and in the same order.
	const frameHeight = Math.max(10, rows - 1);
	const bodyHeight = Math.max(8, frameHeight - 1);
	const mapWidth = Math.max(20, columns - SIDE_PANEL_WIDTH - 2);
	const panelHeight = 3;
	const mapHeight = Math.max(6, bodyHeight - panelHeight);

	const fit =
		mode.mode === "kitty"
			? tileFit(mapWidth, mapHeight, cell)
			: { width: tilesAcross(mapWidth), height: mapHeight };

	const frameW = fit.width * TILE_PX;
	const frameH = fit.height * TILE_PX;

	const lines = [
		`terminal        ${columns} x ${rows} cells`,
		`mode            ${mode.mode} — ${mode.because}`,
		`cell size       ${cell.width} x ${cell.height} px` +
			(process.env.CELL_PX
				? "  (from CELL_PX)"
				: cellPixelsWereMeasured()
					? "  (measured from the terminal)"
					: "  (assumed; the terminal did not answer — set CELL_PX=WxH)"),
		`tile size       ${TILE_PX} px`,
		`query reply     ${lastCellReply() || "(nothing came back)"}`,
		"",
		`map area        ${mapWidth} x ${mapHeight} cells`,
		`side panel      ${SIDE_PANEL_WIDTH} cells`,
		`camera          ${fit.width} x ${fit.height} tiles`,
		`image           ${frameW} x ${frameH} px`,
		`placed into     ${mapWidth} x ${mapHeight} cells` +
			` = ${mapWidth * cell.width} x ${mapHeight * cell.height} px`,
		"",
		// The scale factors are the tell. Equal is a crisp map; unequal stretches
		// it; far from 1 means the cell size is wrong and the tile count with it.
		`scale           ${((mapWidth * cell.width) / frameW).toFixed(2)}x across,` +
			` ${((mapHeight * cell.height) / frameH).toFixed(2)}x down`,
		`player sits at  tile ${Math.floor(fit.width / 2)} of ${fit.width}` +
			` = ${Math.round((Math.floor(fit.width / 2) / fit.width) * 100)}% across the map`,
	];

	out.write(`${lines.join("\n")}\n`);
	if (mode.mode !== "kitty") {
		out.write("\nNot in pixel mode here; run with TILE_MODE=kitty to see its geometry.\n");
	}
}

void main();
