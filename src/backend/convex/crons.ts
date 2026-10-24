import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Scheduled automations check here; each runs at most once a day (automations.ts).
crons.interval("automations", { minutes: 5 }, internal.automations.tick);
// Forgets webhook event ids once senders have stopped retrying them.
crons.interval("automation events", { hours: 1 }, internal.automations.forgetOldEvents);

export default crons;
