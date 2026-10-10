import { assert, it } from "@effect/vitest";
import { MessageId, ScheduledTaskId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";

import { makeRunOutcomes } from "./RunOutcomes.ts";

const runEvent = (messageId: string, status: string): OrchestrationV2DomainEvent =>
  ({
    type: "run.updated",
    payload: { id: "run:scheduled", userMessageId: messageId, status },
  }) as never;

it("forgets a deleted task's run before and after it was matched to a run id", () => {
  const outcomes = makeRunOutcomes();
  const taskId = ScheduledTaskId.make("task");
  outcomes.track(MessageId.make("message:a"), taskId, "2026-09-09T12:00:00.000Z");
  outcomes.forgetTask(taskId);
  assert.isNull(outcomes.observe(runEvent("message:a", "completed")));

  outcomes.track(MessageId.make("message:b"), taskId, "2026-09-09T12:01:00.000Z");
  assert.isNull(outcomes.observe(runEvent("message:b", "running")));
  outcomes.forgetTask(taskId);
  assert.isNull(outcomes.observe(runEvent("message:b", "completed")));
});

it("reports only the first terminal outcome of a run", () => {
  const outcomes = makeRunOutcomes();
  outcomes.track(
    MessageId.make("message:a"),
    ScheduledTaskId.make("task"),
    "2026-09-09T12:00:00.000Z",
  );
  assert.equal(outcomes.observe(runEvent("message:a", "completed"))?.status, "succeeded");
  assert.isNull(outcomes.observe(runEvent("message:a", "rolled_back")));
});

it("forgets a failed dispatch whose run was already created", () => {
  const outcomes = makeRunOutcomes();
  const messageId = MessageId.make("message:a");
  outcomes.track(messageId, ScheduledTaskId.make("task"), "2026-09-09T12:00:00.000Z");
  assert.isNull(
    outcomes.observe({ ...runEvent("message:a", "queued"), type: "run.created" } as never),
  );
  outcomes.forget(messageId);
  assert.isNull(outcomes.observe(runEvent("message:a", "completed")));
});
