import type { ProjectId, ThreadPullRequestLink } from "@t3tools/contracts";

export interface ComposerPullRequestMatch {
  readonly number: number;
  readonly projectId: string;
  readonly repository: string;
  readonly updatedAt: string;
}

/** A pull request linked to the thread, which the composer offers from any repository. */
export interface ComposerLinkedPullRequest {
  readonly repository: string;
  readonly number: number;
}

const normalizeRepository = (repository: string) => repository.trim().toLowerCase();

function isLinkedPullRequest(
  entry: ComposerPullRequestMatch,
  linked: ReadonlyArray<ComposerLinkedPullRequest>,
): boolean {
  const repository = normalizeRepository(entry.repository);
  return linked.some(
    (link) => link.number === entry.number && normalizeRepository(link.repository) === repository,
  );
}

/**
 * Pull requests matching the numeric fragment typed after `#`, de-duplicated per repository. A
 * pull request linked to the thread outranks the project's own, so `#4` offers the thread's
 * `owner/other#4` before an unrelated `#4` in the project's repository. Below that an exact
 * number match outranks a substring match so the result limit can never drop the pull request
 * the user typed in full; the rest stay newest first.
 */
export function filterComposerPullRequestMatches<Entry extends ComposerPullRequestMatch>(input: {
  readonly entries: ReadonlyArray<Entry>;
  readonly projectId: string;
  readonly repository: string;
  readonly query: string;
  readonly limit: number;
  /** Linked to the thread: matched from any repository and suggested first. */
  readonly linked?: ReadonlyArray<ComposerLinkedPullRequest>;
}): ReadonlyArray<Entry> {
  const repository = normalizeRepository(input.repository);
  const linked = input.linked ?? [];
  const matchingEntries = input.entries.filter(
    (entry) =>
      entry.projectId === input.projectId &&
      (normalizeRepository(entry.repository) === repository ||
        isLinkedPullRequest(entry, linked)) &&
      String(entry.number).includes(input.query),
  );
  const uniqueEntries = new Map<string, Entry>();
  for (const entry of matchingEntries) {
    const key = `${normalizeRepository(entry.repository)}#${entry.number}`;
    if (!uniqueEntries.has(key)) {
      uniqueEntries.set(key, entry);
    }
  }
  const isExactMatch = (entry: Entry) => String(entry.number) === input.query;
  // `.sort()` on a copy, not `.toSorted()`: this runs on Hermes, which has no ES2023 array
  // methods, and reaching for one here crashed the composer as the suggestions loaded.
  return [...uniqueEntries.values()]
    .sort((left, right) => {
      const linkage =
        Number(isLinkedPullRequest(right, linked)) - Number(isLinkedPullRequest(left, linked));
      if (linkage !== 0) return linkage;
      const exactness = Number(isExactMatch(right)) - Number(isExactMatch(left));
      return exactness !== 0 ? exactness : right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, input.limit);
}

/** A thread's linked pull request as the composer offers it, taken from the link's snapshot. */
export interface ComposerLinkedPullRequestEntry extends ComposerPullRequestMatch {
  readonly host: string;
  readonly title: string;
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: NonNullable<ThreadPullRequestLink["snapshot"]>["state"];
  readonly isDraft: boolean;
}

/**
 * Suggestion rows for the pull requests linked to a thread, from any repository. The listing the
 * composer searches only covers the project's own repository, so these are what let `#` reach a
 * pull request the thread opened elsewhere. A link the server has not synced yet has nothing to
 * show and is left out until it has.
 */
export function composerPullRequestEntriesFromLinks(
  links: ReadonlyArray<ThreadPullRequestLink>,
  projectId: ProjectId,
): ReadonlyArray<ComposerLinkedPullRequestEntry> {
  const entries: Array<ComposerLinkedPullRequestEntry> = [];
  for (const link of links) {
    if (link.snapshot === null) continue;
    entries.push({
      number: link.number,
      projectId,
      repository: link.repository,
      host: link.host,
      title: link.snapshot.title,
      url: link.url,
      headBranch: link.snapshot.headBranch,
      baseBranch: link.snapshot.baseBranch,
      state: link.snapshot.state,
      isDraft: link.snapshot.isDraft,
      updatedAt: link.snapshot.updatedAt ?? link.snapshot.syncedAt,
    });
  }
  return entries;
}

/** Whether every word of a text query appears in the pull request's number, title or branches. */
export function matchesComposerPullRequestWords(
  entry: Pick<ComposerLinkedPullRequestEntry, "number" | "title" | "headBranch" | "baseBranch">,
  query: string,
): boolean {
  const haystack =
    `#${entry.number} ${entry.title} ${entry.headBranch} ${entry.baseBranch}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** Whether two composer rows name the same pull request, whatever the repository's casing. */
export function isSameComposerPullRequest(
  left: Pick<ComposerPullRequestMatch, "repository" | "number">,
  right: Pick<ComposerPullRequestMatch, "repository" | "number">,
): boolean {
  return (
    left.number === right.number &&
    normalizeRepository(left.repository) === normalizeRepository(right.repository)
  );
}
