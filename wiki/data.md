# Data

The CRM half: records (clients, deals, tasks, calls…), their fields, links, and history. Built so every record feature in [Product](product.md) sits on it without a rewrite. Code: `core/src/records.ts` (rules), `backend/convex/recordOps.ts` (storage), `records.ts`, `recordTypes.ts`, `fields.ts` (API).

## Model
- **Record type** (`recordTypes`) — a kind of record: Client, Deal, Task, Call, or one an owner adds ("Job"). Built-ins come from `recordTypeCatalog`, seeded per workspace (`seedRecordTypes`: `workspace.ensure`, and migration `recordTypes` for older workspaces).
- **Field** (`recordFields`) — one piece of info on a type: built-in ("Stage") or added ("Roof type"). Kinds: text, number, currency, date, checkbox, choice, email, phone, url, user (a teammate), link (another record). Choice, user and link can hold several (`multiple`). Every type has `name`, the record's title.
- **Record** (`records`) — `values`: field key → value. Keys come from the label once ("Roof type" → `roof_type`) and never change, so renames are free. Empty values (and unchecked boxes) aren't stored. Dates are `YYYY-MM-DD`; currency is `{ cents, currency }` (see Money); choices store the option's id, so renaming an option changes nothing.
- **Index** (`recordValues`) — one row per value of a live record: text and ids in `str`, numbers in `num`, links in `ref`. Lists filter and sort through it; never read for display. Text is case-insensitive: up to 100 chars it's its own key; longer, its first 80 chars plus a hash of the whole, so sorting goes by the first 80 and exact matches are re-checked against the value.
- **History** (`recordHistory`) — every change to a record or field: action, each value's old → new, `userId`, and `agentId` when an agent did it for that person. Feeds a record's history and Settings → Activity (`records.activity`).
- **Mentions** (`recordMentions`) — a chat message that references a record (`messages.send` → `mentions.recordIds`). `records.discussion` lists the ones you can see.

## Money
- **Every amount carries its own currency** (ISO 4217), like Stripe and HubSpot: `{ cents: 10000, currency: "USD" }`. `cents` is the amount × 100 for every currency (¥100 is 10000); display rounds to the currency's own decimals. Three-decimal currencies (KWD, BHD…) keep only two.
- **The workspace's currency** (`workspaces.currency`, default USD; Settings → General, owners) is only the default for new amounts, and later for totals and reports. Changing it never touches existing amounts: $100 stays $100. The app warns first if amounts exist ("Existing amounts stay in USD. New amounts will use EUR.").
- **Input:** `1250.50`, `"$1,250.50"` or `{ amount }` use the workspace's currency; `"EUR 12.50"`, `"12.50 EUR"` or `{ amount, currency }` name their own. Rounds the exact decimal, half away from zero; must stay within safe integers.
- **Comparing:** amounts compare only within one currency. Index rows are `str` = code, `num` = cents, so sorting groups by currency code, then amount. A filter picks one currency: the workspace's, unless its value names another (`gte: "USD 0"`); a range mixing currencies is refused.
- History and undo store the whole value, so the currency comes back with it.
- **Later:** exchange-rate conversion (totals across currencies, "sort by value in EUR"), and per-currency decimals.

