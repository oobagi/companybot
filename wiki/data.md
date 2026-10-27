# Data

Databases and their records: records (clients, deals, tasks, calls…), their fields, links, and history. Built so every record feature in [Product](product.md) sits on it without a rewrite. Code: `core/src/records.ts` (rules), `backend/convex/recordOps.ts` (storage), `records.ts`, `recordTypes.ts`, `fields.ts` (API).

## Model
- **Database** (`recordTypes`) — a collection of records: Client, Deal, Task, Call, or one an owner adds ("Job"). Built-ins come from `recordTypeCatalog`, seeded per workspace (`seedRecordTypes`: `workspace.ensure`, and migration `recordTypes` for older workspaces).
- **Field** (`recordFields`) — one piece of info in a database: built-in ("Stage") or added ("Roof type"). Kinds: text, number, currency, date, checkbox, choice, email, phone, url, user (a teammate), link (another record). Choice, user and link can hold several (`multiple`). Every database has `name`, the record's title.
- **Record** (`records`) — `values`: field key → value. Keys come from the label once ("Roof type" → `roof_type`) and never change, so renames are free. Empty values (and unchecked boxes) aren't stored. Dates are `YYYY-MM-DD`; currency is `{ minor, currency }` (see Money); choices store the option's id, so renaming an option changes nothing.
- **Index** (`recordValues`) — one row per value of a live record: text and ids in `str`, numbers in `num`, links in `ref`. Lists filter and sort through it; never read for display. Text is case-insensitive: up to 100 chars it's its own key; longer, its first 80 chars plus a hash of the whole, so sorting goes by the first 80 and exact matches are re-checked against the value.
- **History** (`recordHistory`) — every change to a record, field, database or saved view: action, each value's old → new, `userId`, and `agentId` when an agent did it for that person. Feeds a record's history and Settings → Activity (`records.activity`).
- **Saved view** (`databaseViews`) — a named filter, sort and ordered columns shared with the workspace. Indexed by database (`by_type`); its lifecycle is `childOf: recordTypes`, so deleting a database in a cascade deletes its views. Removing a member keeps shared views.
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
- **Performance:** cost is the rows the driver reads, not the size of the workspace. A selective condition (one owner, one client, a rare stage) finishes in one request. A rare *combination* of common values (status = done AND owner = Ben, 1,500 rows each, 4 records in both) takes one request per ~1,000 driver rows, mostly short pages; tested on 3,000 seeded tasks under enforced limits (`pnpm test:scale`). That's fine for a list the person scrolls, and for agents and campaigns that page in the background.
- **Not used, on purpose:**
  - *Search indexes with `filterFields`* need a text term, rank by relevance (no field sort), and cap results at 1,024: wrong for lists and campaigns. They stay for `records.search`.
  - *Precomputed combined keys* (type + status + owner) need a fixed set of fields per key, but fields are per workspace and change at runtime, so each would be a per-type setting, rewritten on every edit, for a speedup only rare combinations need. Worth adding as a purpose-built index when one hot view (a pipeline board) shows up slow, beside the generic path.
  - *Intersecting two index streams* (leapfrog) only helps when values cluster, which CRM data rarely does; checking the record is as cheap and simpler.

