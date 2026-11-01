# pi-checkout-guard

[![npm](https://img.shields.io/npm/v/pi-checkout-guard?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-checkout-guard) [![CI](https://img.shields.io/github/actions/workflow/status/jyyyeung/pi-checkout-guard/test.yml?style=flat&logo=github&label=CI)](https://github.com/jyyyeung/pi-checkout-guard/actions/workflows/test.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![Pi](https://img.shields.io/badge/pi-%E2%89%A51.3-6366F1?style=flat)](https://pi.dev) [![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org)

Ambient session presence + peer-aware safety guard for **shared git checkouts**.

Git gives a checkout one `HEAD` and one index. Run several agent sessions in
the same checkout and a `git reset --hard` in one of them silently destroys
every other session's uncommitted work, `git add -A` sweeps foreign WIP into
your commit, and a session that dies mid-rebase leaves a trap the next session
commits into. The incidents behind this design include irrecoverable WIP wipes
and a commit landing on a detached HEAD left by a crashed rebase 22 hours
earlier.

pi-checkout-guard makes those sessions visible to each other and grades the
dangerous operations accordingly. It is ambient: presence is registered
automatically at session start — no agent cooperation, no manual `lock acquire`.

```
session A (shared root)                session B (shared root)
│ git reset --hard                     │ editing src/auth.ts
└── BLOCKED: "1 other live session:    │
      B — src/ — active 4m ago.        │
      Message B first, or prefix       │
      CHECKOUT_GUARD_OVERRIDE=1"       │
```

Install it if you run more than one agent session — or one agent and one human
editor — in the same checkout.

## Install

```bash
pi install npm:pi-checkout-guard
```

Then restart pi (or `/reload`). Works with zero configuration in any plain
git repository.

From a local checkout:

```bash
pi install ./pi-checkout-guard
pi -e ./pi-checkout-guard/extensions/checkout-guard.ts
```

Workspace discovery runs lazily from the session cwd on every tool call, so
starting pi outside a repository and then working inside one is not a dead end.
The `bash` and `powershell` tools are both guarded. Drop a
`.pi-checkout-guard.json` at a directory to declare a **multi-repo workspace**:
all child repos and worktrees under it become one coordination scope.

## Quick start

Start two sessions in the same checkout. In the second one, ask for something
destructive:

```
pi-checkout-guard: `git reset --hard` discards ALL uncommitted changes at the
shared checkout (peers' WIP included, even sessions that never registered).
Recover via git-reflog/reflog of the stash, or reset inside your own worktree
while 1 other live session(s) are registered here:
  - fix-auth (shared) — /repo — active 4m ago

Message the session(s) listed above before proceeding.
If nobody is affected, re-run with CHECKOUT_GUARD_OVERRIDE=1 prefixed to the
same command.
```

(Wrapped here for reading; the block reason arrives as a few long lines.)

The blocked command never ran. Check who is there at any time:

```
> /sessions
```

### Commands

| Command | What it does |
|---|---|
| `/sessions` | Live sessions (name, where, how long ago they were seen), recent claims, and whether the registry is damaged. |
| `/sessions claim <text>` | Declare what this session is working on, so peers see it. |

## What it does

| Layer | Behavior |
|---|---|
| **Presence registry** | Every session appends `{name, pid, cwd, kind}` (`kind` is `shared` or `isolated`, plus `ref` for a worktree/lane) to one JSONL registry (inside the git common dir — shared across worktrees, never committed). Crashed sessions drop out via **pid liveness**: the extension runs inside the agent process, so `process.pid` *is* the session pid. No ghost windows. |
| **Git guard (peer-aware)** | Destructive verbs (`reset`, `checkout <ref>`, `restore`, `stash`, `clean -f`, `rebase`, `merge`, `branch -d/-D/--delete`, `worktree remove|destroy`, `push --force/-f/--force-with-lease/--delete/+refspec`) are blocked at the shared root **only while other sessions are live**. Isolated sessions are never blocked. Read-only spellings of the same verbs pass: `clean -n/--dry-run`, `stash list|show|log`, `checkout -b/-B/--orphan` (creates a branch — `git switch -c`, the same operation under another name, was never blocked either). |
| **Tree-scoped exemption** | A git op whose execution dir resolves **inside an isolated worktree/lane is never blocked** — not by the graded classes, the peer gate, or the in-flight gate: it is branch-local by construction. This covers a session cwd inside the tree, a leading `cd <worktree> &&` prefix (which overrides the tool's declared working dir), and `git -C <worktree> <verb>`. Ops resolving into the shared root keep the full guard. |
| **Unconditional blocks** | `reset --hard/--keep` and `commit --amend` at the shared root are blocked even with no live peers — the victim is uncommitted state on disk, which no registry can see. |
| **Broad-add guard** | `git add -A / --all / .` at the shared root is blocked while peers are live (their uncommitted files get swept into your commit). Path-scoped adds pass. |
| **In-flight gate** | Git-mutating verbs are blocked while a rebase/merge/cherry-pick/revert/bisect is mid-flight (`rebase-merge/`, `MERGE_HEAD`, …) — **liveness-independent**, because a session that died mid-rebase looks exactly like "no session". **The way out is never blocked**: `git rebase --abort|--continue|--skip`, `git merge --abort`, `git cherry-pick --abort` are classified as *resolving* the operation, so the escape hatch cannot be gated by the thing it escapes (a second verb on the same line still counts: `git rebase --abort; git reset --hard` is still parsed as destructive). |
| **Edit containment** | Sessions inside an isolated worktree/lane cannot edit outside it; shared-root sessions get a warn-once tripwire when they edit *into* someone's isolated tree. The warn is **owner-aware** (see below): silent when the tree belongs to this session, names the live owner when one is working inside the tree, generic verify-ownership hint otherwise. |
| **Read-only hygiene** | Commands that merely *mention* a verb (`grep 'git clean -fd' log`) pass; `merge-base`, `stash list`, `checkout-index` never matched (false positives train agents to ignore guards). |

## When you are alone

The single most common reason to uninstall a guard is a block on a solo
session, so be explicit about what a solo session gets:

| Command (no other live session) | Result |
|---|---|
| `git push`, `git commit`, `git merge`, `git checkout <ref>`, `git stash`, `git clean -fd` | allowed — peer-scoped rules with no peers have nothing to protect |
| `git reset --hard`, `git reset --keep`, `git commit --amend` | **blocked** — these discard uncommitted state that no registry can see (a crashed session's WIP, a teammate's, your own second checkout). Block messages say so plainly and never refer to sessions that do not exist. |
| anything mid-flight (rebase/merge/cherry-pick state present) | **blocked**, except the abort/continue/skip verbs that resolve it |
| any of the above, prefixed `CHECKOUT_GUARD_OVERRIDE=1` | allowed, once |

If you never run concurrent sessions, this extension is mostly inert: the
unconditional three are the only blocks you will ever see, and the override
prefix clears each one.

## Configuration (`.pi-checkout-guard.json`)

```json
{
  "isolatedMarkers": [".worktree", ".lane"],
  "staleMs": 43200000,
  "overrideEnv": "CHECKOUT_GUARD_OVERRIDE",
  "notifyHint": "Message the session(s) listed above before proceeding.",
  "gitGuard": true,
  "editGuard": true,
  "rootEditWarn": true,
  "inFlightGuard": true
}
```

| Key | Default | Meaning |
|---|---|---|
| `isolatedMarkers` | `[".worktree", ".lane"]` | Dirs carrying these marker files are isolated contexts. Linked git worktrees (`.git` file — any worktree manager) are detected automatically. |
| `staleMs` | 12h | Registry rows older than this are ignored. |
| `overrideEnv` | `CHECKOUT_GUARD_OVERRIDE` | Prefix a blocked command with `<overrideEnv>=1` to override once. |
| `notifyHint` | see above | Appended to block messages — put your team's coordination channel here. |
| `gitGuard` / `editGuard` / `rootEditWarn` / `inFlightGuard` | `true` | Toggle individual layers. |
| `registry` | unset → `<git common dir>/pi-checkout-guard/registry.jsonl` (or `<root>/.pi-checkout-guard/registry.jsonl` when the config file sits at the root, or when there is no git dir) | Override the registry file: a path relative to the root, or absolute. |

### Message size and token cost

Guard messages stay small on purpose: peer lists are capped at **five names**,
then collapse to `…and N more (/sessions for full list)`. When more than five
sessions are live, the per-session `notifyHint` is replaced by a one-line
suggestion to **broadcast once** (e.g. via your team's intercom channel)
instead of messaging every session before each shared-root git op.

Disable the extension entirely with `CHECKOUT_GUARD_DISABLE=1`.

`GIT_CEILING_DIRECTORIES` is honored during workspace discovery (git-compatible),
protecting against stray `.git` directories high in the tree.

## Owner-aware tree warnings

When a shared-root session edits inside an isolated tree, the guard tries to
resolve the owner before warning:

1. **Tree marker file** — if any `isolatedMarkers` file in the tree root holds
   `OWNER_SESSION=<id>` and that id matches this session (its name or
   `PI_SESSION_ID`, compared tolerantly: exact, or one is a prefix of the
   other, so short and full session ids both work), the tree is yours and the
   warn is **suppressed silently**. Worktree tooling can stamp this key when
   it creates the tree; an absent or unreadable file is simply skipped.
2. **Live registry peers** — a live session whose presence `cwd` sits inside
   the tree is treated as its active owner: the warn still fires, but **names
   them** (`Owned by <name> (live) — coordinate with them before editing.`)
   so the next step is coordination, not detective work.
3. **Nothing resolvable** — the generic verify-ownership warn fires once per
   tree, exactly as before.

Set `rootEditWarn: false` to disable the whole path.

## Cross-agent: Claude Code adapter

`hooks/claude-checkout-guard.mjs` reads and writes the **same registry**
with the same rules, so Claude Code sessions and pi sessions see each
other. Claude hooks are ephemeral processes, so adapter rows use a
heartbeat-refreshed TTL (`expireAt`) instead of pid liveness — same
trade-off as TTL-style session locks. Wiring snippet is in the hook file
header. The adapter also mirrors the main guard's tree-scoped git-verb
exemption: when a command's execution directory (a leading `cd <dir> &&`, a
`git -C <dir>`, or the session cwd itself) resolves inside an isolated tree
— or outside the shared checkout entirely — every git-verb gate (in-flight,
peer-aware, graded) is skipped for that op, so Claude Code sessions driving
their own worktrees are never false-blocked; commands resolving at the
shared root keep the full guard.

## When the registry is damaged

One unreadable line used to collapse the whole file to "no peers" — the guard
then treated a busy checkout as empty, which is the worst possible failure
mode for a safety tool. Parsing is now per line: damaged lines are counted,
and a destructive git op is **blocked with the file path and a repair
instruction** instead of silently allowed. Read-only commands and the
`CHECKOUT_GUARD_OVERRIDE=1` prefix still work, so you are never locked out.
`/sessions` reports the damage count.

## Registry format (spec)

One JSON object per line, append-only:

```jsonl
{"ts":1730000000000,"type":"presence","name":"alice","pid":4242,"cwd":"/repo","kind":"shared"}
{"ts":1730000000000,"type":"presence","name":"w1","pid":4343,"cwd":"/repo/.worktree/w1","kind":"isolated","ref":"w1"}
{"ts":1730000000000,"type":"presence","name":"claude-x","cwd":"/repo","kind":"shared","expireAt":1730000300000}
{"ts":1730000100000,"type":"claim","name":"alice","pid":4242,"claim":"fixing auth flow"}
```

- `presence` rows are live while `ts` is fresh **and** either `pid` is a live
  process or, for rows written by a TTL adapter (no `pid`), `expireAt` is still
  in the future. A row with neither is ignored.
- `claim` rows are what `/sessions` prints under `Recent claims` — the latest
  five, dropped once older than `staleMs`.
- Third-party tools may append rows following this shape; unknown fields are
  ignored.

## How this differs from neighbors

| | peer-aware | liveness | worktree-aware | override | harness |
|---|---|---|---|---|---|
| **pi-checkout-guard** | yes, ambient | **true pid** (in-process) + TTL (adapter) | isolation both directions + in-flight gate | per-command env | pi + Claude adapter |
| static safety nets (e.g. cc-safety-net) | no | n/a | no | policy | many CLIs |
| TTL session locks (e.g. session-lock-style hooks) | yes | heartbeat TTL (ghost window) | lock scope only | per-command | Claude Code |
| manual locks (e.g. agent-lock) | yes | manual acquire/release | per-path claims | manual | any CLI |

Design credit: the in-flight-operation gate and the multi-session lock-map
idea were pioneered by Claude Code community hooks (session-lock lineage);
pi-checkout-guard adds true pid liveness, incident-graded severity, edit
containment, and a documented cross-agent registry format.

## Scope and non-goals

- **Not a sandbox.** It grades git operations and edits into isolated trees. It
  does not prevent `rm -rf`, and it is not a permission system
  (use [pi-permission-system](https://www.npmjs.com/package/@gotgenes/pi-permission-system)
  for tool/path policy).
- **Not a lock manager.** No per-file claims, no acquire/release dance; the
  registry is presence, and presence is automatic.
- **Not a merge resolver.** It refuses the operations that destroy work; it
  never tries to merge two sessions' state.
- **Peers must be visible.** Sessions in a *different* checkout, on another
  machine, or in a terminal where the extension is not loaded cannot be
  protected — the registry only knows what joined it.

## Requirements

| Requirement | Needed for | If missing |
|---|---|---|
| pi ≥ 1.3 | everything | the extension does not load |
| Node ≥ 20 (22.6+ to run the tests) | everything | same |
| git | everything | workspace discovery finds nothing; the guard stays passive |
| Claude Code | the optional adapter | pi sessions still see each other |

No network access, no telemetry, no runtime dependencies beyond pi's own
packages.

## Troubleshooting

**Blocked with no other sessions listed.** That is the unconditional class —
`reset --hard`, `reset --keep`, `commit --amend` at the shared root — and it
means the state being discarded cannot be verified by anyone (a crashed
session's WIP still looks like nobody's). Override with
`CHECKOUT_GUARD_OVERRIDE=1` when you know it is yours.

**Blocked and the message mentions unparsable registry lines.** Something wrote
a broken row into the registry. Peer state is unknown, so the guard fails
closed. Delete the registry file (`/sessions` prints the path); it rebuilds as
sessions re-register.

**Can't finish or abort a rebase.** You can: `rebase --continue`, `--abort`,
`--skip` and `merge --abort` are never gated. If you wrote
`git rebase --abort; git reset --hard` on one line, the second verb is still
graded — split the line.

**Nothing ever blocks.** Check `CHECKOUT_GUARD_DISABLE` is unset, that you are
in a repository, and that `/sessions` lists your peers. Sessions in different
checkouts are invisible to each other by design.

**A worktree session gets blocked.** It should not: ops resolving inside a
marked isolated tree skip every git gate. Either the tree is not marked
(`.worktree`/`.lane` file, or a linked worktree with a `.git` file) or the
command resolves to the shared root.

## Related packages

Five extensions for the same problem — agent sessions sharing a checkout —
covering different moments:

| Package | Moment | Guards against |
|---|---|---|
| [pi-rc-gate](https://github.com/jyyyeung/pi-rc-gate) | at execution | the failure signal being destroyed, so a red command is reported green |
| **pi-checkout-guard** (this) | during | concurrent sessions wiping each other's uncommitted work |
| [pi-closeout](https://github.com/jyyyeung/pi-closeout) | at session end | the dirty state a session leaves for the next one |
| [pi-retro](https://github.com/jyyyeung/pi-retro) | weekly | friction that keeps recurring because nobody wrote it down |
| [pi-handoff](https://github.com/jyyyeung/pi-handoff) | between sessions | context lost when a session ends |

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT © jyyyeung
