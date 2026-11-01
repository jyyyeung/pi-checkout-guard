# pi-checkout-guard

Ambient session presence + peer-aware safety guard for **shared git checkouts**.

Several AI coding-agent sessions share ONE physical checkout. Git gives a
checkout one `HEAD` and one index — a `git reset --hard` in any session
silently destroys every other session's uncommitted work, `git add -A`
sweeps foreign WIP into your commit, and a session that dies mid-rebase
leaves a trap the next session commits into. Real incidents behind this
design include irrecoverable WIP wipes and commits landing on a detached
HEAD left by a crashed rebase 22 hours earlier.

**pi-checkout-guard makes those sessions visible to each other and grades
the dangerous operations accordingly.** It is ambient: presence is
registered automatically at session start — no agent cooperation, no manual
`lock acquire` calls.

```
session A (shared root)                session B (shared root)
│ git reset --hard                     │ editing src/auth.ts
└── BLOCKED: "1 other live session:    │
      B — src/ — active 4m ago.        │
      Message B first, or prefix       │
      CHECKOUT_GUARD_OVERRIDE=1"       │
```

## What it does

| Layer | Behavior |
|---|---|
| **Presence registry** | Every session appends `{name, pid, cwd, isolation}` to one JSONL registry (inside the git common dir — shared across worktrees, never committed). Crashed sessions drop out via **pid liveness**: the extension runs inside the agent process, so `process.pid` *is* the session pid. No ghost windows. |
| **Git guard (peer-aware)** | Destructive verbs (`reset`, `checkout <ref>`, `stash`, `clean -f`, `rebase`, `merge`, `branch -d/-D/--delete`, `worktree remove`, `push --force/-f/--force-with-lease/--delete/+refspec`) are blocked at the shared root **only while other sessions are live**. Isolated sessions are never blocked. Read-only spellings of the same verbs pass: `clean -n/--dry-run`, `stash list|show`, `checkout -b/-B/--orphan` (creates a branch — `git switch -c`, the same operation under another name, was never blocked either). |
| **Tree-scoped exemption** | A git op whose execution dir resolves **inside an isolated worktree/lane is never blocked** — not by the graded classes, the peer gate, or the in-flight gate: it is branch-local by construction. This covers a session cwd inside the tree, a leading `cd <worktree> &&` prefix (which overrides the tool's declared working dir), and `git -C <worktree> <verb>`. Ops resolving into the shared root keep the full guard. |
| **Unconditional blocks** | `reset --hard/--keep` and `commit --amend` at the shared root are blocked even with no live peers — the victim is uncommitted state on disk, which no registry can see. |
| **Broad-add guard** | `git add -A / --all / .` at the shared root is blocked while peers are live (their uncommitted files get swept into your commit). Path-scoped adds pass. |
| **In-flight gate** | Git-mutating verbs are blocked while a rebase/merge/cherry-pick/revert/bisect is mid-flight (`rebase-merge/`, `MERGE_HEAD`, …) — **liveness-independent**, because a session that died mid-rebase looks exactly like "no session". **The way out is never blocked**: `git rebase --abort|--continue|--skip`, `git merge --abort`, `git cherry-pick --abort` are classified as *resolving* the operation, so the escape hatch cannot be gated by the thing it escapes (a second verb on the same line still counts: `git rebase --abort; git reset --hard` is still parsed as destructive). |
| **Edit containment** | Sessions inside an isolated worktree/lane cannot edit outside it; shared-root sessions get a warn-once tripwire when they edit *into* someone's isolated tree. The warn is **owner-aware** (see below): silent when the tree belongs to this session, names the live owner when one is working inside the tree, generic verify-ownership hint otherwise. |
| **`/sessions`** | List live sessions (name, where, age) and recent claims; `/sessions claim <text>` declares intent. |
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

## Install

```bash
pi install npm:pi-checkout-guard
```

Works with zero configuration in any plain git repository. The workspace is
resolved lazily from the session cwd on every tool call, so starting pi
outside a repo and then working inside one is not a dead end (the extension
used to resolve once at load and stay passive for the whole session). **bash
and powershell** tool calls are both guarded. Drop
`.pi-checkout-guard.json` at a directory to declare a **multi-repo
workspace** (all child repos + worktrees under it become one coordination
scope).

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
  "inFlightGuard": true,
  "registry": ".session-registry.jsonl"
}
```

| Key | Default | Meaning |
|---|---|---|
| `isolatedMarkers` | `[".worktree", ".lane"]` | Dirs carrying these marker files are isolated contexts. Linked git worktrees (`.git` file — any worktree manager) are detected automatically. |
| `staleMs` | 12h | Registry rows older than this are ignored. |
| `overrideEnv` | `CHECKOUT_GUARD_OVERRIDE` | Prefix a blocked command with `<overrideEnv>=1` to override once. |
| `notifyHint` | see above | Appended to block messages — put your team's coordination channel here. |
| `gitGuard` / `editGuard` / `rootEditWarn` / `inFlightGuard` | `true` | Toggle individual layers. |
| `registry` | git common dir (or `<root>/.pi-checkout-guard/`) | Registry file location, relative to root or absolute. |

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
{"ts":1730000000000,"type":"presence","name":"claude-x","session":"uuid","cwd":"/repo","expireAt":1730000300000}
{"ts":1730000100000,"type":"claim","name":"alice","pid":4242,"claim":"fixing auth flow"}
```

- `presence` rows are live while (`pid` alive AND `ts` fresh) or
  (`expireAt` in the future AND `ts` fresh).
- Third-party tools may append rows following this shape; unknown fields are
  ignored.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT © jyyyeung
