// A record's place in a board's manual order (records.rank): a string, compared character by character,
// so a card always fits between two others without renumbering the rest (fractional indexing).

/** In character-code order, so a string's order is its index order. */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Creation times count down from here (year 2286), so newer records come first. */
const NEWEST = 10 ** 13;
/** Base 36 of `NEWEST - time` in microseconds (creation times have a fraction of a millisecond), padded to one width. */
const WIDTH = 11;

/**
 * Where a record starts: by creation time, newest first, like the board without a manual order.
 * `salt` (its id) keeps any two apart.
 */
export function rankAt(time: number, salt: string) {
	const clean = salt.replace(/[^0-9A-Za-z]/g, "").slice(-6);
	// Never ending in the lowest digit, so there's always room before it.
	return `${Math.max(0, Math.round((NEWEST - time) * 1000)).toString(36).padStart(WIDTH, "0")}${clean}V`;
}

/**
 * A rank between `a` and `b` (either missing: the start or the end). They must be in order, and a
 * rank never ends in "0", so there's always room.
 */
export function rankBetween(a: string | undefined, b: string | undefined): string {
	if (a !== undefined && b !== undefined && a >= b) throw new Error(`${a} isn't before ${b}.`);
	return midpoint(a ?? "", b);
}

function midpoint(a: string, b: string | undefined): string {
	if (b !== undefined) {
		// The common start, then the midpoint of what's left.
		let n = 0;
		while ((a[n] ?? "0") === b[n]) n++;
		if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
	}
	const lo = a ? DIGITS.indexOf(a[0]!) : 0;
	const hi = b !== undefined ? DIGITS.indexOf(b[0]!) : DIGITS.length;
	if (hi - lo > 1) return DIGITS[Math.round((lo + hi) / 2)]!;
	// Adjacent digits: keep `b`'s first if it has more after it, else go one deeper after `a`'s.
	if (b !== undefined && b.length > 1) return b.slice(0, 1);
	return DIGITS[lo]! + midpoint(a.slice(1), undefined);
}
