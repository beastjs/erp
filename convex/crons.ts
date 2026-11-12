import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Erasure is carried by a self-scheduled chain that the platform does not retry when a link throws. This tick finds
// any erasure that stopped short and resumes it (see privacy/sweep.ts). Five minutes keeps a stall well inside the
// 10 minute grace period `ERASE_STALL_MS` before the row counts as stalled.
crons.interval("resume stalled erasures", { minutes: 5 }, internal.privacy.sweep.sweepStalledErasures, {});

// New verification rules (a list edit, a `STRUCTURAL_RULES_REVISION` bump) only take effect when a stage runs, and
// nothing runs a finished subject. This tick sends every contact judged under older rules back through the pipeline
// (see verify/sweep.ts). Once an org's walk under the current rules is done, a tick costs one read for that org.
crons.interval("re-judge verdicts under changed rules", { minutes: 15 }, internal.verify.sweep.sweepStaleVerdicts, {});

export default crons;
