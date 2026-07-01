// Must match REQUIRED_CONFIRMATION_TEXT in kai-execution-api/src/execution.service.ts
// (and kai-frontend's REAL_CONFIRMATION_TEXT). Sent after the user confirms in the
// AlertDialog; the backend rejects any real (dryRun:false) op without this value.
export const REAL_CONFIRMATION_TEXT = "EJECUTAR DEMO";
