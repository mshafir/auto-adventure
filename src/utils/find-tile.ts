function randomPick<T>(list: T[]): T {
	return list[Math.floor(Math.random() * list.length)];
}

function stringToCharArray(str: string): string[] {
	return str.split("");
}

export function findTile(
	tiles: string,
	condition: string | ((tile: string) => boolean),
	pickStrategy: "random" | "first" = "random",
) {
	const rows = tiles.split("\n");
	const matchingCells: [number, number][] = [];
	const testCondition =
		typeof condition === "string"
			? (tile: string) => tile === condition
			: condition;
	for (const [rowIndex, row] of rows.entries()) {
		const chars = stringToCharArray(row);
		for (const [colIndex, char] of chars.entries()) {
			if (testCondition(char)) {
				matchingCells.push([colIndex, rowIndex]);
			}
		}
	}
	if (matchingCells.length === 0) {
		return undefined;
	}
	if (pickStrategy === "random") {
		return randomPick(matchingCells);
	}
	return matchingCells[0];
}
