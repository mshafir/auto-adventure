export function getTileColumnCells(layer: string, x: number) {
	const rows = layer.split("\n");
	return rows.map((row) => row[x]);
}

export function getTileRowCells(layer: string, y: number) {
	const rows = layer.split("\n");
	return rows[y].split("");
}
