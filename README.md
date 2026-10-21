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
| **Git guard (peer-aware)** | Destructive verbs (`reset`, `checkout <ref>`, `stash`, `clean`, `rebase`, `merge`, `branch -D/-d`, `worktree remove`, `push --force`) are blocked at the shared root **only while other sessions are live**. Isolated sessions are never blocked. |
| **Unconditional blocks** | `reset --hard/--keep` and `commit --amend` at the shared root are blocked even with no live peers — the victim is uncommitted state on disk, which no registry can see. |
| **Broad-add guard** | `git add -A / --all / .` at the shared root is blocked while peers are live (their uncommitted files get swept into your commit). Path-scoped adds pass. |
| **In-flight gate** | Git-mutating verbs are blocked while a rebase/merge/cherry-pick/revert/bisect is mid-flight (`rebase-merge/`, `MERGE_HEAD`, …) — **liveness-independent**, because a session that died mid-rebase looks exactly like "no session". |
| **Edit containment** | Sessions inside an isolated worktree/lane cannot edit outside it; shared-root sessions get a warn-once tripwire when they edit *into* someone's isolated tree. |
| **`/sessions`** | List live sessions (name, where, age) and recent claims; `/sessions claim <text>` declares intent. |
| **Read-only hygiene** | Commands that merely *mention* a verb (`grep 'git clean -fd' log`) pass; `merge-base`, `stash list`, `checkout-index` never matched (false positives train agents to ignore guards). |

## Install

```bash
pi install npm:pi-checkout-guard
```

Works with zero configuration in any plain git repository. Drop
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

Disable the extension entirely with `CHECKOUT_GUARD_DISABLE=1`.

`GIT_CEILING_DIRECTORIES` is honored during workspace discovery (git-compatible),
protecting against stray `.git` directories high in the tree.

## Cross-agent: Claude Code adapter

`hooks/claude-checkout-guard.mjs` reads and writes the **same registry**
with the same rules, so Claude Code sessions and pi sessions see each
other. Claude hooks are ephemeral processes, so adapter rows use a
heartbeat-refreshed TTL (`expireAt`) instead of pid liveness — same
trade-off as TTL-style session locks. Wiring snippet is in the hook file
header.

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
