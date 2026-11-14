// Records tagged in chat messages, like @people: "I added [@Summit Homes](record:k57…) to Clients".
//
// People's composer and agents write a tag as `[@Name](record:<id>)`. The server keeps only the id,
// as `<record:<id>>`, never the name: a message is read by people who may not see the record's
// database, so its name is filled in per reader (`showRecordTags`), and a reader who can't see it
// gets "Private record". Renames show everywhere, since the name is never stored.

/** A tag as written (`[@Name](record:id)`, the @ optional) or as stored (`<record:id>`). */
const TAG = /\[@?([^\]\n]{0,200})\]\(record:([a-z0-9]{1,64})\)|<record:([a-z0-9]{1,64})>/g;

/** At most this many records tagged in one message; more are left as their names. */
export const RECORD_TAGS_MAX = 20;

/** What readers who can't see the record's database read instead of its name. */
export const PRIVATE_RECORD = "Private record";
/** A record deleted for good. */
export const DELETED_RECORD = "Deleted record";

type Found = { id: string; label: string | null; start: number; end: number };

function tagsIn(text: string): Found[] {
	return [...text.matchAll(TAG)].map((m) => ({ id: (m[2] ?? m[3])!, label: m[3] ? null : m[1]!, start: m.index, end: m.index + m[0].length }));
}

/** The record ids tagged in a message, in order, each once (written or stored form). */
export const taggedRecordIds = (text: string) => [...new Set(tagsIn(text).map((t) => t.id))];

/**
 * The text to store: tags of records in `keep` become `<record:id>` (the first RECORD_TAGS_MAX records),
 * any other tag is left as its name, as if it were plain text (an id that's made up, or a record the
 * writer can't see). A stored tag that isn't kept reads "a record".
 */
export function storeRecordTags(text: string, keep: (id: string) => boolean) {
	const kept = new Set<string>();
	return text.replace(TAG, (_, label: string | undefined, written: string | undefined, stored: string | undefined) => {
		const id = (written ?? stored)!;
		if (keep(id) && (kept.has(id) || kept.size < RECORD_TAGS_MAX)) {
			kept.add(id);
			return `<record:${id}>`;
		}
		return label?.trim() || "a record";
	});
}

/** How one tag reads, by its id and, for a tag still as written, the name its writer gave it. */
export type ShowTag = (id: string, label: string | null) => string;

/** The text with each tag (written or stored) replaced by how it reads. */
export const showRecordTags = (text: string, show: ShowTag) =>
	text.replace(TAG, (_, label: string | undefined, written: string | undefined, stored: string | undefined) => show((written ?? stored)!, stored ? null : (label ?? "")));

/** A record as a tag, the way agents read and write one. The name loses what would end the tag. */
export const recordTag = (id: string, name: string) => `[@${name.replace(/[[\]\n]/g, " ").trim()}](record:${id})`;
