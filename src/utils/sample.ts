export function sample<T>(valueWeights: [T, number][]): T {
	const totalWeight = valueWeights
		.map((v) => v[1])
		.reduce((acc, weight) => acc + weight, 0);
	const random = Math.random() * totalWeight;
	let cumulativeWeight = 0;
	for (const [value, weight] of valueWeights) {
		cumulativeWeight += weight;
		if (random <= cumulativeWeight) {
			return value;
		}
	}
	return valueWeights[0][0];
}
