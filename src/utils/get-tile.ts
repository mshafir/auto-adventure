export function getTile(layer: string, position: [number, number]) {
	const splitLayer = layer.split("\n");
	if (
		position[0] < 0 ||
		position[1] < 0 ||
		position[1] >= splitLayer.length ||
		position[0] >= splitLayer[position[1]].length
	) {
		return undefined;
	}
	return splitLayer[position[1]][position[0]];
}
