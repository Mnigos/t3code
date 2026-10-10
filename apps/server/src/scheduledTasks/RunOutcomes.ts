import type {
  MessageId,
  OrchestrationV2DomainEvent,
  OrchestrationV2RunStatus,
  RunId,
  ScheduledTaskId,
} from "@t3tools/contracts";

/** The terminal outcome of a dispatched scheduled run, keyed to the row that started it. */
export interface RunOutcome {
  readonly taskId: ScheduledTaskId;
  /** The task's `last_run_at` for this run; a newer run replaces it. */
  readonly startedAtIso: string;
  readonly status: "succeeded" | "failed";
  readonly error: string | null;
}

interface PendingRun {
  /** The message the dispatch stamped; a failed dispatch forgets the run by it. */
  readonly messageId: MessageId;
  readonly taskId: ScheduledTaskId;
  readonly startedAtIso: string;
  /** The latest provider error the run reported, used if it ends failed. */
  error: string | null;
}

const FAILED_RUN_ERRORS: Partial<Record<OrchestrationV2RunStatus, string>> = {
  failed: "The run failed.",
  interrupted: "The run was interrupted.",
  cancelled: "The run was cancelled.",
  rolled_back: "The run was rolled back.",
};

/**
 * Follows dispatched scheduled runs to their first terminal outcome. A run is
 * found by the user message its dispatch stamped, then followed by its run
 * id, which survives a steering restart that replaces the message. In memory
 * only: a server restart forgets pending runs, and startup recovery records
 * them as interrupted.
 */
export function makeRunOutcomes() {
  const byMessage = new Map<MessageId, PendingRun>();
  const byRun = new Map<RunId, PendingRun>();
  const forgetTask = (taskId: ScheduledTaskId) => {
    for (const [id, run] of byMessage) if (run.taskId === taskId) byMessage.delete(id);
    for (const [id, run] of byRun) if (run.taskId === taskId) byRun.delete(id);
  };
  return {
    track: (messageId: MessageId, taskId: ScheduledTaskId, startedAtIso: string) => {
      // Only a task's latest run can update it, so an older run is dropped.
      forgetTask(taskId);
      byMessage.set(messageId, { messageId, taskId, startedAtIso, error: null });
    },
    forget: (messageId: MessageId) => {
      byMessage.delete(messageId);
      for (const [id, run] of byRun) if (run.messageId === messageId) byRun.delete(id);
    },
    /** Drops a deleted task's run, which may never report an end. */
    forgetTask,
    /** Folds in one domain event and returns the outcome once its run is terminal. */
    observe: (event: OrchestrationV2DomainEvent): RunOutcome | null => {
      if (byMessage.size === 0 && byRun.size === 0) return null;
      if (event.type === "turn-item.updated") {
        const item = event.payload;
        if (item.type !== "error" || item.runId === null) return null;
        const run = byRun.get(item.runId);
        if (run !== undefined) run.error = item.failure.message;
        return null;
      }
      if (event.type !== "run.created" && event.type !== "run.updated") return null;
      const runId = event.payload.id;
      let run = byRun.get(runId);
      if (run === undefined) {
        run = byMessage.get(event.payload.userMessageId);
        if (run === undefined) return null;
        byMessage.delete(event.payload.userMessageId);
        byRun.set(runId, run);
      }
      const status = event.payload.status;
      const settled = { taskId: run.taskId, startedAtIso: run.startedAtIso };
      if (status === "completed") {
        byRun.delete(runId);
        return { ...settled, status: "succeeded", error: null };
      }
      const failure = FAILED_RUN_ERRORS[status];
      if (failure === undefined) return null;
      byRun.delete(runId);
      // Only a failed run carries a provider error; an interrupt or cancel is the user's.
      return {
        ...settled,
        status: "failed",
        error: status === "failed" ? (run.error ?? failure) : failure,
      };
    },
  };
}
