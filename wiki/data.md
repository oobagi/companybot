# Data

The CRM half: records (clients, deals, tasks, calls…), their fields, links, and history. Built so every record feature in [Product](product.md) sits on it without a rewrite. Code: `core/src/records.ts` (rules), `backend/convex/recordOps.ts` (storage), `records.ts`, `recordTypes.ts`, `fields.ts` (API).

## Model
- **Record type** (`recordTypes`) — a kind of record: Client, Deal, Task, Call, or one an owner adds ("Job"). Built-ins come from `recordTypeCatalog`, seeded per workspace (`seedRecordTypes`: `workspace.ensure`, and migration `recordTypes` for older workspaces).
- **Field** (`recordFields`) — one piece of info on a type: built-in ("Stage") or added ("Roof type"). Kinds: text, number, currency, date, checkbox, choice, email, phone, url, user (a teammate), link (another record). Choice, user and link can hold several (`multiple`). Every type has `name`, the record's title.
- **Record** (`records`) — `values`: field key → value. Keys come from the label once ("Roof type" → `roof_type`) and never change, so renames are free. Empty values (and unchecked boxes) aren't stored. Dates are `YYYY-MM-DD`; currency is `{ minor, currency }` (see Money); choices store the option's id, so renaming an option changes nothing.
- **Index** (`recordValues`) — one row per value of a live record: text and ids in `str`, numbers in `num`, links in `ref`. Lists filter and sort through it; never read for display. Text is case-insensitive: up to 100 chars it's its own key; longer, its first 80 chars plus a hash of the whole, so sorting goes by the first 80 and exact matches are re-checked against the value.
- **History** (`recordHistory`) — every change to a record or field: action, each value's old → new, `userId`, and `agentId` when an agent did it for that person. Feeds a record's history and Settings → Activity (`records.activity`).
- **Mentions** (`recordMentions`) — a chat message that references a record (`messages.send` → `mentions.recordIds`). `records.discussion` lists the ones you can see.

## Money
- **Every amount carries its own currency** (ISO 4217), like Stripe and HubSpot: `{ minor: 10000, currency: "USD" }`. `minor` is a whole number of the currency's smallest unit (ISO 4217 exponent, like Stripe): $100 is 10000, ¥100 is 100, KWD 1.250 is 1250. `minorDigits(code)` gives the decimals (0 for JPY, KRW, CLP…; 3 for KWD, BHD, OMR…; 2 otherwise); `formatMoney` shows an amount in them.
- **The workspace's currency** (`workspaces.currency`, default USD; Settings → General, owners) is only the default for new amounts, and later for totals and reports. Changing it never touches existing amounts: $100 stays $100. The app warns first if amounts exist ("Existing amounts stay in USD. New amounts will use EUR.").
- **Input:** `1250.50`, `"$1,250.50"` or `{ amount }` use the workspace's currency; `"EUR 12.50"`, `"12.50 EUR"` or `{ amount, currency }` name their own. Rounds the exact decimal to that currency's decimals, half away from zero (JPY 99.5 → ¥100, KWD 1.2345 → 1.235); must stay within safe integers.
- **Comparing:** amounts compare only within one currency. Index rows are `str` = code, `num` = minor units, so sorting groups by currency code, then amount. A filter picks one currency: the workspace's, unless its value names another (`gte: "USD 0"`); a range mixing currencies is refused.
- History and undo store the whole value, so the currency comes back with it.
- **Later:** exchange-rate conversion (totals across currencies, "sort by value in EUR").

