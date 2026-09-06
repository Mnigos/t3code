import type { UserInputQuestion } from "@t3tools/contracts";

type UserInputQuestionLike = Pick<UserInputQuestion, "id" | "header" | "question">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The questions a `user-input.requested` payload carried, read structurally
 * so a row from an older server (or one with the questions stripped) still
 * yields an empty list rather than throwing.
 */
export function readUserInputQuestions(payload: unknown): ReadonlyArray<UserInputQuestionLike> {
  const questions = isRecord(payload) ? payload.questions : undefined;
  if (!Array.isArray(questions)) return [];
  const result: UserInputQuestionLike[] = [];
  for (const question of questions) {
    if (!isRecord(question)) continue;
    const id = nonEmpty(question.id);
    if (!id) continue;
    result.push({
      id,
      header: nonEmpty(question.header) ?? "",
      question: nonEmpty(question.question) ?? "",
    });
  }
  return result;
}

function formatAnswer(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value.map(formatAnswer).filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  if (typeof value === "string") return nonEmpty(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isRecord(value)) return JSON.stringify(value);
  return undefined;
}

/**
 * The submitted answers as one `Question: answer` line per question, in the
 * order they were asked; multi-select answers join with commas. Answers whose
 * question is unknown (older history, keys the provider chose) still list
 * under their key so nothing the user typed goes missing.
 */
export function formatUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestionLike>,
  answers: unknown,
): string | undefined {
  if (!isRecord(answers)) return undefined;
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const question of questions) {
    seen.add(question.id);
    const answer = formatAnswer(answers[question.id]);
    if (answer === undefined) continue;
    const label = question.header || question.question || question.id;
    lines.push(`${label}: ${answer}`);
  }
  for (const [key, value] of Object.entries(answers)) {
    if (seen.has(key)) continue;
    const answer = formatAnswer(value);
    if (answer !== undefined) lines.push(`${key}: ${answer}`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}
