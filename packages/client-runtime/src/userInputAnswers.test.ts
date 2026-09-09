import { describe, expect, it } from "vite-plus/test";

import { formatUserInputAnswers, readUserInputQuestions } from "./userInputAnswers.ts";

const questions = readUserInputQuestions({
  questions: [
    { id: "approach", header: "Approach", question: "How should we proceed?", options: [] },
    { id: "scope", header: "Scope", question: "Which areas?", options: [], multiSelect: true },
  ],
});

describe("formatUserInputAnswers", () => {
  it("lists one line per question in the order asked, joining multi-select answers", () => {
    expect(
      formatUserInputAnswers(questions, {
        scope: ["Server", "Web"],
        approach: "Ship the minimal fix",
      }),
    ).toBe("Approach: Ship the minimal fix\nScope: Server, Web");
  });

  it("keeps answers whose question is unknown and skips blank ones", () => {
    expect(formatUserInputAnswers(questions, { approach: "  ", extra: "Free text" })).toBe(
      "extra: Free text",
    );
    expect(formatUserInputAnswers([], { note: "typed by hand" })).toBe("note: typed by hand");
  });

  it("returns nothing for answers it cannot show", () => {
    expect(formatUserInputAnswers(questions, undefined)).toBeUndefined();
    expect(formatUserInputAnswers(questions, {})).toBeUndefined();
    expect(readUserInputQuestions({ questions: "nope" })).toEqual([]);
  });

  it("keeps the questions it can read when a request row carries a malformed one", () => {
    const asked = readUserInputQuestions({
      questions: [
        { id: "approach", header: "Approach", question: "How should we proceed?" },
        { header: "No id" },
        { id: "scope", header: "Scope", question: "Which areas?", options: [], multiSelect: true },
      ],
    });
    expect(asked.map((question) => question.id)).toEqual(["approach", "scope"]);
    expect(formatUserInputAnswers(asked, { approach: "Minimal", scope: ["Web"] })).toBe(
      "Approach: Minimal\nScope: Web",
    );
  });
});
