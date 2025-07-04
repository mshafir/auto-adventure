export function removeAtIndex<T>(lst: T[], index: number): T[] {
	return lst.filter((_, i) => i !== index);
}

export function removeAtIndicies<T>(lst: T[], indicies: number[]): T[] {
	return lst.filter((_, i) => !indicies.includes(i));
}