## Why one generic records table
Separate tables per type (Night Owl's way) means a migration for every new type or field, five copies of "who changed what", and agent tools per table. One table with type definitions gives one API, one history, one index, one set of agent tools for every type, and new types/fields are rows.
- **Convex limits:** 32 indexes per table and indexes are fixed at deploy, so custom fields can't each get an index on the record. The `recordValues` side table gives every field (built-in or added later) an index with 4 indexes total, no per-workspace schema.
- **Query speed:** lists page straight off an index (`by_type`, `by_type_updated`, or `recordValues` by field), never a table scan, and every request does a fixed amount of work. Fine at 100k+ records per workspace; see Lists.
- **Filtering and sorting on custom fields:** same path as built-ins.
- **Migrations:** adding a field or type writes one row; existing records just have no value yet. Archiving a field keeps every value (restore brings them back). A field's kind and key never change, so stored values never need rewriting.
- **Heavy data** (call recordings, transcripts, invoice lines) doesn't go in `values`: it goes in its own table keyed by `recordId`.
- **Size and read budgets:** a record's values are capped at 128 KB (`RECORD_MAX_BYTES`). History stores a change's old and new values together, so an entry stays under ~260 KB, far below Convex's 1 MiB document limit. Pages are capped (50 records, 20 history entries) so a page stays under the 16 MiB read limit. Names for links and people are resolved once per page, up to 200 or 4 MB of reads; the rest come back in `unresolved` for `records.refs`.

## Lists
`records.list` takes any number of filters (all must match) and one sort. Campaigns, pipelines, saved views and agent queries all sit on it.
- **Conditions:** `eq`; `in` (any of, up to 50) on choice, person and link fields; ranges (`gt`/`gte`/`lt`/`lte`) on single-valued number, amount and date fields; `empty: true/false`. Fields holding several values (tags) take `eq`, `in` and `empty` only. Up to 10 filters.
- **Plan:** one index stream *drives* the scan and sets the order; every other condition is checked on the record itself (`recordQuery.ts`). The driver is, in order:
  1. the sort field, if sorting by a field (a range on it narrows the stream);
  2. `updatedAt` or `createdAt`, if sorting by one (the records' own indexes);
  3. the `eq`/`in` condition with the fewest index rows;
  4. else the range or `empty: false` condition with the fewest rows;
  5. else every record by creation time, newest first (through each live record's name row, `by_field_at`; archived lists read the records).
- **Selectivity is estimated cheaply:** the candidates share 400 index rows of counting (one filter counts up to 400, ten up to 40 each); the smallest wins, ties go to the first given. Equality always beats a range, even a smaller one, so a list's order depends only on the query, never on the data: equality rows are kept in creation order (`at` on `recordValues`), so equality-driven lists stay newest first, while a lone range lists in that field's order. To drive from a range in a known order, sort by its field.
- **"Any of"** reads one stream per value and merges them by creation time (each stream keeps what it has read until it's used), so a record holding two of the values comes once.
- **Ties:** `recordValues` indexes end in `at`, then `recordId`, so records sharing a value and creation time (imports keep creation times) page in id order like any other key. Lists read straight off `records` (archived records, or sorted by `updatedAt`) can't index `_id`, so a group tied on every key is read whole; one larger than a request can read (~20 big records) is refused rather than skipped.
- **Links to archived records** are checked against the target's index rows (an archived record has none), not the whole record, so link filters cost one tiny read per target, inside the budget. `empty` on a link field looks only at live targets, for one link or several.
- **Bounded work:** everything a request reads goes through one budget: link targets, counting, index rows and records. At most 1,000 index rows (in chunks of 100), 2,500 index ranges and 6 MB, and at most 50 records back. No record is read without room for the largest possible one (256 KB), so a request never passes the budget by more than one small read; the rest of Convex's 16 MiB and 4,096 ranges is left for resolving names (`toRows`). If the budget runs out first, it returns what it found, maybe nothing, with `isDone: false` and a cursor to go on, like Convex's own filtered pagination. **The app and agents must keep asking while `isDone` is false, even after a short or empty page.**
- **Cursors** hold a fingerprint of the query as resolved (workspace, type, archived, sort, and filters with values as stored, so `eq: 100` in USD and in EUR differ), the plan and the last key read, so pages never repeat or skip a record, even with several-value fields and records changing between pages (a record that changes moves like it would in any Convex list). Plans are fixed for the whole list. A cursor used with a different query is refused ("That page is out of date").
- **`endCursor`** (how `usePaginatedQuery` keeps pages stable) still returns at most 50 records. A page that grew past that comes back `pageStatus: "SplitRequired"` with a `splitCursor`, and the client splits it.
- **`recordValues.at`** is optional until migration `recordValueTimes` (`pnpm release` runs it) fills older rows from their record's creation time, 20 rows a batch (each reads its whole record). A list that meets a row without it says to try again in a minute. No deployment had records when it shipped; make it required once the migration has run on prod.
- **Performance:** cost is the rows the driver reads, not the size of the workspace. A selective condition (one owner, one client, a rare stage) finishes in one request. A rare *combination* of common values (status = done AND owner = Ben, 1,500 rows each, 4 records in both) takes one request per ~1,000 driver rows, mostly short pages; tested on 3,000 seeded tasks under enforced limits. That's fine for a list the person scrolls, and for agents and campaigns that page in the background.
- **Not used, on purpose:**
  - *Search indexes with `filterFields`* need a text term, rank by relevance (no field sort), and cap results at 1,024: wrong for lists and campaigns. They stay for `records.search`.
  - *Precomputed combined keys* (type + status + owner) need a fixed set of fields per key, but fields are per workspace and change at runtime, so each would be a per-type setting, rewritten on every edit, for a speedup only rare combinations need. Worth adding as a purpose-built index when one hot view (a pipeline board) shows up slow, beside the generic path.
  - *Intersecting two index streams* (leapfrog) only helps when values cluster, which CRM data rarely does; checking the record is as cheap and simpler.

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
- `list({ typeId, archived?, sort?: { field, order }, filters?: [{ field, eq? | in? | gt?/gte?/lt?/lte? | empty? }], paginationOpts })` — see Lists. `sort.field` is `createdAt`, `updatedAt` or a field key (not links or several-value fields); only records with a value for it are listed. Archived lists can't sort by a field. Currency filters are in whole units, in one currency (see Money). Pages can be short with `isDone: false`. Rows: `{ _id, typeId, title, values, archived, updatedAt, refs, unresolved }`; `refs` maps user and record ids in `values` to `{ name, archived? }`.
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
- Per-type access by role; required fields; sorting that includes empty values; OR across filters.
- Exchange rates (see Money).
- Contacts (people at a client) as their own type, linked to clients.
