export function randomPick<T>(list: T[]): T | undefined {
	if (list.length === 0) return undefined;
	return list[Math.floor(Math.random() * list.length)];
}

/**
 * Pick several values, avoiding picking the same one twice
 * @param list P
 * @param count
 * @returns
 */
export function randomPickMultiple<T>(list: T[], count: number): T[] {
	const picked = new Set<T>();
	const result = [];
	while (picked.size < count && picked.size < list.length) {
		const pick = randomPick(list);
		if (pick && !picked.has(pick)) {
			picked.add(pick);
			result.push(pick);
		}
	}
	return result;
}
