import { describe, expect, it } from "vitest";
import { MAX_REDIRECTS, type SafeFetchDeps, UnsafeUrlError, isPublicAddress, safeFetch, textOf } from "./safe-fetch";

describe("isPublicAddress", () => {
	it.each([
		["0.0.0.0", false],
		["10.1.2.3", false],
		["100.64.0.1", false], // CGNAT
		["100.127.255.255", false],
		["127.0.0.1", false],
		["169.254.169.254", false], // cloud metadata
		["172.16.0.1", false],
		["172.31.255.255", false],
		["192.168.1.1", false],
		["192.0.2.1", false],
		["198.18.0.1", false],
		["224.0.0.1", false], // multicast
		["239.255.255.250", false],
		["255.255.255.255", false],
		["8.8.8.8", true],
		["1.1.1.1", true],
		["100.63.255.255", true],
		["100.128.0.0", true],
		["172.15.255.255", true],
		["172.32.0.0", true],
		["::", false],
		["::1", false],
		["::ffff:127.0.0.1", false], // IPv4-mapped
		["::ffff:7f00:1", false],
		["::ffff:169.254.169.254", false],
		["::ffff:8.8.8.8", true],
		["64:ff9b::a9fe:a9fe", false], // NAT64 of 169.254.169.254
		["64:ff9b::808:808", true],
		["2002:7f00:1::", false], // 6to4 of 127.0.0.1
		["fc00::1", false],
		["fd00:ec2::254", false], // AWS metadata over IPv6
		["fe80::1", false],
		["fe80::1%en0", false],
		["ff02::1", false],
		["2001:db8::1", false], // documentation
		["2001:0:4136:e378::1", false], // Teredo
		["2606:4700:4700::1111", true],
		["2a00:1450:4001:80b::200e", true],
		["not an ip", false],
		["1.2.3", false],
		["1.2.3.256", false],
		["1:2:3:4:5:6:7:8:9", false],
	])("%s → %s", (ip, expected) => expect(isPublicAddress(ip)).toBe(expected));
});

/** A fake network: DNS answers and responses by URL. */
function network(dns: Record<string, string[]>, pages: Record<string, () => Response>) {
	const requested: { url: string; addresses: string[] }[] = [];
	const deps: SafeFetchDeps = {
		resolve: async (host) => dns[host] ?? [],
		request: async (url, addresses) => {
			requested.push({ url: url.href, addresses });
			const page = pages[url.href];
			if (!page) throw new Error(`No page at ${url.href}`);
			return page();
		},
	};
	return { deps, requested };
}

const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
const html = (body: string) => () => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

