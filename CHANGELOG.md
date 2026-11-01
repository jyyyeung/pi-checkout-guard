# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3]

### Fixed

- **The in-flight gate no longer blocks its own escape hatch.** With a
  `rebase-merge/`/`MERGE_HEAD`/… marker present and no peers, `git rebase
  --abort|--continue|--skip` and `git merge --abort` were blocked by the gate
  whose message told you to run exactly those commands — the only way out was
  `CHECKOUT_GUARD_OVERRIDE=1`, which nobody knows at that moment. Abort-like
  verbs are now classified as *resolving* the operation in both the extension
  (`src/git-rules.ts`) and the Claude Code adapter, while any second verb on
  the same line still classifies normally.
- **A damaged registry fails closed.** One unparsable line used to make the
  whole-file `JSON.parse` throw, `readLivePeers()` return `[]`, and the guard
  allow destructive ops in a busy checkout. Parsing is per line now; damage is
  counted, destructive ops are blocked with the path and a repair instruction,
  read-only commands and the override prefix still work, and `/sessions`
  reports the count.
- **`alive()` treats `EPERM` as alive.** A process owned by another user
  (containers, sudo-launched agents, shared boxes) was read as dead, so real
  peers were dropped from every decision. Only `ESRCH` is dead.
- **False positives at one live peer:** `git clean -nd`/`-nfd`/`--dry-run`
  (read-only) and `git checkout -b feat/x` (creates a branch; `git switch -c`
  was already allowed) no longer block.
- **False negatives at one live peer:** `git branch --delete`, `git push
  origin +main`, `git push --delete origin old`, `git push -f` and
  `git push --force-with-lease` now block. A `checkout -b` that carries a
  pathspec (`git checkout -b x -- .`) still counts as a discard.
- **Solo block messages no longer send you looking for ghosts.** A session with
  no peers got `  (no other live sessions)` followed by "Message the session(s)
  listed above before proceeding."; the peer section now appears only when
  peers exist, and a solo unconditional block explains what it is protecting.
- **`OWNER_SESSION` prefix matching requires a separator.** A short session
  name (`pi`, `w1`) is a prefix of almost any owner id and silenced the
  edit-warn for foreign trees; ids now match exactly or as a
  separator-terminated prefix.

### Added

- **`powershell` tool coverage** (Windows) and **lazy workspace resolution**:
  the workspace is resolved from the session cwd on every tool call instead of
  once at factory load, so pi started outside a repo and then asked to work
  inside one is guarded instead of permanently passive.
- README section **"When you are alone"** (what a solo session gets) and
  **"When the registry is damaged"**.
- Tests 34 → 44: deadlock regression in both the extension and the adapter,
  fail-closed registry, `EPERM`, the read-only/destructive pairs, solo message
  text, and the prefix-match rule.
