import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Scheduled automations check here: each runs its latest cron time once, so a late or missed check runs it once (automationRuns.ts).
crons.interval("automations", { minutes: 5 }, internal.automationRuns.tick, {});
// Forgets webhook delivery ids once senders have stopped retrying them.
crons.interval("automation webhooks", { hours: 1 }, internal.automationRuns.forgetOldWebhooks);
// Wakeups that fired or were cancelled a month ago (wakeups.ts).
crons.interval("wakeups", { hours: 1 }, internal.wakeups.forgetSettled);
// Tool-call receipts a month old: no step retries that late (approvals.ts).
crons.interval("tool receipts", { hours: 1 }, internal.approvals.forgetReceipts);
// Connector sign-ins nobody finished.
crons.interval("connector sign-ins", { hours: 1 }, internal.connectors.forgetExpiredOAuth);
// Typing rows from people who typed and never sent (typing.ts).
crons.interval("typing", { hours: 1 }, internal.typing.forgetStale);
// Uploads nobody attached within a day, and their files (images.ts).
crons.interval("uploads", { hours: 1 }, internal.images.sweepUploads);
// Deletions (cascade.ts) whose last run failed start again.
crons.interval("cascades", { minutes: 15 }, internal.cascade.resume);
// Field changes: forgets old values kept past 30 days, and starts again changes whose last run failed (fieldChanges.ts).
crons.interval("field changes", { minutes: 15 }, internal.fieldChanges.sweep, {});
// AI Gateway's model list, for the agent model picker (modelCatalog.ts).
crons.interval("model catalog", { hours: 24 }, internal.modelCatalog.refresh);

// Native push: one bounded batch per tick, with durable leases, receipt checks and retention.
crons.interval("mobile push", { seconds: 10 }, internal.mobilePush.send);
crons.interval("mobile push receipts", { minutes: 1 }, internal.mobilePush.receipts);
crons.interval("mobile push retention", { minutes: 5 }, internal.mobileNotifications.sweep);
crons.interval("integration retention", { hours: 1 }, internal.integrationMaintenance.sweep, {});
crons.interval("integration notifications", { minutes: 1 }, internal.integrationWebhooks.tick, {});

export default crons;
