/**
 * Binary min-heap over integer keys with numeric priorities.
 *
 * Kept deliberately primitive — parallel arrays of numbers, no comparator
 * callback, no objects — because it sits inside the A* inner loop that runs for
 * every road segment and every settlement carve path.
 */
export class MinHeap {
	private keys: number[] = [];
	private priorities: number[] = [];

	get size(): number {
		return this.keys.length;
	}

	push(key: number, priority: number): void {
		this.keys.push(key);
		this.priorities.push(priority);
		let i = this.keys.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if ((this.priorities[parent] as number) <= (this.priorities[i] as number)) break;
			this.swap(i, parent);
			i = parent;
		}
	}

	pop(): number | undefined {
		const n = this.keys.length;
		if (n === 0) return undefined;
		const top = this.keys[0] as number;
		const lastKey = this.keys.pop() as number;
		const lastPriority = this.priorities.pop() as number;
		if (n > 1) {
			this.keys[0] = lastKey;
			this.priorities[0] = lastPriority;
			this.sinkFrom(0);
		}
		return top;
	}

	clear(): void {
		this.keys.length = 0;
		this.priorities.length = 0;
	}

	private sinkFrom(start: number): void {
		const n = this.keys.length;
		let i = start;
		for (;;) {
			const left = i * 2 + 1;
			const right = left + 1;
			let smallest = i;
			if (left < n && (this.priorities[left] as number) < (this.priorities[smallest] as number)) {
				smallest = left;
			}
			if (right < n && (this.priorities[right] as number) < (this.priorities[smallest] as number)) {
				smallest = right;
			}
			if (smallest === i) break;
			this.swap(i, smallest);
			i = smallest;
		}
	}

	private swap(a: number, b: number): void {
		const k = this.keys[a] as number;
		const p = this.priorities[a] as number;
		this.keys[a] = this.keys[b] as number;
		this.priorities[a] = this.priorities[b] as number;
		this.keys[b] = k;
		this.priorities[b] = p;
	}
}
