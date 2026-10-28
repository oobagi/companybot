import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Scheduled automations check here; each runs at most once a day (automationRuns.ts).
crons.interval("automations", { minutes: 5 }, internal.automationRuns.tick, {});
// Forgets webhook delivery ids once senders have stopped retrying them.
crons.interval("automation webhooks", { hours: 1 }, internal.automationRuns.forgetOldWebhooks);
// Connector sign-ins nobody finished.
crons.interval("connector sign-ins", { hours: 1 }, internal.connectors.forgetExpiredOAuth);
// Typing rows from people who typed and never sent (typing.ts).
crons.interval("typing", { hours: 1 }, internal.typing.forgetStale);
// What's been in Trash for 30 days goes for good (trash.ts).
crons.interval("trash", { hours: 1 }, internal.trash.sweep);
// Uploads nobody attached within a day, and their files (images.ts).
crons.interval("uploads", { hours: 1 }, internal.images.sweepUploads);
// Deletions (cascade.ts) whose last run failed start again.
crons.interval("cascades", { minutes: 15 }, internal.cascade.resume);
// AI Gateway's model list, for the agent model picker (modelCatalog.ts).
crons.interval("model catalog", { hours: 24 }, internal.modelCatalog.refresh);

export default crons;