describe("safeFetch", () => {
	it("fetches a public page, connecting only to the addresses it checked", async () => {
		const { deps, requested } = network({ "example.com": ["93.184.216.34"] }, { "https://example.com/": html("<p>hi</p>") });
		const page = await safeFetch("https://example.com", deps);
		expect(page).toMatchObject({ url: "https://example.com/", status: 200, contentType: "text/html", cut: false });
		expect(new TextDecoder().decode(page.bytes)).toBe("<p>hi</p>");
		expect(requested).toEqual([{ url: "https://example.com/", addresses: ["93.184.216.34"] }]);
	});

	it.each([
		["file:///etc/passwd", /Only http and https/],
		["ftp://example.com/", /Only http and https/],
		["https://user:pass@example.com/", /username or password/],
		["http://127.0.0.1/", /private or local/],
		["http://2130706433/", /private or local/], // 127.0.0.1 written as a number
		["http://[::1]/", /private or local/],
		["http://[::ffff:169.254.169.254]/latest/meta-data", /private or local/],
		["http://169.254.169.254/latest/meta-data", /private or local/],
		["http://internal.example/", /private or local/],
		["http://split.example/", /private or local/], // one public, one private answer
		["http://nowhere.example/", /Couldn't find/],
		["not a url", /Not a valid URL/],
	])("refuses %s", async (url, message) => {
		const { deps, requested } = network({ "internal.example": ["10.0.0.5"], "split.example": ["8.8.8.8", "192.168.0.1"] }, {});
		await expect(safeFetch(url, deps)).rejects.toThrow(message);
		expect(requested).toEqual([]);
	});

	it("checks every redirect again, and stops at private ones", async () => {
		const { deps, requested } = network(
			{ "a.example": ["8.8.8.8"], "b.example": ["1.1.1.1"], "evil.example": ["169.254.169.254"] },
			{ "https://a.example/": redirect("https://b.example/next"), "https://b.example/next": redirect("http://evil.example/") },
		);
		await expect(safeFetch("https://a.example/", deps)).rejects.toThrow(UnsafeUrlError);
		expect(requested.map((r) => r.url)).toEqual(["https://a.example/", "https://b.example/next"]);
	});

	it("refuses a redirect to another scheme, or to a private IP literal", async () => {
		const { deps } = network({ "a.example": ["8.8.8.8"] }, { "https://a.example/file": redirect("file:///etc/passwd"), "https://a.example/ip": redirect("http://10.0.0.1/") });
		await expect(safeFetch("https://a.example/file", deps)).rejects.toThrow(/Only http and https/);
		await expect(safeFetch("https://a.example/ip", deps)).rejects.toThrow(/private or local/);
	});

	it("follows relative redirects, up to the limit", async () => {
		const pages: Record<string, () => Response> = { "https://a.example/end": html("done") };
		for (let i = 0; i < MAX_REDIRECTS; i++) pages[`https://a.example/${i}`] = redirect(i === MAX_REDIRECTS - 1 ? "/end" : `/${i + 1}`);
		const { deps } = network({ "a.example": ["8.8.8.8"] }, pages);
		expect((await safeFetch("https://a.example/0", deps)).url).toBe("https://a.example/end");

		pages[`https://a.example/${MAX_REDIRECTS - 1}`] = redirect(`/${MAX_REDIRECTS}`);
		pages[`https://a.example/${MAX_REDIRECTS}`] = redirect("/end");
		await expect(safeFetch("https://a.example/0", deps)).rejects.toThrow(/Too many redirects/);
	});

	it("stops reading at maxBytes", async () => {
		const { deps } = network({ "a.example": ["8.8.8.8"] }, { "https://a.example/": html("x".repeat(100)) });
		const page = await safeFetch("https://a.example/", deps, { maxBytes: 10 });
		expect(page.bytes.length).toBe(10);
		expect(page.cut).toBe(true);
	});
});

describe("textOf", () => {
	const enc = (s: string) => new TextEncoder().encode(s);
	// "Café" in windows-1252: é is 0xE9, which isn't valid UTF-8 on its own.
	const cafe = (prefix = "") => new Uint8Array([...enc(`${prefix}Caf`), 0xe9]);

	it("keeps the header's charset, lowercase, and leaves it out when there's none", async () => {
		const { deps } = network(
			{ "a.example": ["8.8.8.8"] },
			{
				"https://a.example/1252": () => new Response(cafe(), { headers: { "content-type": 'text/html; Charset="Windows-1252"' } }),
				"https://a.example/none": () => new Response(cafe(), { headers: { "content-type": "text/html" } }),
			},
		);
		const page = await safeFetch("https://a.example/1252", deps);
		expect(page).toMatchObject({ contentType: "text/html", charset: "windows-1252" });
		expect(textOf(page)).toBe("Café");
		expect(await safeFetch("https://a.example/none", deps)).not.toHaveProperty("charset");
	});

	it("reads a byte-order mark, then the header, then a meta tag in the first 1 KB, else UTF-8", () => {
		expect(textOf({ bytes: enc("Café") })).toBe("Café");
		expect(textOf({ bytes: cafe('<meta charset="iso-8859-1">') })).toBe('<meta charset="iso-8859-1">Café');
		expect(textOf({ bytes: cafe("<META HTTP-EQUIV='content-type' CONTENT='text/html; charset=windows-1252'>") })).toMatch(/Café$/);
		expect(textOf({ bytes: cafe('<meta charset="iso-8859-1">'), charset: "utf-8" })).toMatch(/Caf\uFFFD$/);
		expect(textOf({ bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...enc("Café")]), charset: "windows-1252" })).toBe("Café");
		expect(textOf({ bytes: new Uint8Array([...enc(" ".repeat(1100)), ...cafe('<meta charset="windows-1252">')]) })).toMatch(/Caf\uFFFD$/);
		// UTF-16 named in ASCII markup can't be true; an unknown label falls back to UTF-8.
		expect(textOf({ bytes: enc('<meta charset="utf-16">Café') })).toBe('<meta charset="utf-16">Café');
		expect(textOf({ bytes: enc("Café"), charset: "x-made-up" })).toBe("Café");
	});
});