## Why one generic records table
Separate tables per type (Night Owl's way) means a migration for every new type or field, five copies of "who changed what", and agent tools per table. One table with type definitions gives one API, one history, one index, one set of agent tools for every type, and new types/fields are rows.
- **Convex limits:** 32 indexes per table and indexes are fixed at deploy, so custom fields can't each get an index on the record. The `recordValues` side table gives every field (built-in or added later) an index with 4 indexes total, no per-workspace schema.
- **Query speed:** lists page straight off an index: `by_type` (newest), `by_type_updated`, or `recordValues` by field (`by_field_str`, `by_field_num`, `by_ref`). No scans; a page reads at most 50 rows plus their records. Fine at 100k+ records per workspace.
- **Filtering and sorting on custom fields:** same path as built-ins. One indexed field per query: filter (`eq`, or `gte`/`lte` for numbers and dates) and sort on the same field. Only records with a value for that field are listed.
- **Migrations:** adding a field or type writes one row; existing records just have no value yet. Archiving a field keeps every value (restore brings them back). A field's kind and key never change, so stored values never need rewriting.
- **Heavy data** (call recordings, transcripts, invoice lines) doesn't go in `values`: it goes in its own table keyed by `recordId`.
- **Size and read budgets:** a record's values are capped at 128 KB (`RECORD_MAX_BYTES`). History stores a change's old and new values together, so an entry stays under ~260 KB, far below Convex's 1 MiB document limit. Pages are capped (50 records, 20 history entries) so a page stays under the 16 MiB read limit. Names for links and people are resolved once per page, up to 200 or 4 MB of reads; the rest come back in `unresolved` for `records.refs`.
- **Known limit: one indexed field per query.** Combined filters at scale (status + due date + owner over 100k records, as campaigns will need) need indexed intersections or purpose-built queue tables later. They sit beside the generic table; they don't replace it.

## Rules
- **Access:** every member reads every record. `records.edit` (owner, member): create, change, archive, restore, undo. `fields.create` (owner, member): add fields; makers can change their own. `fields.manage` (owner): change any field, add types (`canEditMade`).
- **Agents act as the person who asked** (`Who = { member, agentId? }`), like memory and connectors: the person's role decides, history names both. Agent tools wrap `recordOps` in internal `*For` functions (see `memory.ts`); not built yet.
- **Edits are field-level patches:** `records.update` sets only the keys given (null clears), so two people editing different fields never clash. No version check; history holds every old value.
- **Undo** (`records.undo`) reverses one entry: archive ↔ restore, or old values back. Refused if any value it touched has changed since, or it was already undone. Old values go through the same checks as any write, against the fields as they are now: no archived fields, retired options, or archived link targets. The undo is itself a history entry (`undoes`).
- **Archive, don't delete.** Archived records keep values and history but leave lists, filters and search (their index rows are dropped, and rebuilt on restore). New links can't point at them.
- **Links to an archived record stay stored** (rewriting every incoming link could be thousands of writes in one mutation). Queries treat the target as gone: `refs` marks it `archived`, filtering by it and `linked` return nothing. Restoring it brings everything back.
- **Removed options are retired, not deleted.** Records keep them (archived ones too), and filters still find them, but they can't be set again, by a person, an agent or an undo. Sending one back (same id or label) revives it. Restoring a record rebuilds its index from the current fields; values on retired options or archived fields stay, as on any live record.
- **Validation is in core** (`normalizeValue`, `fieldConfigError`), so the app, agents and future imports share it. The backend adds what needs the database: users in the workspace, link targets of the right type, choice options in use (can't be removed).
- **Automation hook:** every change goes through `logChange` (`recordOps.ts`). Record triggers ("deal moved to Won") fire from there via `fireEvent`; not wired yet.

## API
**`recordTypes`** `list()` → types (oldest first) with fields (`_id`, `key`, `label`, `kind`, `options`, `linkType`, `multiple`, `archived`, `canEdit`). The data model agents read. `create({ name, plural })`.

**`fields`** `create({ typeId, label, kind, options?, linkTypeId?, multiple? })` → field with its `key`. `update({ fieldId, label?, options? })` (send all options; keep `id`s to keep values). `archive` / `restore({ fieldId })`.

**`records`**
- `list({ typeId, archived?, sort?: { field, order }, where?: { field, eq?, gte?, lte? }, paginationOpts })` — `sort.field` is `createdAt`, `updatedAt` or a field key. Fields holding several values take `eq` only, so a record never repeats across pages. Currency filters are in whole units, in one currency (see Money). Rows: `{ _id, typeId, title, values, archived, updatedAt, refs, unresolved }`; `refs` maps user and record ids in `values` to `{ name, archived? }`.
- `refs({ ids })` — names for up to 200 `unresolved` ids.
- `get({ recordId })` → row + `type` + live `fields`, or null.
- `linked({ recordId, fieldId?, paginationOpts })` — records linking here ("deals for this client").
- `search({ query, typeId? })` — title and text values, top 20.
- `history({ recordId, paginationOpts })`, `activity({ paginationOpts })` — newest first, names resolved.
- `discussion({ recordId })` — messages referencing it that you can see.
- `create({ typeId, values })` → id. `update({ recordId, values })`. `archive` / `restore({ recordId })`. `undo({ historyId })`.

## Not built yet
- Record screens (tabs are placeholders), agent tools, automation triggers.
- A record's own discussion thread; today its discussion is the messages that reference it.
- Counts per type (needs the Convex aggregate component; counting would scan).
- Per-type access by role; required fields; filters on two fields at once; sorting that includes empty values.
- Exchange rates (see Money).
- Contacts (people at a client) as their own type, linked to clients.