## Rules
- **Access:** every member reads every record. `records.edit` (owner, member): create, change, archive, restore, undo. `fields.create` (owner, member): add fields; makers can change their own. `fields.manage` (owner): change any field, create, rename and archive databases, or manage anyone's fields (`canEditMade`). Shared views use `records.edit`.
- **Agents act as the person who asked** (`Who = { member, agentId? }`), like memory and connectors: the person's role decides (read fresh each call), history names both. See Agent tools.
- **Edits are field-level patches:** `records.update` sets only the keys given (null clears), so two people editing different fields never clash. No version check; history holds every old value.
- **Undo** (`records.undo`) reverses one entry: archive ↔ restore, or old values back. Refused if any value it touched has changed since, or it was already undone. Old values go through the same checks as any write, against the fields as they are now: no archived fields, retired options, or archived link targets. The undo is itself a history entry (`undoes`).
- **Archive, don't delete.** Archived records keep values and history but leave lists, filters and search (their index rows are dropped, and rebuilt on restore). New links can't point at them.
- **Links to an archived record stay stored** (rewriting every incoming link could be thousands of writes in one mutation). Queries treat the target as gone: `refs` marks it `archived`, filtering by it and `linked` return nothing. Restoring it brings everything back.
- **Removed options are retired, not deleted.** Records keep them (archived ones too), and filters still find them, but they can't be set again, by a person, an agent or an undo. Sending one back (same id or label) revives it. Restoring a record rebuilds its index from the current fields; values on retired options or archived fields stay, as on any live record.
- **Validation is in core** (`normalizeValue`, `fieldConfigError`), so the app, agents and future imports share it. The backend adds what needs the database: users in the workspace, link targets of the right type, choice options in use (can't be removed).
- **Automation hook:** every change goes through `logChange` (`recordOps.ts`). Record triggers ("deal moved to Won") fire from there via `fireEvent`; not wired yet.

## API
**`recordTypes`** `list()` → databases (oldest first) with fields (`_id`, `key`, `label`, `kind`, `options`, `linkType`, `multiple`, `archived`, `canEdit`). The data model agents read. `create({ plural })` (owners; the singular `name` is guessed by `singularOf`, and alpha.6 apps still send it), `update({ typeId, version, name?, plural?, archived? })` (owners; a new plural alone re-guesses the singular). Public paths and Convex table names stay the same for installed apps. Built-ins archive like any other; re-seeding skips keys that exist, archived or not. Keys and routes never change; names must be nonempty, unique against live database names/plurals, and at most 120 characters. At most 32 databases per workspace, including archived ones.

**`databaseViews`** `list({ typeId })`, `save({ typeId, viewId?, version?, name, filters, sort?, columns })`, `remove({ viewId, version })`. Owners and members can create, update and delete shared views; all members read them. At most 50 per database; each config is at most 16,000 characters with a name up to 120 characters, up to 10 filters, sortable fields only, and live unique columns including `name`. Saves and deletes check the version; changing a stale draft is refused. Updates replace the whole config (omitting sort clears it). Filters use stored ids and field keys, validated through the list compiler. Database archive keeps records, fields, views and history, while hiding its sidebar entry and refusing view changes; there is no physical database-delete API.

**`fields`** `create({ typeId, label, kind, options?, linkTypeId?, multiple? })` → field with its `key`. `update({ fieldId, label?, options? })` (send all options; keep `id`s to keep values). `archive` / `restore({ fieldId })`.

**`records`**
- `list({ typeId, archived?, sort?: { field, order }, filters?: [{ field, eq? | in? | gt?/gte?/lt?/lte? | empty? }], paginationOpts })` — see Lists. `sort.field` is `createdAt`, `updatedAt` or a field key (not links or several-value fields); only records with a value for it are listed. Archived lists can't sort by a field. Currency filters are in whole units, in one currency (see Money). Pages can be short with `isDone: false`. Rows: `{ _id, typeId, title, values, archived, updatedAt, refs, unresolved }`; `refs` maps user and record ids in `values` to `{ name, archived? }`.
- `refs({ ids })` — names for up to 200 `unresolved` ids.
- `get({ recordId })` → row + `type` + live `fields`, or null.
- `linked({ recordId, fieldId?, paginationOpts })` — records linking here ("deals for this client").
- `search({ query, typeId? })` — title and text values, top 20, as list rows (values and names), so the app shows them in the same table.
- `history({ recordId, paginationOpts })`, `activity({ paginationOpts })` — newest first, names resolved.
- `discussion({ recordId })` — messages referencing it that you can see.
- `create({ typeId, values })` → id. `update({ recordId, values })`. `archive` / `restore({ recordId })`. `undo({ historyId })`.

## Sorting and filtering in the app
- Sidebar **Databases → + New database** asks owners for one name ("Projects"), then opens it. **Edit database** (next to **+ New**) renames it, including the singular ("Project"), or archives it.
- Above each list, tabs: **All** (columns remembered on this computer) and each shared view. Filters, sort and columns start from the open view; edits stay private until **Save for everyone**. **+** saves the current settings as a new view; **⋯** on an open view renames or deletes it. Search and Show archived are temporary and not saved.
- **All records** keeps local filters, sort and columns per database on this computer. Old column preferences carry over. Shared settings use `useDraft` + `ConflictNotice` and versions, like agents and workspace settings.
- Settings → Activity shows record, field, database and view history, naming the person and any agent acting for them. Database/view changes are logged but do not use record undo.
- Wording: databases contain records; sorting, filtering and columns belong to a view. This follows [Notion's database views](https://www.notion.com/help/views-filters-and-sorts) and [Attio's shared filter and sort settings](https://attio.com/help/reference/managing-your-data/views/filter-and-sort-views).

## Agent tools
`core/src/record-tools.ts` → `ToolContext.records` → `backend/convex/recordTools.ts` (internal `*For` per turn, through `recordOps`). Granted as `records.*`; Companybot has them (migration `companybotRecordTools` for existing ones). All `risk: none`: internal and logged. Record changes have undo; database/view changes do not.
- `records_types` — databases with versions, fields (key, label, kind, options, `linksTo`), workspace currency.
- `records_find` — one database with filters, sort and `cursor` (`records.list` underneath), or `search` (title and text, top 20, no filters). Asks up to 5 times to fill a short page; `more` + `cursor` when there's more. Data result: rows `{ _id, _type? (search across types), …field key: display value }` (keys start with a letter, so a field called "id" can't clash), so `widgets_table` shows them by ref (`path: "rows"`).
- `records_get` — one record: values, `links` (with ids), `linkedFrom` (10), last 5 `changes` with change ids and who (person + agent).
- `records_save` — create, patch values, or archive/restore (on its own). Returns the record and its `change` id.
- `records_undo` — reverses one change (`undoChange`); undoing a create archives it.
- `records_save_field` — add a field (`fields.create`), or rename one / set its options (maker or `fields.manage`).
- `records_save_database` — create (one `name`, e.g. "Projects"; `singular` optional), rename or archive (database key/id + version), owners only (`fields.manage`).
- `records_views` — saved view ids, versions and complete configs for one database.
- `records_save_view` — create, patch or delete (`remove: true`) a shared view (`records.edit`); updates/deletes require its current version. Omitted settings keep their previous values; `sort: null` clears it. Accepts field keys or labels, choice labels, teammates by name or "me", and linked records by exact name or id, like `records_find`. Saved choices use stable option ids.
- **Named like people say them:** databases by id or key, else name or plural; fields by key, else label (a name two could match is refused, listing both); teammates as "me", a name or an email; links as the record's exact name or id.
- **Link names are an exact lookup**, not a search: the target type's name field in `recordValues` (`by_field_str`, live records only), two rows to tell one from several. Lists are checked against their limits (50) first; lookups are memoized, and one call looks up at most 100 distinct names, so a call's reads stay small.
- **What the model sees is capped** (`forModel`, ~24k characters): long text is cut (300 in lists, 2,000 on one record, shorter until it fits), then rows dropped, with a `trimmed` note. The full result stays behind the ref for widgets.
- **Display:** `displayValues` (core): option labels, names, `formatMoney` in en-US so "$" is only USD, `formatDate` ("Nov 15, 2026", the same helper the record screens use). Input amounts follow Money; dates go in and filter as `YYYY-MM-DD` (the tool descriptions say so).
- **Tool lines** say what the call did, from its input and result (`ToolDef.label`, `callLabel`): "Created deal Reroof main warehouse", "Saved Acme Roofing", "Found 1 deal", "Added field Roof type to Clients", "Undid a change to Acme Roofing". Results carry the type's names for this (`typeName`, `typePlural`). A call that fails (including an `{ error }` result) is labeled from its input alone: "Couldn't create deal Reroof main warehouse", else the tool's title.
- Not exposed to agents: archiving fields, workspace-wide history.

## Not built yet
- Automation triggers. Screens are built ([Product](product.md#crm-data-layer-and-screens-built)); code in `desktop/…/views/records/`.
- A record's own discussion thread; today its discussion is the messages that reference it.
- Counts per type (needs the Convex aggregate component; counting would scan).
- Per-type access by role; required fields; sorting that includes empty values; OR across filters.
- Exchange rates (see Money).
- Contacts (people at a client) as their own type, linked to clients.
