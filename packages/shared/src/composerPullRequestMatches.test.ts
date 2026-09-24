import { describe, expect, it } from "vite-plus/test";

import type { ProjectId, ThreadPullRequestLink } from "@t3tools/contracts";

import {
  composerPullRequestEntriesFromLinks,
  filterComposerPullRequestMatches,
  matchesComposerPullRequestWords,
} from "./composerPullRequestMatches.ts";

const entry = (number: number, updatedAt: string) => ({
  number,
  projectId: "p1",
  host: "github.com",
  repository: "owner/repo",
  updatedAt,
});

describe("filterComposerPullRequestMatches", () => {
  it("ranks the exact number above newer substring matches", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(1234, "2026-01-03"), entry(123, "2026-01-01"), entry(1230, "2026-01-02")],
      projectId: "p1",
      repository: "owner/repo",
      query: "123",
      limit: 10,
    });
    expect(result.map((match) => match.number)).toEqual([123, 1234, 1230]);
  });

  it("leaves the caller's array untouched", () => {
    // The sort runs on a copy; mutating the input would reorder whatever the caller holds.
    const entries = [entry(2, "2026-01-01"), entry(1, "2026-01-02")];
    const snapshot = entries.map((match) => match.number);
    filterComposerPullRequestMatches({
      entries,
      projectId: "p1",
      repository: "owner/repo",
      query: "",
      limit: 10,
    });
    expect(entries.map((match) => match.number)).toEqual(snapshot);
  });

  it("offers a pull request linked to the thread from another repository, first", () => {
    const linked = {
      number: 4,
      projectId: "p1",
      host: "github.com",
      repository: "owner/other",
      updatedAt: "2026-01-01",
    };
    const result = filterComposerPullRequestMatches({
      entries: [entry(4, "2026-01-05"), entry(40, "2026-01-04"), linked],
      projectId: "p1",
      repository: "owner/repo",
      query: "4",
      limit: 10,
      linked: [{ host: "GitHub.com", repository: "Owner/Other", number: 4 }],
    });
    expect(result.map((match) => `${match.repository}#${match.number}`)).toEqual([
      "owner/other#4",
      "owner/repo#4",
      "owner/repo#40",
    ]);
  });

  it("leaves other repositories out unless the thread links them", () => {
    const result = filterComposerPullRequestMatches({
      entries: [
        {
          number: 4,
          projectId: "p1",
          host: "github.com",
          repository: "owner/other",
          updatedAt: "2026-01-01",
        },
      ],
      projectId: "p1",
      repository: "owner/repo",
      query: "4",
      limit: 10,
      linked: [{ host: "github.com", repository: "owner/other", number: 5 }],
    });
    expect(result).toHaveLength(0);
  });

  it("de-duplicates and honours the limit", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(7, "2026-01-02"), entry(7, "2026-01-01"), entry(8, "2026-01-03")],
      projectId: "p1",
      repository: "owner/repo",
      query: "",
      limit: 1,
    });
    expect(result).toHaveLength(1);
  });

  it("keeps same-numbered pull requests from different repositories apart", () => {
    const other = {
      number: 7,
      projectId: "p1",
      host: "github.com",
      repository: "owner/other",
      updatedAt: "2026-01-01",
    };
    const result = filterComposerPullRequestMatches({
      entries: [entry(7, "2026-01-02"), other],
      projectId: "p1",
      repository: "owner/repo",
      query: "7",
      limit: 10,
      linked: [other],
    });
    expect(result).toHaveLength(2);
  });

  it("folds the project's own hostless lookup row into the listed one", () => {
    const { host: _host, ...fromDetailLookup } = entry(4, "2026-01-01");
    const result = filterComposerPullRequestMatches({
      entries: [fromDetailLookup, entry(4, "2026-01-02")],
      projectId: "p1",
      repository: "owner/repo",
      query: "4",
      limit: 10,
    });
    expect(result).toHaveLength(1);
  });

  it("tells the same repository apart across hosts", () => {
    // A thread can link owner/repo#4 on github.com and on a GitLab install at once; the link
    // identity is host-level, so neither row may stand in for the other.
    const onGitLab = { ...entry(4, "2026-01-01"), host: "gitlab.example.com" };
    const result = filterComposerPullRequestMatches({
      entries: [entry(4, "2026-01-02"), onGitLab],
      projectId: "p1",
      repository: "owner/repo",
      query: "4",
      limit: 10,
      linked: [onGitLab],
    });
    expect(result.map((match) => match.host)).toEqual(["gitlab.example.com", "github.com"]);
  });
});

describe("matchesComposerPullRequestWords", () => {
  it("finds a linked pull request by its repository as well as its title", () => {
    const row = {
      number: 4,
      title: "Add thing",
      repository: "owner/other",
      headBranch: "feat",
      baseBranch: "main",
    };
    expect(matchesComposerPullRequestWords(row, "other thing")).toBe(true);
    expect(matchesComposerPullRequestWords(row, "elsewhere")).toBe(false);
  });
});

describe("composerPullRequestEntriesFromLinks", () => {
  const link = (number: number, snapshot: ThreadPullRequestLink["snapshot"]) =>
    ({
      host: "github.com",
      repository: "owner/other",
      number,
      url: `https://github.com/owner/other/pull/${number}`,
      source: "agent",
      linkedAt: "2026-01-01T00:00:00.000Z",
      snapshot,
      stack: null,
    }) as ThreadPullRequestLink;

  it("builds rows from synced links and skips links without a snapshot", () => {
    const synced = link(4, {
      state: "open",
      title: "Add thing",
      headBranch: "feat",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-01-02T00:00:00.000Z",
    });
    const rows = composerPullRequestEntriesFromLinks([link(3, null), synced], "p1" as ProjectId);
    expect(rows).toEqual([
      expect.objectContaining({
        number: 4,
        repository: "owner/other",
        title: "Add thing",
        url: "https://github.com/owner/other/pull/4",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);
  });
});
