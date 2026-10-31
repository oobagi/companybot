import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Scheduled automations check here: each runs its latest cron time once, so a late or missed check runs it once (automationRuns.ts).
crons.interval("automations", { minutes: 5 }, internal.automationRuns.tick, {});
// Forgets webhook delivery ids once senders have stopped retrying them.
crons.interval("automation webhooks", { hours: 1 }, internal.automationRuns.forgetOldWebhooks);
// Wakeups that fired or were cancelled a month ago (wakeups.ts).
crons.interval("wakeups", { hours: 1 }, internal.wakeups.forgetSettled);
// Connector sign-ins nobody finished.
crons.interval("connector sign-ins", { hours: 1 }, internal.connectors.forgetExpiredOAuth);
// Typing rows from people who typed and never sent (typing.ts).
crons.interval("typing", { hours: 1 }, internal.typing.forgetStale);
// Uploads nobody attached within a day, and their files (images.ts).
crons.interval("uploads", { hours: 1 }, internal.images.sweepUploads);
// Deletions (cascade.ts) whose last run failed start again.
crons.interval("cascades", { minutes: 15 }, internal.cascade.resume);
// AI Gateway's model list, for the agent model picker (modelCatalog.ts).
crons.interval("model catalog", { hours: 24 }, internal.modelCatalog.refresh);

export default crons;
