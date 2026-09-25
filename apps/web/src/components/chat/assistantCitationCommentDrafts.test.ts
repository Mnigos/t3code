import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantCitationDraftKey,
  clearAssistantCitationCommentDraftsForComposer,
  readAssistantCitationCommentDraft,
  writeAssistantCitationCommentDraft,
} from "./assistantCitationCommentDrafts";

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};
const other: AssistantCitation = { ...citation, text: "world", start: 6, end: 11 };

describe("assistantCitationDraftKey", () => {
  it("is the same for the same citation whatever nodes come before it", () => {
    expect(assistantCitationDraftKey(citation, [])).toBe(
      assistantCitationDraftKey(citation, [other]),
    );
  });

  it("tells identical citations apart by their order in the document", () => {
    const first = assistantCitationDraftKey(citation, []);
    const second = assistantCitationDraftKey(citation, [citation]);
    const third = assistantCitationDraftKey(citation, [other, citation, citation]);
    expect(new Set([first, second, third]).size).toBe(3);
    // The same prompt rebuilt in the same order yields the same keys again.
    expect(assistantCitationDraftKey(citation, [citation])).toBe(second);
  });

  it("keeps the same citation apart across composers", () => {
    expect(assistantCitationDraftKey(citation, [], "thread-a")).not.toBe(
      assistantCitationDraftKey(citation, [], "thread-b"),
    );
  });
});

describe("clearAssistantCitationCommentDraftsForComposer", () => {
  it("drops the sent composer's drafts and keeps every other composer's", () => {
    const sent = assistantCitationDraftKey(citation, [], "thread-a");
    const sentDuplicate = assistantCitationDraftKey(citation, [citation], "thread-a");
    const elsewhere = assistantCitationDraftKey(citation, [], "thread-b");
    writeAssistantCitationCommentDraft(sent, "first");
    writeAssistantCitationCommentDraft(sentDuplicate, "second");
    writeAssistantCitationCommentDraft(elsewhere, "other");

    clearAssistantCitationCommentDraftsForComposer("thread-a");

    expect(readAssistantCitationCommentDraft(sent)).toBeNull();
    expect(readAssistantCitationCommentDraft(sentDuplicate)).toBeNull();
    expect(readAssistantCitationCommentDraft(elsewhere)).toBe("other");
  });
});
