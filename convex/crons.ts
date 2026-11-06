import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Erasure is carried by a self-scheduled chain that the platform does not retry when a link throws. This tick finds
// any erasure that stopped short and resumes it (see privacy/sweep.ts). Five minutes keeps a stall well inside the
// 10 minute grace period `ERASE_STALL_MS` before the row counts as stalled.
crons.interval("resume stalled erasures", { minutes: 5 }, internal.privacy.sweep.sweepStalledErasures, {});

export default crons;
