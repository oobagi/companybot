// Encrypts connector credentials at rest with AES-GCM. The key lives only in the
// CONNECTIONS_KEY env var (32 random bytes, base64). Use from actions only:
// mutations get deterministic randomness, which would repeat IVs.

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function key() {
	const raw = process.env.CONNECTIONS_KEY;
	if (!raw) throw new Error("CONNECTIONS_KEY isn't set on this deployment.");
	return crypto.subtle.importKey("raw", unb64(raw) as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(value: unknown): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = new TextEncoder().encode(JSON.stringify(value));
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), data));
	return `v1.${b64(iv)}.${b64(sealed)}`;
}

export async function decrypt<T>(text: string): Promise<T> {
	const [version, iv, sealed] = text.split(".");
	if (version !== "v1" || !iv || !sealed) throw new Error("Unreadable credentials.");
	const data = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: unb64(iv) as Uint8Array<ArrayBuffer> },
		await key(),
		unb64(sealed) as Uint8Array<ArrayBuffer>,
	);
	return JSON.parse(new TextDecoder().decode(data)) as T;
}
