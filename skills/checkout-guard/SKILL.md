---
name: checkout-guard
description: Shared-checkout safety for concurrent agent sessions. Use when working at a shared/canonical git checkout with other agent sessions possibly live, when a tool call is blocked by pi-checkout-guard, when planning destructive git operations (reset/checkout/stash/clean/rebase/merge/branch -D/force push), or when editing inside/outside an isolated worktree or lane.
---

# checkout-guard skill

## When this applies

You are one of several agent sessions that may share ONE physical git
checkout. The `pi-checkout-guard` extension is ambient — it registers your
presence and guards destructive operations automatically. This skill teaches
you the protocol around it.

## Protocol

1. **Before any destructive git operation** (`reset`, `checkout <ref>`,
   `stash`, `clean`, `rebase`, `merge`, `branch -D`, `push --force`,
   `add -A`, `commit --amend`) at a SHARED checkout: run `/sessions` first.
   - Other live sessions listed → do NOT proceed silently. Coordinate
     (message them) or scope the operation to your own worktree.
   - No live sessions → proceed.
2. **A block message is information, not an obstacle.** It lists live peers,
   explains the specific failure mode, and names the override. If you were
   about to destroy a peer's uncommitted work, the block was correct —
   re-plan instead of overriding.
3. **Override sparingly**: prefix the exact command with the configured
   override env (default `CHECKOUT_GUARD_OVERRIDE=1`) ONLY after `/sessions`
   shows nobody affected, or after the affected sessions acknowledged.
4. **Unconditional blocks** (`reset --hard`, `commit --amend` at a shared
   root, mutations while a rebase/merge is in flight) fire even with no live
   peers — the victim is uncommitted state on disk or a dead session's
   half-finished operation, which no registry can see. Resolve the state
   (finish/abort the rebase, make a new commit, reset inside your worktree)
   instead of overriding.
5. **If your session was launched inside an isolated worktree/lane**: edit
   only inside it; the guard blocks escapes. Merge back from inside — never
   edit the shared tree from an isolated session.
6. **Declare intent** when about to hold shared state for a while:
   `/sessions claim <what you are doing>` — claims show in `/sessions`.

## Failure classes this protocol prevents

- `git reset --hard` / `checkout .` wiping other sessions' uncommitted WIP
  (irrecoverable — untracked files never reach reflog)
- `git add -A` sweeping a peer's in-progress files into your commit
- `commit --amend` folding your change into a peer's already-pushed commit
- commits landing on a detached HEAD left by a crashed mid-rebase session
- edits from an isolated session leaking into the shared tree (and vice
  versa: root sessions stomping worktree WIP)
