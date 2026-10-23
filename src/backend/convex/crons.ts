import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Scheduled automations check here; each runs at most once a day (automations.ts).
crons.interval("automations", { minutes: 5 }, internal.automations.tick);

export default crons;
