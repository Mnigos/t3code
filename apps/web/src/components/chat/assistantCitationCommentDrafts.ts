/**
 * Unsaved citation comments, keyed by the serialized citation. The comment
 * editor lives inside the composer's citation node view, and the editor
 * replaces its whole document when a provider question borrows it for the
 * answer, which unmounts the node view without any dismissal. The draft is
 * kept here across that, and dropped once it is saved or discarded.
 */
const drafts = new Map<string, string>();

export function readAssistantCitationCommentDraft(key: string): string | null {
  return drafts.get(key) ?? null;
}

export function writeAssistantCitationCommentDraft(key: string, draft: string): void {
  drafts.set(key, draft);
}

export function clearAssistantCitationCommentDraft(key: string): void {
  drafts.delete(key);
}
