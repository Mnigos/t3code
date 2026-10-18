import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
}));

vi.mock(import("@t3tools/client-runtime/state/thread-workflows"), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => state.projection) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async () => undefined) as never,
}));

vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`)) as never,
}));

import { QueuedRunsControl } from "./QueuedRunsControl";

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

async function render(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<QueuedRunsControl {...baseProps} {...props} />));
  return container;
}

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("[aria-label]")].map((element) =>
    element.getAttribute("aria-label"),
  );

describe("QueuedRunsControl automatic completion delivery", () => {
  it("does not render a queue control when only hidden delivery remains", async () => {
    state.projection = {
      projection: {
        messages: [
          {
            delegatedCompletion: {
              parentRunId: "run:parent",
              generation: 1,
              taskIds: ["task:child"],
            },
            id: "message:completion",
          },
        ],
      },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const view = await render();

    expect(view.childElementCount).toBe(0);
  });
});

describe("QueuedRunsControl attachments and edit mode", () => {
  const workflowWithAttachment = () => ({
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Queued with a screenshot",
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 128,
          },
        ],
      },
    ],
  });

  it("renders an attachment thumbnail on the queued row", async () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const view = await render();

    expect(view.querySelector("img")?.getAttribute("src")).toBe("https://assets.test/attachment-1");
    expect(view.textContent).toContain("Queued with a screenshot");
    expect(labels(view)).toContain("Edit queued message");
    expect(labels(view)).toContain("Reorder queued message (drag, or press the arrow keys)");
    expect(labels(view)).not.toContain("Move queued message up");
  });

  it("drops the optimistic pending row once the projection holds its message", async () => {
    state.projection = {
      projection: { messages: [{ id: "message:acknowledged", text: "hello" }] },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const view = await render({
      optimisticMessages: [
        {
          id: "message:acknowledged" as never,
          inputIntent: "queued_turn",
          text: "hello",
          attachments: [],
        },
      ],
    });

    expect(view.childElementCount).toBe(0);
  });

  it("keeps the original queued message visible while editing", async () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const view = await render({ editingRunId: "run:queued" as never });

    expect(view.textContent).toContain("Queued with a screenshot");
  });
});

describe("QueuedRunsControl assistant quotes", () => {
  const quote = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("environment:test"),
    threadId: ThreadId.make("thread:test"),
    messageId: MessageId.make("message:assistant"),
    text: "Cache the parsed config per worktree.",
    start: 0,
    end: 37,
    prefix: "",
    suffix: "",
  });
  const quoteAndText = `${quote}\n\nWhy per worktree?`;

  const quotedWorkflow = () => ({
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:quote-only", userMessageId: "message:quote-only" },
        text: quote,
        attachments: [],
      },
      {
        run: { id: "run:quote-and-text", userMessageId: "message:quote-and-text" },
        text: quoteAndText,
        attachments: [],
      },
    ],
  });

  it("previews quote-only and quote-plus-text items by their quoted text", async () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = quotedWorkflow();

    const view = await render();
    const [quoteOnlyRow, quoteAndTextRow] = view.querySelectorAll("li");

    expect(quoteOnlyRow?.textContent).toContain("Cache the parsed config per worktree.");
    expect(quoteAndTextRow?.textContent).toContain("Cache the parsed config per worktree.");
    expect(quoteAndTextRow?.textContent).toContain("Why per worktree?");
    expect(view.textContent).not.toContain("t3-citation:");
    expect(view.textContent).not.toContain("Assistant quote");
  });

  it("edits the original message so the citation link survives", async () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = quotedWorkflow();
    const onEditQueuedRun = vi.fn();

    const view = await render({ onEditQueuedRun });
    const editButton = view
      .querySelectorAll("li")[1]
      ?.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]');
    await act(async () => editButton?.click());

    expect(onEditQueuedRun).toHaveBeenCalledWith({
      runId: "run:quote-and-text",
      messageId: "message:quote-and-text",
      text: quoteAndText,
      attachments: [],
    });
  });
});
