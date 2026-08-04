/**
 * Prove the kitty graphics path works in this terminal, before anything is
 * built on top of it.
 *
 * The test pattern is chosen so that every way it can go wrong looks different:
 * four differently-coloured quadrants catch a scrambled placement, a white
 * diagonal catches rows or columns being transposed, and a one-pixel border
 * catches the image being scaled into the wrong cell rectangle. A pattern that
 * is merely "colourful" would look fine while being completely wrong.
 *
 *   vite-node src/tools/kitty-check.ts --
 *   vite-node src/tools/kitty-check.ts -- --implicit
 */
import {
	deleteFrame,
	detectKittyGraphics,
	graphicsBlockedByMultiplexer,
	placeholderRows,
	transmitFrame,
} from "../ui/render/kitty.js";

function parseArgs(argv: readonly string[]) {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const match = /^--([^=]+)(?:=(.*))?$/.exec(argv[i] ?? "");
		if (!match?.[1]) continue;
		if (match[2] !== undefined) {
			args.set(match[1], match[2]);
			continue;
		}
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			args.set(match[1], next);
			i++;
		} else {
			args.set(match[1], "true");
		}
	}
	return args;
}

/** Four quadrants, a diagonal and a border. See the note at the top of the file. */
function testPattern(width: number, height: number): Buffer {
	const rgb = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const left = x < width / 2;
			const top = y < height / 2;
			let c: [number, number, number] = top
				? left
					? [220, 40, 40] // red
					: [40, 200, 40] // green
				: left
					? [60, 90, 230] // blue
					: [230, 200, 40]; // yellow

			// The diagonal runs corner to corner, so a transposition shows up as a
			// mirrored line rather than as nothing at all.
			if (Math.abs(x / width - y / height) < 0.01) c = [255, 255, 255];
			const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
			if (edge) c = [20, 20, 20];

			const i = (y * width + x) * 3;
			rgb[i] = c[0];
			rgb[i + 1] = c[1];
			rgb[i + 2] = c[2];
		}
	}
	return rgb;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const columns = Number(args.get("columns") ?? 40);
	const rows = Number(args.get("rows") ?? 16);
	const explicit = !args.has("implicit");
	// Roughly a cell's aspect, so the pattern is not obviously squashed.
	const width = columns * 8;
	const height = rows * 16;

	const out = process.stdout;
	out.write(`terminal: TERM=${process.env.TERM} TERM_PROGRAM=${process.env.TERM_PROGRAM}\n`);
	out.write(`kitty graphics detected: ${detectKittyGraphics()}\n`);
	out.write(`multiplexer in the way: ${graphicsBlockedByMultiplexer()}\n`);
	out.write(
		`placement: ${explicit ? "explicit row/column diacritics" : "implicit continuation"}\n`,
	);
	out.write(`image: ${width}x${height} px into ${columns}x${rows} cells\n\n`);

	out.write(transmitFrame({ rgb: testPattern(width, height), width, height, columns, rows }));
	out.write(`${placeholderRows(columns, rows, { explicit }).join("\n")}\n`);

	out.write("\nExpected: a rectangle in four colours — red top-left, green top-right,\n");
	out.write("blue bottom-left, yellow bottom-right — with a white diagonal from the\n");
	out.write("top-left corner to the bottom-right, and a thin dark border.\n\n");
	out.write("If you see base64 text, the escapes are not being consumed.\n");
	out.write("If you see nothing at all, the placement did not resolve.\n");
	out.write("If the colours are shuffled, the row/column diacritics are wrong.\n");
	out.write("Try --implicit to test continuation instead of explicit diacritics.\n");

	// Deliberately *not* deleting the image on the way out: the placement is what
	// is on screen, and freeing it here would wipe the very thing being checked.
	void deleteFrame;
}

main();
