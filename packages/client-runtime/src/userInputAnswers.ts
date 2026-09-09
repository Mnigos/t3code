import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { UserInputQuestion } from "@t3tools/contracts";

// Older request rows can carry less than the current contract, so each
// question decodes on its own and a malformed one does not hide the rest.
// Question ids are the answer keys, so they are read as-is and never trimmed.
const decodeAskedQuestion = Schema.decodeUnknownOption(
  Schema.Struct({ id: Schema.String, header: Schema.String, question: Schema.String }),
);
const decodeAskedQuestions = Schema.decodeUnknownOption(
  Schema.Struct({ questions: Schema.Array(Schema.Unknown) }),
);

type AskedQuestion = Pick<UserInputQuestion, "id" | "header" | "question">;

/** The questions a `user-input.requested` payload asked, in order. */
export function readUserInputQuestions(payload: unknown): ReadonlyArray<AskedQuestion> {
  return Option.match(decodeAskedQuestions(payload), {
    onNone: () => [],
    onSome: ({ questions }) =>
      questions.flatMap((question) => Option.toArray(decodeAskedQuestion(question))),
  });
}

function formatAnswer(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value.map(formatAnswer).filter(Predicate.isString);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  if (Predicate.isString(value)) return value.trim() || undefined;
  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) return String(value);
  if (Predicate.isObject(value)) return JSON.stringify(value);
  return undefined;
}

/**
 * The submitted answers as one `Question: answer` line per question, in the
 * order they were asked; multi-select answers join with commas. Answers whose
 * question is unknown (older history, keys the provider chose) still list
 * under their key so nothing the user typed goes missing.
 */
export function formatUserInputAnswers(
  questions: ReadonlyArray<AskedQuestion>,
  answers: unknown,
): string | undefined {
  if (!Predicate.isObject(answers)) return undefined;
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
