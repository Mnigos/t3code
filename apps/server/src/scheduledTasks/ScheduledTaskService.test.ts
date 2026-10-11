import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ScheduledTaskError,
  MessageId,
  ScheduledTaskId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";

import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const isScheduledTaskError = Schema.is(ScheduledTaskError);

const insertRow = (
  sql: SqlClient.SqlClient,
  row: {
    id: string | null;
    next: string | null;
    enabled: number;
    status: string;
    scheduleJson?: string;
    prompt?: string;
    threadId?: string;
    runCount?: number;
  },
  now: string,
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: row.id,
    title: "task",
    prompt: row.prompt ?? "Run task",
    enabled: row.enabled,
    schedule_json: row.scheduleJson ?? '{"type":"interval","everyMs":60000}',
    project_id: "project:test",
    thread_id: row.threadId ?? null,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: now,
    updated_at: now,
    next_run_at: row.next,
    last_run_at: null,
    last_run_status: row.status,
    last_run_error: null,
    run_count: row.runCount ?? 0,
  })}`;

it.effect("loads only due tasks and skips corrupt due rows without decoding settled tasks", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    const secret = "PROMPT-SECRET-DO-NOT-LOG";
    const credential = "CREDENTIAL-SECRET-DO-NOT-LOG";
    for (const row of [
      { id: "due-now", next: now, enabled: 1, status: "never" },
      // Ids that cannot decode as ScheduledTaskId — empty, whitespace-only,
      // and NULL (SQLite's TEXT primary key admits it).
      { id: "", next: now, enabled: 1, status: "never" },
      { id: "   ", next: now, enabled: 1, status: "never" },
      { id: null, next: now, enabled: 1, status: "never" },
      {
        id: "due-earlier",
        next: "2026-09-09T11:00:00.000Z",
        enabled: 1,
        status: "failed",
      },
      // An unparseable next_run_at sorts before every real timestamp, so it
      // passes the due filter and would defect the poll if not skipped.
      { id: "due-bad-date", next: "", enabled: 1, status: "never" },
      {
        id: "due-corrupt",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "due-cred",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: `{"type":"interval","everyMs":"${credential}"}`,
      },
      { id: "disabled", next: now, enabled: 0, status: "never", scheduleJson: "broken" },
      {
        id: "future",
        next: "2026-09-09T12:00:00.001Z",
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "unscheduled",
        next: null,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      // A run whose turn is still in flight does not hold back the schedule.
      { id: "running", next: now, enabled: 1, status: "running" },
    ]) {
      yield* insertRow(sql, { ...row, prompt: secret }, now);
    }
    const warnings: unknown[] = [];
    const tasks = yield* ScheduledTaskService.listDueTasks(DateTime.makeUnsafe(now)).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            warnings.push(message);
          }),
        ]),
      ),
    );
    assert.deepEqual(
      tasks.map((task) => task.id),
      ["due-earlier", "due-now", "running"],
    );
    // Corrupt rows sort between the healthy due rows; each is skipped with a
    // warning instead of stopping the poll.
    assert.equal(warnings.length, 6);
    const annotations = warnings.map(
      (warning) => (warning as ReadonlyArray<unknown>)[1] as Record<string, unknown>,
    );
    assert.deepEqual(
      annotations.map((annotation) => annotation.taskId),
      ["due-bad-date", null, "", "   ", "due-corrupt", "due-cred"],
    );
    // The typed diagnostic carries a taskId only when the stored id itself
    // decodes; the corrupt-id rows are still skipped, not fatal.
    const causes = annotations.map((annotation) => annotation.cause);
    assert.deepEqual(
      causes.map((cause) => (isScheduledTaskError(cause) ? cause.taskId : undefined)),
      [undefined, undefined, undefined, undefined, "due-corrupt", "due-cred"],
    );
    for (const cause of causes) {
      if (cause !== undefined) assert.isTrue(isScheduledTaskError(cause));
    }
    const rendered = NodeUtil.inspect(annotations, { depth: null });
    assert.isFalse(rendered.includes(secret));
    assert.isFalse(rendered.includes(credential));
    const running = yield* sql<{
      last_run_status: string;
    }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'running'`;
    assert.equal(running[0]?.last_run_status, "running");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "releases interrupted runs on startup and still executes due tasks, skipping corrupt rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      // An interval that decodes but overflows the representable DateTime
      // range must not defect recovery or the poll.
      const hugeInterval = '{"type":"interval","everyMs":9000000000000000}';
      for (const row of [
        // A reserved run was counted by markRunning; recovery must not count it again.
        { id: "stuck-valid", next: now, status: "running", runCount: 1 },
        {
          id: "stuck-corrupt",
          next: now,
          status: "running",
          scheduleJson: "broken",
          runCount: 1,
        },
        {
          id: "stuck-huge",
          next: now,
          status: "running",
          scheduleJson: hugeInterval,
          runCount: 1,
        },
        { id: null, next: now, status: "running", runCount: 1 },
        // A due row with an unparseable next_run_at must not defect the poll
        // before the healthy due tasks run.
        { id: "due-bad-date", next: "", status: "never" },
        { id: "due-healthy", next: now, status: "never" },
        { id: "due-huge", next: now, status: "never", scheduleJson: hugeInterval },
        { id: "due-second", next: now, status: "never" },
        { id: "due-third", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }

      // it.effect freezes the clock; pin it just past the seeded due time so
      // the poll sees the rows as due.
      yield* TestClock.setTime(Date.parse(now) + 1_000);
      // Runs are dispatched serially, so the fourth dispatch can only happen
      // after the first three runs' completions were recorded — a drain
      // receipt for the poll fiber, never a sleep. The fourth launch is held
      // open so its in-flight state is observed deterministically.
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 4
                          ? Deferred.succeed(lastDispatched, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseLast)),
                            )
                          : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          // The poll loop delays before its first pass, so the frozen test
          // clock must advance once to trigger it.
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          // The fourth dispatch implies the first three completions landed;
          // markRunning commits before dispatch, so due-third is 'running'.
          const inflight = yield* sql<{
            last_run_status: string;
          }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'due-third'`;
          assert.equal(inflight[0]?.last_run_status, "running");
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );

      const rows = yield* sql<{
        task_id: string | null;
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
      }>`SELECT task_id, last_run_status, last_run_error, next_run_at, run_count
       FROM scheduled_tasks ORDER BY task_id`;
      const byId = new Map(rows.map((row) => [row.task_id, row]));
      assert.equal(rows.length, 9);
      // The decodable stuck run is rescheduled for its next occurrence; the
      // undecodable and unrepresentable rows are released without a next run.
      // A NULL id must still match its own row — `= NULL` never does.
      assert.equal(byId.get("stuck-valid")?.last_run_status, "failed");
      assert.isNotNull(byId.get("stuck-valid")?.next_run_at);
      assert.equal(byId.get("stuck-corrupt")?.last_run_status, "failed");
      assert.equal(byId.get(null)?.last_run_status, "failed");
      const stuckHuge = byId.get("stuck-huge");
      assert.equal(stuckHuge?.last_run_status, "failed");
      assert.isNull(stuckHuge?.next_run_at);
      for (const id of ["stuck-valid", "stuck-corrupt", "stuck-huge", null]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_error, "Run was interrupted by a server restart.");
        assert.equal(row?.run_count, 1);
      }
      // The healthy due tasks were dispatched and recorded failed runs; the
      // corrupt due row was skipped without running.
      for (const id of ["due-healthy", "due-huge", "due-second"]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_status, "failed");
        assert.isTrue(row?.last_run_error?.includes("test launch failure") === true);
        assert.equal(row?.run_count, 1);
      }
      assert.isNull(byId.get("due-huge")?.next_run_at);
      assert.equal(byId.get("due-bad-date")?.last_run_status, "never");
      assert.equal(byId.get("due-bad-date")?.run_count, 0);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "treats a next_run_at corrupted before the dispatch re-read as not due instead of defecting the poll",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      // Equal next_run_at means dispatch order follows task_id order.
      for (const row of [
        { id: "run-a", next: now, status: "never" },
        { id: "run-b-victim", next: now, status: "never" },
        { id: "run-c", next: now, status: "never" },
        { id: "run-d", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }
      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      // A concurrent writer (the CLI shares the SQLite file)
                      // corrupts the next row between the poll read and its
                      // dispatch re-read. Serial dispatch makes the
                      // interleaving deterministic.
                      Effect.andThen((n) =>
                        n === 1
                          ? sql`UPDATE scheduled_tasks
                                SET next_run_at = ''
                                WHERE task_id = 'run-b-victim'`.pipe(Effect.asVoid, Effect.orDie)
                          : n === 3
                            ? Deferred.succeed(lastDispatched, undefined).pipe(
                                Effect.andThen(Deferred.await(releaseLast)),
                              )
                            : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          yield* TestClock.adjust("6 seconds");
          // The third dispatch (run-d) can only happen after the victim's
          // re-read was handled — a receipt that the poll fiber survived.
          yield* Deferred.await(lastDispatched);
          assert.equal(yield* Ref.get(dispatched), 3);
          const rows = yield* sql<{
            task_id: string;
            last_run_status: string;
            next_run_at: string | null;
            run_count: number;
          }>`SELECT task_id, last_run_status, next_run_at, run_count
             FROM scheduled_tasks ORDER BY task_id`;
          const byId = new Map(rows.map((row) => [row.task_id, row]));
          const victim = byId.get("run-b-victim");
          assert.equal(victim?.last_run_status, "never");
          assert.equal(victim?.run_count, 0);
          assert.equal(victim?.next_run_at, "");
          for (const id of ["run-a", "run-c"]) {
            const row = byId.get(id);
            assert.equal(row?.last_run_status, "failed");
            assert.equal(row?.run_count, 1);
          }
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

type Service = ScheduledTaskService.ScheduledTaskService["Service"];

/**
 * A service whose dispatches succeed and whose domain-event stream is fed by
 * the test, so a run's terminal outcome can be delivered after dispatch.
 * `onDispatch` runs inside each dispatch, before it returns.
 */
const withRunEvents = <A, E>(
  body: (input: {
    readonly service: Service;
    readonly dispatched: Queue.Queue<MessageId>;
    readonly emit: (events: ReadonlyArray<OrchestrationV2DomainEvent>) => Effect.Effect<void>;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
  onDispatch?: (input: {
    readonly messageId: MessageId;
    readonly service: Service;
    readonly emit: (events: ReadonlyArray<OrchestrationV2DomainEvent>) => Effect.Effect<void>;
  }) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const emit = (batch: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Queue.offerAll(events, batch).pipe(Effect.asVoid);
    const dispatched = yield* Queue.unbounded<MessageId>();
    const serviceReady = yield* Deferred.make<Service>();
    const dispatch = (messageId: MessageId) =>
      Queue.offer(dispatched, messageId).pipe(
        Effect.andThen(
          onDispatch === undefined
            ? Effect.void
            : Deferred.await(serviceReady).pipe(
                Effect.flatMap((service) => onDispatch({ messageId, service, emit })),
              ),
        ),
      );
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              dispatch(input.initialMessage!.messageId!).pipe(
                Effect.as({ threadId: "thread:launched", resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) => dispatch(input.messageId).pipe(Effect.as({} as never)),
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* Deferred.succeed(serviceReady, service);
      return yield* body({ service, dispatched, emit });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

/** Starts a second service on the same database, as a server restart does. */
const restartService = Effect.scoped(
  Layer.build(
    Layer.fresh(ScheduledTaskService.layer).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            streamDomainEvents: Stream.never,
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    ),
  ),
);

const readRun = (sql: SqlClient.SqlClient, id: string) =>
  sql<{
    last_run_status: string;
    last_run_error: string | null;
    next_run_at: string | null;
    run_count: number;
  }>`SELECT last_run_status, last_run_error, next_run_at, run_count
     FROM scheduled_tasks WHERE task_id = ${id}`.pipe(Effect.map((rows) => rows[0]));

const runEvent = (
  messageId: MessageId,
  status: OrchestrationV2Run["status"],
  runId = "run:scheduled",
): OrchestrationV2DomainEvent =>
  ({
    type: "run.updated",
    threadId: "thread:bound",
    runId,
    payload: { id: runId, userMessageId: messageId, status },
  }) as never;

const errorItemEvent = (message: string): OrchestrationV2DomainEvent =>
  ({
    type: "turn-item.updated",
    threadId: "thread:bound",
    runId: "run:scheduled",
    payload: {
      type: "error",
      runId: "run:scheduled",
      status: "failed",
      failure: { class: "usage_limit", message, code: null, retryable: false },
    },
  }) as never;

/** The task as the service next publishes it outside of an in-flight run. */
const settledTask = (service: ScheduledTaskService.ScheduledTaskService["Service"], id: string) =>
  service.subscribeList().pipe(
    Stream.map(({ tasks }) => tasks.find((task) => task.id === id)),
    Stream.filter((task) => task !== undefined && task.lastRunStatus !== "running"),
    Stream.runHead,
    Effect.map((task) => Option.getOrThrow(task)!),
  );

it.effect("records a bound run whose turn fails as failed with the provider error", () =>
  withRunEvents(({ service, dispatched, emit }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      yield* insertRow(
        sql,
        { id: "bound", next: null, enabled: 1, status: "never", threadId: "thread:bound" },
        now,
      );
      yield* service.runNow({ id: ScheduledTaskId.make("bound") });
      const messageId = yield* Queue.take(dispatched);
      yield* emit([
        runEvent(messageId, "running"),
        errorItemEvent("You've hit your weekly usage limit."),
        runEvent(messageId, "failed"),
      ]);
      const task = yield* settledTask(service, "bound");
      assert.equal(task.lastRunStatus, "failed");
      assert.equal(task.lastRunError, "You've hit your weekly usage limit.");
      assert.equal(task.runCount, 1);
    }),
  ),
);

it.effect("records a bound run as running until its turn completes, then succeeded", () =>
  withRunEvents(({ service, dispatched, emit }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      yield* insertRow(
        sql,
        { id: "bound", next: null, enabled: 1, status: "never", threadId: "thread:bound" },
        now,
      );
      const { task: dispatchedTask } = yield* service.runNow({ id: ScheduledTaskId.make("bound") });
      assert.equal(dispatchedTask.lastRunStatus, "running");
      const messageId = yield* Queue.take(dispatched);
      const [row] = yield* sql<{
        last_run_status: string;
        next_run_at: string | null;
        run_count: number;
      }>`
        SELECT last_run_status, next_run_at, run_count FROM scheduled_tasks WHERE task_id = 'bound'`;
      // The schedule moves on at dispatch; only the status waits for the turn.
      assert.equal(row?.last_run_status, "running");
      assert.isNotNull(row?.next_run_at);
      assert.equal(row?.run_count, 1);
      yield* emit([runEvent(messageId, "running"), runEvent(messageId, "completed")]);
      const task = yield* settledTask(service, "bound");
      assert.equal(task.lastRunStatus, "succeeded");
      assert.isNull(task.lastRunError);
      assert.equal(task.runCount, 1);
    }),
  ),
);

it.effect.each([
  { status: "interrupted", error: "The run was interrupted." },
  { status: "cancelled", error: "The run was cancelled." },
  { status: "failed", error: "The run failed." },
] as const)("records a run whose turn ends $status as failed", ({ status, error }) =>
  withRunEvents(({ service, dispatched, emit }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertRow(
        sql,
        { id: "bound", next: null, enabled: 1, status: "never", threadId: "thread:bound" },
        "2026-09-09T12:00:00.000Z",
      );
      yield* service.runNow({ id: ScheduledTaskId.make("bound") });
      yield* emit([runEvent(yield* Queue.take(dispatched), status)]);
      const task = yield* settledTask(service, "bound");
      assert.equal(task.lastRunStatus, "failed");
      assert.equal(task.lastRunError, error);
    }),
  ),
);

it.effect("records an unbound run whose turn outcome lands before its dispatch is recorded", () =>
  withRunEvents(
    ({ service }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertRow(
          sql,
          { id: "unbound", next: null, enabled: 1, status: "never" },
          "2026-09-09T12:00:00.000Z",
        );
        const { task: returned } = yield* service.runNow({ id: ScheduledTaskId.make("unbound") });
        // runNow reports the outcome that was already recorded, not the dispatch.
        assert.equal(returned.lastRunStatus, "failed");
        assert.equal(returned.lastRunError, "The run failed.");
        assert.isNotNull(returned.nextRunAt);
        assert.equal(returned.runCount, 1);
        // markDispatched ran after the outcome and kept it, while still
        // moving the schedule on; the run is counted once.
        const row = yield* readRun(sql, "unbound");
        assert.equal(row?.last_run_status, "failed");
        assert.equal(row?.last_run_error, "The run failed.");
        assert.isNotNull(row?.next_run_at);
        assert.equal(row?.run_count, 1);
      }),
    // The launch returns only once the outcome was recorded (the list receipt).
    ({ messageId, service, emit }) =>
      emit([runEvent(messageId, "starting"), runEvent(messageId, "failed")]).pipe(
        Effect.andThen(settledTask(service, "unbound")),
        Effect.asVoid,
        Effect.orDie,
      ),
  ),
);

it.effect("follows a run through a steering restart that replaces its message", () =>
  withRunEvents(({ service, dispatched, emit }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertRow(
        sql,
        { id: "bound", next: null, enabled: 1, status: "never", threadId: "thread:bound" },
        "2026-09-09T12:00:00.000Z",
      );
      yield* service.runNow({ id: ScheduledTaskId.make("bound") });
      const scheduled = yield* Queue.take(dispatched);
      const steer = MessageId.make("message:steer");
      // The restart keeps the run id and swaps in the steering message; the
      // superseded attempt reports no terminal run event of its own.
      yield* emit([
        { ...runEvent(scheduled, "queued"), type: "run.created" } as never,
        runEvent(scheduled, "running"),
        runEvent(steer, "starting"),
        runEvent(steer, "running"),
        errorItemEvent("You've hit your weekly usage limit."),
        runEvent(steer, "failed"),
      ]);
      const task = yield* settledTask(service, "bound");
      assert.equal(task.lastRunStatus, "failed");
      assert.equal(task.lastRunError, "You've hit your weekly usage limit.");
    }),
  ),
);

it.effect("counts a run once when the server restarts while its dispatch is in flight", () =>
  Effect.gen(function* () {
    const inFlight = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* withRunEvents(
      ({ service }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* insertRow(
            sql,
            { id: "bound", next: null, enabled: 1, status: "never", threadId: "thread:bound" },
            "2026-09-09T12:00:00.000Z",
          );
          const run = yield* Effect.forkChild(
            service.runNow({ id: ScheduledTaskId.make("bound") }),
          );
          yield* Deferred.await(inFlight);
          // The reservation already counted the run.
          assert.equal((yield* readRun(sql, "bound"))?.run_count, 1);
          yield* restartService;
          const recovered = yield* readRun(sql, "bound");
          assert.equal(recovered?.last_run_status, "failed");
          assert.equal(recovered?.last_run_error, "Run was interrupted by a server restart.");
          assert.equal(recovered?.run_count, 1);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(run);
          assert.equal((yield* readRun(sql, "bound"))?.run_count, 1);
        }),
      () => Deferred.succeed(inFlight, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
  }),
);

it.effect("counts a run once when the server restarts while its turn is in flight", () =>
  withRunEvents(({ service }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertRow(
        sql,
        { id: "bound", next: null, enabled: 1, status: "never", threadId: "thread:bound" },
        "2026-09-09T12:00:00.000Z",
      );
      yield* service.runNow({ id: ScheduledTaskId.make("bound") });
      assert.equal((yield* readRun(sql, "bound"))?.run_count, 1);
      yield* restartService;
      const recovered = yield* readRun(sql, "bound");
      assert.equal(recovered?.last_run_status, "failed");
      assert.equal(recovered?.last_run_error, "Run was interrupted by a server restart.");
      assert.equal(recovered?.run_count, 1);
    }),
  ),
);

it.effect("drops an earlier run's outcome once a newer run of the task starts", () =>
  withRunEvents(({ service, dispatched, emit }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertRow(
        sql,
        { id: "bound", next: null, enabled: 1, status: "never", threadId: "thread:bound" },
        "2026-09-09T12:00:00.000Z",
      );
      yield* service.runNow({ id: ScheduledTaskId.make("bound") });
      const first = yield* Queue.take(dispatched);
      yield* TestClock.adjust("1 second");
      yield* service.runNow({ id: ScheduledTaskId.make("bound") });
      const second = yield* Queue.take(dispatched);
      yield* emit([
        runEvent(first, "completed", "run:first"),
        runEvent(second, "interrupted", "run:second"),
      ]);
      const task = yield* settledTask(service, "bound");
      assert.equal(task.lastRunStatus, "failed");
      assert.equal(task.lastRunError, "The run was interrupted.");
      assert.equal(task.runCount, 2);
    }),
  ),
);
