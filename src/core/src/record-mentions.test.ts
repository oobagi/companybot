import { describe, expect, it } from "vitest";
import { RECORD_TAGS_MAX, recordTag, showRecordTags, storeRecordTags, taggedRecordIds } from "./record-mentions";

describe("record tags", () => {
	it("finds tags as written and as stored, each record once", () => {
		expect(taggedRecordIds("I added [@Summit Homes](record:abc1) to Clients, see <record:xyz9> and [Summit](record:abc1)")).toEqual(["abc1", "xyz9"]);
		expect(taggedRecordIds("[Plan](companybot://page/abc) and a [link](https://a.co) and @Summit")).toEqual([]);
	});

	it("stores only the id, and leaves tags it can't keep as their names", () => {
		const keep = (id: string) => id === "abc1";
		expect(storeRecordTags("I added [@Summit Homes](record:abc1) and [@Made Up](record:nope)", keep)).toBe("I added <record:abc1> and Made Up");
		expect(storeRecordTags("<record:abc1> <record:gone>", keep)).toBe("<record:abc1> a record");
		// A name never reaches the stored text, even for a record that's kept.
		expect(storeRecordTags("[@Secret Deal](record:abc1)", keep)).not.toContain("Secret");
	});

	it("keeps at most RECORD_TAGS_MAX records a message", () => {
		const text = Array.from({ length: RECORD_TAGS_MAX + 2 }, (_, i) => recordTag(`r${i}`, `R${i}`)).join(" ");
		const stored = storeRecordTags(text, () => true);
		expect(taggedRecordIds(stored)).toHaveLength(RECORD_TAGS_MAX);
		expect(stored.endsWith(`R${RECORD_TAGS_MAX} R${RECORD_TAGS_MAX + 1}`)).toBe(true);
	});

	it("shows each tag the way the reader should read it", () => {
		const names: Record<string, string> = { abc1: "@Summit Homes (renamed)" };
		const show = (id: string, label: string | null) => names[id] ?? (label === null ? "@Private record" : label);
		expect(showRecordTags("See <record:abc1> and <record:xyz9>", show)).toBe("See @Summit Homes (renamed) and @Private record");
		// Still as written (a reply streaming): an unknown id reads as what its writer named it.
		expect(showRecordTags("[@Acme](record:nope)", show)).toBe("Acme");
	});

	it("writes a tag whose name can't end it early", () => {
		expect(recordTag("abc1", "Acme [West]\nRoofing")).toBe("[@Acme  West  Roofing](record:abc1)");
		expect(taggedRecordIds(recordTag("abc1", "a ] b"))).toEqual(["abc1"]);
	});
});
