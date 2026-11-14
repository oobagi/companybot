import migrations from "@convex-dev/migrations/convex.config.js";
import prosemirrorSync from "@convex-dev/prosemirror-sync/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(migrations);
// Page bodies: ProseMirror snapshots and steps (pageSync.ts). See wiki/pages.md.
app.use(prosemirrorSync);

export default app;
