/**
 * Command classification for the git guard.
 *
 * Regexes are battle-tested against real multi-agent incidents; the negative
 * lookaheads exist because plain word boundaries false-blocked read-only
 * variants (`merge` also matched `merge-base`, `checkout` matched
 * `checkout-index`, `stash` matched `stash list`) — those false positives
 * trained agents to ignore the guard, which is worse than no guard.
 */

/** In-flight operations END, they do not destroy: `git rebase --abort|--continue
 *  |--skip|--quit` (likewise merge/cherry-pick/revert/am) are the documented
 *  escape from a stuck operation. Classifying them as mutations deadlocked the
 *  in-flight gate — the gate blocked the very command its own message told you
 *  to run, leaving the env override as the only exit. Stripped before verb
 *  matching (see classifyGit) and surfaced as `abortLike` for messaging. */
export const ABORT_LIKE_GIT =
  /\bgit\s+(?:rebase|merge|cherry-pick|revert|am)\s+(?:-[\w-]+\s+)*--(?:abort|continue|skip|quit)\b/;

/** Read-only `git clean` forms: -n in any short cluster (-n, -nd, -nfd) or
 *  --dry-run only LIST what would be removed. `clean -fd` still destroys. */
const CLEAN_DESTRUCTIVE = 'clean(?!\\s+(?:-{1,2}[\\w-]*n[\\w-]*|--dry-run)\\b)';

/** Destructive/state-destroying git verbs. Reads never match. */
export const DESTRUCTIVE_GIT = new RegExp(
  String.raw`\bgit\s+(?:-{1,2}[\w-]+\s+)*(?:reset\b|stash(?!\s+(?:list|show|log))\b|checkout(?!-index)\b|restore\b|${CLEAN_DESTRUCTIVE}|rebase\b|merge(?!-(?:base|ours|theirs|file))\b|branch\s+(?:-\w*[Dd]\b|--delete\b)|worktree\s+(?:remove|destroy)\b|push\b[^;&|]*(?:--force(?:-with-lease)?\b|-f\b|--delete\b|(?:^|\s)\+[^\s;&|]+))`,
);

/** `git commit --amend` at the shared root can rewrite another session's
 *  already-pushed commit — blocked regardless of live peers. */
export const AMEND_ROOT_GIT = /\bgit\s+commit\s[^;&|]*--amend\b/;

/** `git reset --hard|--keep` at the shared root discards ALL uncommitted
 *  files, including peers' WIP that was never registered — blocked
 *  regardless of live peers. */
export const RESET_HARD_ROOT_GIT =
  /\bgit\s+(?:(?:-{1,2}[\w-]+|-C\s+\S+)\s+)*reset\s+(?:-{1,2}[\w-]+\s+)*(?:--hard\b|--keep\b)/;

/** Broad adds sweep other sessions' uncommitted files into your commit. */
export const BROAD_ADD_GIT =
  /\bgit\s+add\s+(?:-{1,2}[\w-]+\s+)*(?:-A\b|--all\b|\.\s*$|\.\s*(?:&&|;|$)|["']?\.\/?["']?\s*$)/;

/** Read-only commands that merely MENTION a destructive verb in an argument
 *  (grep over logs, echo of a snippet) never mutate git state. */
export const READONLY_PREFIX =
  /^\s*(?:grep|rg|fgrep|egrep|ack|echo|printf|sed|awk|cat|head|tail|less|wc)\b/;

/** Git verbs that mutate repo state — used by the in-flight-operation gate
 *  (blocking NEW mutations while a rebase/merge/cherry-pick is mid-flight).
 *  Abort-like verbs are stripped before this test: they RESOLVE the in-flight
 *  state and must never be blocked by it. */
export const GIT_MUTATING =
  /\bgit\s+(?:-{1,2}[\w-]+\s+)*(?:commit\b|push\b|checkout(?!-index)\b|switch\b|branch\b|merge(?!-(?:base|ours|theirs|file))\b|rebase\b|reset\b|cherry-pick\b|revert\b|pull\b|am\b|apply\b|stash\b|add\b|rm\b|mv\b)/;

/** Git-dir-relative markers of an operation in flight. */
export const IN_FLIGHT_MARKERS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
] as const;

export interface GitVerdict {
  destructive: boolean;
  amend: boolean;
  resetHard: boolean;
  broadAdd: boolean;
  mutating: boolean;
  /** `git <op> --abort|--continue|--skip|--quit`: resolves an in-flight op. */
  abortLike: boolean;
}

/** Strip quoted segments ("..." and '...') before verb matching: a commit
 *  MESSAGE that mentions `--amend` or `reset --hard` must not classify the
 *  command as the verb itself (real incident: docs commit explaining why
 *  you should never --amend was blocked as an amend). Quoted args of the real
 *  verb are unaffected — the verb prefix survives stripping. */
export function stripQuoted(command: string): string {
  return command.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' "…" ');
}

/** Replace abort-like invocations so they cannot be read as mutations, while
 *  leaving any OTHER verb on the same command line intact
 *  (`git rebase --abort; git reset --hard` still classifies as destructive). */
function stripAbortLike(command: string): string {
  return command.replace(
    /\bgit\s+(?:rebase|merge|cherry-pick|revert|am)\s+(?:-[\w-]+\s+)*--(?:abort|continue|skip|quit)\b/g,
    "git op-resolved",
  );
}

/** `git checkout -b <name>` / `-B` / `--orphan` CREATE a branch: nothing is
 *  discarded, so it is not destructive — the same operation spelled
 *  `git switch -c` was never guarded, and the inconsistency taught agents that
 *  `checkout -b` is the way around the guard. A pathspec after `--` (or a bare
 *  `.`) still means "throw away worktree changes" and keeps matching. */
function stripCreateBranch(command: string): string {
  return command.replace(
    /\bgit\s+checkout\s+(?:-b|-B|--orphan)\s+\S+([^;&|]*)/g,
    (match, rest: string) =>
      /(?:^|\s)--(?:\s|$)|(?:^|\s)\.(?:\s|$)/.test(rest) ? match : "git branch-create",
  );
}

export function classifyGit(command: string): GitVerdict {
  const bare = stripCreateBranch(stripAbortLike(stripQuoted(command)));
  return {
    destructive: DESTRUCTIVE_GIT.test(bare),
    amend: AMEND_ROOT_GIT.test(bare),
    resetHard: RESET_HARD_ROOT_GIT.test(bare),
    broadAdd: BROAD_ADD_GIT.test(bare),
    mutating: GIT_MUTATING.test(bare),
    abortLike: ABORT_LIKE_GIT.test(stripQuoted(command)),
  };
}

export function isReadOnlyMention(command: string): boolean {
  return READONLY_PREFIX.test(command);
}

/** Leading `cd <dir> &&` — command executes at dir, not session cwd. */
export function extractCdTarget(command: string): string | undefined {
  const m = command.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/);
  return m?.[1];
}

/** `git -C <dir> <verb>` — op executes inside dir. */
export function extractGitCDir(command: string): string | undefined {
  const m = command.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/);
  return m?.[1];
}

export function stripQuotes(value: string): string {
  return value.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
}
