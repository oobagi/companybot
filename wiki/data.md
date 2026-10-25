# Data

The CRM half: records (clients, deals, tasks, calls…), their fields, links, and history. Built so every record feature in [Product](product.md) sits on it without a rewrite. Code: `core/src/records.ts` (rules), `backend/convex/recordOps.ts` (storage), `records.ts`, `recordTypes.ts`, `fields.ts` (API).

## Model
- **Record type** (`recordTypes`) — a kind of record: Client, Deal, Task, Call, or one an owner adds ("Job"). Built-ins come from `recordTypeCatalog`, seeded per workspace (`seedRecordTypes`: `workspace.ensure`, and migration `recordTypes` for older workspaces).
- **Field** (`recordFields`) — one piece of info on a type: built-in ("Stage") or added ("Roof type"). Kinds: text, number, currency, date, checkbox, choice, email, phone, url, user (a teammate), link (another record). Choice, user and link can hold several (`multiple`). Every type has `name`, the record's title.
- **Record** (`records`) — `values`: field key → value. Keys come from the label once ("Roof type" → `roof_type`) and never change, so renames are free. Empty values (and unchecked boxes) aren't stored. Dates are `YYYY-MM-DD`; choices store the option's id, so renaming an option changes nothing.
- **Index** (`recordValues`) — one row per value of a live record: text and ids in `str` (lowercased, first 100 chars), numbers in `num`, links in `ref`. Lists filter and sort through it; never read for display.
- **History** (`recordHistory`) — every change to a record or field: action, each value's old → new, `userId`, and `agentId` when an agent did it for that person. Feeds a record's history and Settings → Activity (`records.activity`).
- **Mentions** (`recordMentions`) — a chat message that references a record (`messages.send` → `mentions.recordIds`). `records.discussion` lists the ones you can see.

## Why one generic records table
Separate tables per type (Night Owl's way) means a migration for every new type or field, five copies of "who changed what", and agent tools per table. One table with type definitions gives one API, one history, one index, one set of agent tools for every type, and new types/fields are rows.
- **Convex limits:** 32 indexes per table and indexes are fixed at deploy, so custom fields can't each get an index on the record. The `recordValues` side table gives every field (built-in or added later) an index with 4 indexes total, no per-workspace schema.
- **Query speed:** lists page straight off an index: `by_type` (newest), `by_type_updated`, or `recordValues` by field (`by_field_str`, `by_field_num`, `by_ref`). No scans; a page reads at most 100 rows plus their records. Fine at 100k+ records per workspace.
- **Filtering and sorting on custom fields:** same path as built-ins. One indexed field per query: filter (`eq`, or `gte`/`lte` for numbers and dates) and sort on the same field. Only records with a value for that field are listed.
- **Migrations:** adding a field or type writes one row; existing records just have no value yet. Archiving a field keeps every value (restore brings them back). A field's kind and key never change, so stored values never need rewriting.
- **Heavy data** (call recordings, transcripts, invoice lines) doesn't go in `values`: it goes in its own table keyed by `recordId`, so records stay small (1 MB doc limit, 100 fields × 10k chars max).

## Rules
- **Access:** every member reads every record. `records.edit` (owner, member): create, change, archive, restore, undo. `fields.create` (owner, member): add fields; makers can change their own. `fields.manage` (owner): change any field, add types (`canEditMade`).
- **Agents act as the person who asked** (`Who = { member, agentId? }`), like memory and connectors: the person's role decides, history names both. Agent tools wrap `recordOps` in internal `*For` functions (see `memory.ts`); not built yet.
- **Edits are field-level patches:** `records.update` sets only the keys given (null clears), so two people editing different fields never clash. No version check; history holds every old value.
- **Undo** (`records.undo`) reverses one entry: archive ↔ restore, or old values back. Refused if any value it touched has changed since, or it was already undone. The undo is itself a history entry (`undoes`).
- **Archive, don't delete.** Archived records keep values and history but leave lists, filters, links and search (their index rows are dropped, and rebuilt on restore). Links can't point at archived records.
- **Validation is in core** (`normalizeValue`, `fieldConfigError`), so the app, agents and future imports share it. The backend adds what needs the database: users in the workspace, link targets of the right type, choice options in use (can't be removed).
- **Automation hook:** every change goes through `logChange` (`recordOps.ts`). Record triggers ("deal moved to Won") fire from there via `fireEvent`; not wired yet.

## API
**`recordTypes`** `list()` → types (oldest first) with fields (`_id`, `key`, `label`, `kind`, `options`, `linkType`, `multiple`, `archived`, `canEdit`). The data model agents read. `create({ name, plural })`.

**`fields`** `create({ typeId, label, kind, options?, linkTypeId?, multiple? })` → field with its `key`. `update({ fieldId, label?, options? })` (send all options; keep `id`s to keep values). `archive` / `restore({ fieldId })`.

**`records`**
- `list({ typeId, archived?, sort?: { field, order }, where?: { field, eq?, gte?, lte? }, paginationOpts })` — `sort.field` is `createdAt`, `updatedAt` or a field key. Rows: `{ _id, typeId, title, values, archived, updatedAt, refs }`; `refs` maps user and record ids in `values` to names.
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
- Contacts (people at a client) as their own type, linked to clients.
