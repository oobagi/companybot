// Fetching a URL someone else picked (a model, a chat message) without reaching our own
// network: SSRF protection. Every hop is checked: http(s) only, no credentials in the URL, and
// every address the host resolves to must be public. The request then connects only to those
// checked addresses, so a DNS answer that changes between check and connect (rebinding) can't
// slip through. Redirects are followed by hand and checked again. No I/O of its own: the backend
// passes `resolve` and `request` (Node's DNS and an HTTP client), so link previews can reuse it.

export const MAX_REDIRECTS = 5;

export interface SafeFetchDeps {
	/** Every address a hostname resolves to. */
	resolve(hostname: string): Promise<string[]>;
	/** One GET of `url`, connecting only to `addresses`, without following redirects. */
	request(url: URL, addresses: string[], init: { signal: AbortSignal; headers: Record<string, string> }): Promise<Response>;
}

export interface SafeFetchOptions {
	/** For every hop and the body together. */
	timeoutMs?: number;
	/** Bodies stop here; `cut` says so. */
	maxBytes?: number;
	headers?: Record<string, string>;
}

export interface FetchedBody {
	/** Where it ended up, after redirects. */
	url: string;
	status: number;
	/** Lowercase, without parameters: "text/html". */
	contentType: string;
	bytes: Uint8Array;
	/** The body was longer than `maxBytes`. */
	cut: boolean;
}

/** A URL or address we won't fetch. The message is safe to show the model. */
export class UnsafeUrlError extends Error {}

export async function safeFetch(url: string, deps: SafeFetchDeps, { timeoutMs = 15_000, maxBytes = 5_000_000, headers = {} }: SafeFetchOptions = {}): Promise<FetchedBody> {
	const signal = AbortSignal.timeout(timeoutMs);
	let current = checkedUrl(url);
	for (let hop = 0; ; hop++) {
		const addresses = await publicAddresses(current.hostname, deps);
		const response = await deps.request(current, addresses, { signal, headers });
		const location = response.headers.get("location");
		if ([301, 302, 303, 307, 308].includes(response.status) && location) {
			await response.body?.cancel();
			if (hop >= MAX_REDIRECTS) throw new UnsafeUrlError(`Too many redirects (more than ${MAX_REDIRECTS}).`);
			current = checkedUrl(new URL(location, current).href);
			continue;
		}
		const { bytes, cut } = await readUpTo(response, maxBytes);
		const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
		return { url: current.href, status: response.status, contentType, bytes, cut };
	}
}

function checkedUrl(raw: string) {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new UnsafeUrlError(`Not a valid URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("Only http and https links can be opened.");
	if (url.username || url.password) throw new UnsafeUrlError("Links with a username or password can't be opened.");
	return url;
}

/** The host's addresses, if every one is public. An IP literal is checked as is. */
async function publicAddresses(hostname: string, deps: SafeFetchDeps) {
	const literal = hostname.startsWith("[") ? hostname.slice(1, -1) : parseIPv4(hostname) !== null ? hostname : null;
	const addresses = literal ? [literal] : await deps.resolve(hostname);
	if (addresses.length === 0) throw new UnsafeUrlError(`Couldn't find ${hostname}.`);
	if (!addresses.every(isPublicAddress)) throw new UnsafeUrlError(`${hostname} is a private or local address, so it can't be opened.`);
	return addresses;
}

async function readUpTo(response: Response, maxBytes: number) {
	const chunks: Uint8Array[] = [];
	let size = 0;
	let cut = false;
	const reader = response.body?.getReader();
	while (reader) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.byteLength;
		if (size > maxBytes) {
			cut = true;
			await reader.cancel();
			break;
		}
	}
	const bytes = new Uint8Array(Math.min(size, maxBytes));
	let at = 0;
	for (const chunk of chunks) {
		const part = chunk.subarray(0, bytes.length - at);
		bytes.set(part, at);
		at += part.length;
	}
	return { bytes, cut };
}

// IPv4 ranges that aren't the public internet (RFC 6890 and friends), as [network, prefix length].
const blockedIPv4: [string, number][] = [
	["0.0.0.0", 8], // "this network"
	["10.0.0.0", 8], // private
	["100.64.0.0", 10], // carrier-grade NAT
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local, including cloud metadata (169.254.169.254)
	["172.16.0.0", 12], // private
	["192.0.0.0", 24], // IETF protocol assignments
	["192.0.2.0", 24], // documentation
	["192.88.99.0", 24], // 6to4 relay
	["192.168.0.0", 16], // private
	["198.18.0.0", 15], // benchmarking
	["198.51.100.0", 24], // documentation
	["203.0.113.0", 24], // documentation
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved, and broadcast
];

/**
 * Whether an address is on the public internet. Anything that doesn't parse is not. IPv6 must be
 * global unicast (2000::/3) outside documentation, Teredo and the like; addresses that carry an
 * IPv4 address (IPv4-mapped, NAT64, 6to4) are judged by it.
 */
export function isPublicAddress(ip: string): boolean {
	const v4 = parseIPv4(ip);
	if (v4 !== null) return !blockedIPv4.some(([net, bits]) => v4 >>> (32 - bits) === parseIPv4(net)! >>> (32 - bits));
	const g = parseIPv6(ip);
	if (!g) return false;
	const embedded = (hi: number, lo: number) => isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
	if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6]!, g[7]!); // ::ffff:a.b.c.d
	if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6]!, g[7]!); // NAT64
	if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
	if ((g[0]! & 0xe000) !== 0x2000) return false; // loopback, unspecified, ULA (fc00::/7), link-local, multicast…
	if (g[0] === 0x2001 && (g[1]! < 0x200 || g[1] === 0xdb8)) return false; // Teredo and IETF assignments; documentation
	if (g[0] === 0x3fff && g[1]! < 0x1000) return false; // documentation (3fff::/20)
	return true;
}

/** "1.2.3.4" → its 32-bit value, or null. Only the plain dotted form; URLs normalize the rest. */
function parseIPv4(ip: string): number | null {
	const parts = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!parts) return null;
	const octets = parts.slice(1).map(Number);
	if (octets.some((o) => o > 255)) return null;
	return octets.reduce((n, o) => n * 256 + o, 0);
}

/** An IPv6 address → its 8 groups, or null. A zone ("%eth0") means link-local, so it's refused. */
function parseIPv6(ip: string): number[] | null {
	if (ip.includes("%")) return null;
	let s = ip.toLowerCase();
	const tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
	if (tail) {
		const v4 = parseIPv4(tail[2]!);
		if (v4 === null) return null;
		s = `${tail[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const groups = (h: string) => (h ? h.split(":") : []);
	const head = groups(halves[0]!);
	const rest = halves.length === 2 ? groups(halves[1]!) : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
	const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
	return all.every((x) => /^[0-9a-f]{1,4}$/.test(x)) ? all.map((x) => parseInt(x, 16)) : null;
}
