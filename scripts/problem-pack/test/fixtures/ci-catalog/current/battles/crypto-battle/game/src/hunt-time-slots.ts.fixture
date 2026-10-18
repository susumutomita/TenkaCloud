/** Exact timestamps indexed by attacker. Zero means absent, never timestamp zero.
 * Positive widths retain the original absolute-offset slots. Negative widths
 * encode signed differences between present slots; absent slots leave the prior
 * offset untouched. Use deltas only when their serialized form is smaller.
 */
import { packUnsignedSlots, unpackUnsignedSlots } from "./integer-slots.ts";

export function packHuntTimeSlots(values: readonly number[]) {
	const direct = packUnsignedSlots(values);
	let previous = 0;
	const deltas: number[] = [];
	for (const value of values) {
		if (value === 0) {
			deltas.push(0);
			continue;
		}
		const delta = value - previous;
		const encoded = delta >= 0 ? 2 * delta + 1 : -2 * delta;
		if (!Number.isSafeInteger(encoded)) return direct;
		deltas.push(encoded);
		previous = value;
	}
	const packed = packUnsignedSlots(deltas);
	const smallest = packed.text.length + 1 < direct.text.length
		? { width: -packed.width, text: packed.text }
		: direct;
    // Consecutive equal differences are common, but every exact difference is
    // retained. Bound each run at 63 so a malformed count cannot expand freely.
    const runs: number[] = [];
    for (const delta of deltas) {
        if (runs.length && runs.at(-1) === delta && runs[runs.length - 2]! < 63)
            runs[runs.length - 2]!++;
        else runs.push(1, delta);
    }
    const packedRuns = packUnsignedSlots(runs);
    const text = `${packedRuns.width}:${packedRuns.text}`;
    return text.length + 1 < smallest.text.length ? {width: 12, text} : smallest;
}

export function unpackHuntTimeSlots(text: string, width: number): number[] {
	let deltas: number[];
    if (width === 12) {
        const separator = text.indexOf(':');
        if (separator !== 1 || !/^[1-9]$/.test(text[0]!)) throw new Error("Invalid HUNT time runs");
        const runs = unpackUnsignedSlots(text.slice(separator + 1), Number(text[0]));
        if (runs.length % 2) throw new Error("Incomplete HUNT time run");
        deltas = [];
        for (let i = 0; i < runs.length; i += 2) {
            const count = runs[i]!;
            if (count < 1 || count > 63) throw new Error("Invalid HUNT time run length");
            for (let n = 0; n < count; n++) deltas.push(runs[i + 1]!);
        }
    } else {
        if (width >= 0) return unpackUnsignedSlots(text, width);
        deltas = unpackUnsignedSlots(text, -width);
    }
	let previous = 0;
	return deltas.map((value) => {
		if (value === 0) return 0;
		const delta = value % 2 ? (value - 1) / 2 : -value / 2;
		const result = previous + delta;
		if (!Number.isSafeInteger(result) || result < 1)
			throw new Error("Invalid HUNT time difference");
		previous = result;
		return result;
	});
}
