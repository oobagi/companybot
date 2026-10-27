# Pages

Free-form writing, Notion's way: a **page** is a title plus blocks. Standalone pages (wiki, SOPs, meeting notes) and the body under every record's fields are the same thing; a record's body is a page with `recordId` set. Code: `backend/convex/pageOps.ts` (rules), `pages.ts` (app API), `pageSync.ts` (editor sync), `pageTools.ts` + `core/src/page-tools.ts` (agents), `pageMarkdown.ts` (Markdown); app in `desktop/…/views/Pages.tsx` and `views/pages/`.

## Model
- **Page** (`pages`) — `workspaceId`, `title` (standalone only: a record's body shows the record's name), `recordId?`, `archived`, who made and last changed it. One index, `by_workspace` (workspace, record, archived, title), serves the sidebar (standalone, live, by title), a record's body, and the agent's exact-title lookup; `search_title` serves `pages_find`.
- **Content** lives in the [`@convex-dev/prosemirror-sync`](https://github.com/get-convex/prosemirror-sync) component, keyed by the page's id: ProseMirror **snapshots** (whole document) and **deltas** (steps). The editor is [BlockNote](https://www.blocknotejs.org) (MIT core, Mantine UI; no paid XL packages) through the component's `useBlockNoteSync`. The backend reads and writes with BlockNote's ProseMirror schema (`pageSchema`, an unmounted editor needs no DOM).
- **Versions** (`pageVersions`) — the page's history: one row per run of edits, each pointing at the component snapshot it ends at (`version`), with `userId`, `agentId` when an agent did it for that person, `editedAt`, `restored` (the time of the version it brought back), and `n` (counts up per page).

## History, like Notion
Notion saves a version every 10 minutes while you edit, and another 2 minutes after you stop ([help](https://www.notion.com/help/duplicate-delete-and-restore-content)). Same here (`recordVersion`):
- Each accepted batch of steps saves its canonical snapshot and history atomically on the server (`saveTransform`), as do agent writes and restores. Client snapshots are ignored: they cannot invent versions, overwrite content, or change attribution.
- Each batch extends the author's open version if it's the same person (and same agent, or none), the last edit was under 2 minutes ago (`IDLE_MS`), and the version started under 10 minutes ago (`VERSION_MS`). Its old snapshot is deleted. Otherwise it starts a new version.
- Shown as "Edited by Dana" or "Edited by Companybot, for Dana" (`whoLabel`, as record history), with the time. Pick one to see it read-only.
- **Restore** puts a version's content back as a new version ("Restored by Dana · the version from …"), so nothing is lost: the version it replaced can be restored too. It's a server-side transform, so open editors update live.
- Two people typing at once get versions as their accepted step batches land, credited to the person who submitted those steps. Good enough for "who changed this"; per-step authorship would need the component to store authors (on its roadmap).

## Storage bounds
- **Per document:** a page's content is capped at 500 KB of JSON (`PAGE_MAX_BYTES`), measured in encoded bytes on the resulting document and serialized steps before every editor or agent write, so nothing nears Convex's 1 MiB document limit. Past it: "Split it into several pages."
- **Compaction:** the newest 100 versions per page are kept (`PAGE_VERSIONS_MAX`); older ones go with their snapshots. Merging an edit run deletes its previous snapshot. Deltas older than a day and behind the latest snapshot are deleted on every accepted edit (the component's `deleteSteps`, which never deletes past the latest snapshot), so a client that was briefly offline can still catch up. So a page holds at most ~101 snapshots plus a day of steps. A small pnpm patch limits component reads/cleanup to 10 deltas at once (up to ~5 MB), rather than 100 (up to ~50 MB), and makes idle editors drain every missed batch before stopping.
- **Reads:** lists take 200 pages (sidebar) or 50 (`pages_find` list, paged) or 20 (title search, paged), history 20 per page.

## Rules
- **Access:** every member reads every page; `pages.edit` (owner, member) creates, writes, renames, archives, restores and deletes. A page is read-only while it or its record is archived.
- **Sync API:** `useBlockNoteSync` calls `pageSync.*` with the page's id alone, so those functions find the workspace from the page and check membership there (`memberOf`), not from the request like the rest of the API (`functions.ts`).
- **Record bodies** are created on first write (clicking "Write notes…", or an agent writing), so 100k records don't carry 100k empty documents. They're archived with their record and can't be renamed or archived on their own.
- **Archive, then delete.** Deleting a standalone page (archived first) deletes its row at once, then its content (`pageSync.deleteDoc` → the component's `deleteDocument`, which deletes in batches) and a `page` cascade for its versions.

## Agent tools
`pages_find`, `pages_read`, `pages_write` (`core/src/page-tools.ts` → `ToolContext.pages` → `pageTools.ts`, through `runningTurn` like records). Granted as `pages.*`; Companybot has them (migration `companybotPageTools`). All `risk: none`: internal, versioned, restorable.
- `pages_find` — by title words, or every standalone page by title, with `cursor`. Record bodies are found through their record.
- `pages_read` — a page (id or exact title) or a record's body (`record`) as Markdown, 20,000 characters per call (`start`, `next`), plus its last 5 versions with ids.
- `pages_write` — create (`title`, optional `markdown`), append (default) or replace content, rename, archive/restore, or bring back a version (`restore`). Each write is a version "Companybot, for <person>", grouped like a person's edits.
- **Markdown:** BlockNote converts through HTML, so `pageMarkdown.ts` runs in Node with happy-dom as its DOM (jsdom reads files at runtime and can't be bundled). The runner converts before writing and after reading, outside the mutation. Lossy: colors and alignment drop.
- Agent edits show in Settings → Activity as tool calls ("Wrote page Roof inspection SOP"), like any agent change.

## Not built yet
- Nesting pages, page links and mentions, comments, images and files (the app's CSP and storage cleanup come first), page-level permissions, presence and cursors, search inside page content.
- History retention by age (Notion: 7–90 days by plan) instead of by count.
