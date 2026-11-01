#!/usr/bin/env node
/**
 * Claude Code hook adapter for pi-checkout-guard — same registry, same rules.
 *
 * Claude Code hooks are ephemeral processes: their pid dies with each
 * invocation, so presence rows carry expireAt (TTL, heartbeat-refreshed)
 * instead of pid-liveness. The pi extension (in-process, true pid liveness)
 * and this adapter interoperate on one registry: pid rows live while the
 * process lives; expireAt rows live until their timestamp.
 *
 * Wire in Claude Code settings.json:
 *   {
 *     "hooks": {
 *       "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /path/to/claude-checkout-guard.mjs" }] }],
 *       "Stop":        [{ "hooks": [{ "type": "command", "command": "node /path/to/claude-checkout-guard.mjs" }] }],
 *       "PreToolUse":  [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /path/to/claude-checkout-guard.mjs" }] }]
 *     }
 *   }
 *
 * Exit codes: 0 = allow (PreToolUse), 2 = block (stderr is shown to the
 * model). Registry/config resolution mirrors src/resolve.ts simplified:
 * walk up for .pi-checkout-guard.json, then .git.
 *
 * NOTE: the git verb regexes and the cd/-C target extraction helpers are
 * duplicated from src/git-rules.ts (TypeScript source is not importable from
 * a no-build hook), and the tree-scoped exemption mirrors src/guard.ts.
 * Keep them in sync.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const CONFIG_FILE = ".pi-checkout-guard.json";
const DEFAULT_STALE_MS = 12 * 60 * 60 * 1000;
const TTL_MS = 5 * 60 * 1000; // expireAt freshness for hook-written rows

function stripQuoted(command) {
  return command.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' "…" ');
}

function stripQuotes(value) {
  return value.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
}

/** Leading `cd <dir> &&` — command executes at dir, not session cwd. */
function extractCdTarget(command) {
  const m = command.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/);
  return m?.[1];
}

/** `git -C <dir> <verb>` — op executes inside dir. */
function extractGitCDir(command) {
  const m = command.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/);
  return m?.[1];
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Walk up from dir to (exclusive) the shared root: an isolation marker file
 *  or a linked-worktree `.git` FILE means dir sits inside an isolated tree. */
function insideIsolatedTree(dir, root, markers) {
  for (let d = path.resolve(dir); d !== root && path.dirname(d) !== d; d = path.dirname(d)) {
    if (markers.some((m) => fs.existsSync(path.join(d, m)))) return true;
    if (isFile(path.join(d, ".git"))) return true;
  }
  return false;
}

/** Git ops resolving outside the shared root are never guarded (mirrors
 *  src/guard.ts): no workspace at all, a different checkout, or a directory
 *  inside an isolated tree are branch-local by construction. */
function resolvesOutsideSharedRoot(raw, ws, markers, sessionCwd) {
  if (!raw) return false;
  const unquoted = stripQuotes(raw);
  const abs = path.isAbsolute(unquoted) ? unquoted : path.resolve(sessionCwd, unquoted);
  const target = findRoot(abs);
  if (!target || target.root !== ws.root) return true;
  return insideIsolatedTree(abs, ws.root, markers);
}

// Read-only `git clean` (-n in any short cluster, --dry-run) only lists.
const CLEAN_DESTRUCTIVE = "clean(?!\\s+(?:-{1,2}[\\w-]*n[\\w-]*|--dry-run)\\b)";
const DESTRUCTIVE_GIT = new RegExp(
  "\\bgit\\s+(?:-{1,2}[\\w-]+\\s+)*(?:reset\\b|stash(?!\\s+(?:list|show|log))\\b|checkout(?!-index)\\b|restore\\b|" +
    CLEAN_DESTRUCTIVE +
    "|rebase\\b|merge(?!-(?:base|ours|theirs|file))\\b|branch\\s+(?:-\\w*[Dd]\\b|--delete\\b)" +
    "|worktree\\s+(?:remove|destroy)\\b|push\\b[^;&|]*(?:--force(?:-with-lease)?\\b|-f\\b|--delete\\b|(?:^|\\s)\\+[^\\s;&|]+))",
);
const AMEND_ROOT_GIT = /\bgit\s+commit\s[^;&|]*--amend\b/;
const RESET_HARD_ROOT_GIT =
  /\bgit\s+(?:(?:-{1,2}[\w-]+|-C\s+\S+)\s+)*reset\s+(?:-{1,2}[\w-]+\s+)*(?:--hard\b|--keep\b)/;
const BROAD_ADD_GIT =
  /\bgit\s+add\s+(?:-{1,2}[\w-]+\s+)*(?:-A\b|--all\b|\.\s*$|\.\s*(?:&&|;|$)|["']?\.\/?["']?\s*$)/;
const READONLY_PREFIX =
  /^\s*(?:grep|rg|fgrep|egrep|ack|echo|printf|sed|awk|cat|head|tail|less|wc)\b/;
const GIT_MUTATING =
  /\bgit\s+(?:-{1,2}[\w-]+\s+)*(?:commit\b|push\b|checkout(?!-index)\b|switch\b|branch\b|merge(?!-(?:base|ours|theirs|file))\b|rebase\b|reset\b|cherry-pick\b|revert\b|pull\b|am\b|apply\b|stash\b|add\b|rm\b|mv\b)/;
const IN_FLIGHT_MARKERS = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"];
const DEFAULT_ISOLATED_MARKERS = [".worktree", ".lane"];

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function findRoot(cwd) {
  for (let d = path.resolve(cwd); path.dirname(d) !== d; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, CONFIG_FILE))) {
      let config = {};
      try {
        config = JSON.parse(fs.readFileSync(path.join(d, CONFIG_FILE), "utf8"));
      } catch {
        /* defaults */
      }
      return { root: d, config, gitDir: fs.existsSync(path.join(d, ".git")) ? path.join(d, ".git") : null };
    }
    if (fs.existsSync(path.join(d, ".git"))) {
      return { root: d, config: {}, gitDir: path.join(d, ".git") };
    }
  }
  return null;
}

function registryPath(ws) {
  if (typeof ws.config.registry === "string" && ws.config.registry) {
    return path.isAbsolute(ws.config.registry) ? ws.config.registry : path.join(ws.root, ws.config.registry);
  }
  if (fs.existsSync(path.join(ws.root, CONFIG_FILE)) && !ws.gitDir) {
    return path.join(ws.root, ".pi-checkout-guard", "registry.jsonl");
  }
  return path.join(ws.gitDir ?? path.join(ws.root, ".git"), "pi-checkout-guard", "registry.jsonl");
}

/** Per-line parse: one corrupt row must not erase every other peer (the
 *  whole-file try/catch returned [], which read as "nobody is here" and
 *  disarmed the guard). Damage is counted so the caller can fail closed. */
function readRows(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { rows: [], damaged: 0 };
  }
  const rows = [];
  let damaged = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && typeof row.type === "string") rows.push(row);
      else damaged++;
    } catch {
      damaged++;
    }
  }
  return { rows, damaged };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but belongs to another user; ESRCH = gone.
    return err?.code === "EPERM";
  }
}

function livePeers(file, staleMs) {
  const now = Date.now();
  const { rows } = readRows(file);
  return rows.filter((r) => {
    if (r.type !== "presence") return false;
    if (r.session === sessionId) return false;
    if (now - r.ts >= staleMs) return false;
    if (typeof r.pid === "number") return alive(r.pid);
    if (typeof r.expireAt === "number") return now < r.expireAt;
    return false;
  });
}

function appendRow(file, row) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
  } catch {
    /* best-effort */
  }
}

const input = readStdin();
const sessionId = String(input.session_id ?? `claude-${process.pid}`);
const event = String(input.hook_event_name ?? "");
const ws = findRoot(String(input.cwd ?? process.cwd()));

if (ws) {
  const reg = registryPath(ws);
  const staleMs = typeof ws.config.staleMs === "number" ? ws.config.staleMs : DEFAULT_STALE_MS;
  const overrideEnv = ws.config.overrideEnv ?? "CHECKOUT_GUARD_OVERRIDE";
  const me = { ts: Date.now(), type: "presence", name: sessionId, session: sessionId, cwd: input.cwd, expireAt: Date.now() + TTL_MS };

  if (event === "SessionStart" || event === "Stop") {
    appendRow(reg, me); // presence + heartbeat (TTL row, refreshed)
    process.exit(0);
  }

  if (event === "PreToolUse" && (input.tool_name === "Bash" || input.tool_name === "bash")) {
    appendRow(reg, me); // heartbeat
    const command = String(input.tool_input?.command ?? "");
    if (!command || command.includes(`${overrideEnv}=1`)) process.exit(0);

    const bare = stripQuoted(command);
    // Abort-like verbs RESOLVE an in-flight operation; classifying them as
    // mutations blocked `git rebase --abort` behind the gate that says to run
    // it. Strip them only from the verb match, so a second verb on the same
    // line still counts.
    const stripping = bare.replace(
      /\bgit\s+(?:rebase|merge|cherry-pick|revert|am)\s+(?:-[\w-]+\s+)*--(?:abort|continue|skip|quit)\b/g,
      "git op-resolved",
    );
    // `git checkout -b|-B|--orphan <name>` creates a branch and destroys
    // nothing (it matches the same `switch -c` spelling that was never
    // guarded). A pathspec after `--` or a bare `.` still means discard.
    const bareVerb = stripping.replace(/\bgit\s+checkout\s+(?:-b|-B|--orphan)\s+\S+([^;&|]*)/g, (m, rest) =>
      /(?:^|\s)--(?:\s|$)|(?:^|\s)\.(?:\s|$)/.test(rest) ? m : "git branch-create",
    );
    const verdict = {
      destructive: DESTRUCTIVE_GIT.test(bareVerb),
      amend: AMEND_ROOT_GIT.test(bare),
      resetHard: RESET_HARD_ROOT_GIT.test(bare),
      broadAdd: BROAD_ADD_GIT.test(bare),
      mutating: GIT_MUTATING.test(bareVerb),
    };
    if (!verdict.destructive && !verdict.amend && !verdict.resetHard && !verdict.broadAdd && !verdict.mutating) {
      process.exit(0);
    }

    // Tree-scoped exemption (mirrors src/guard.ts): an explicit `cd <dir> &&`
    // prefix executes first, so it wins over the session cwd; `git -C <dir>`
    // is checked the same way. When the op's dir resolves inside an isolated
    // tree — or outside this shared root entirely — every git-verb gate
    // (in-flight, peer, graded) is skipped: branch-local ops never block.
    const isolatedMarkers = Array.isArray(ws.config.isolatedMarkers) ? ws.config.isolatedMarkers : DEFAULT_ISOLATED_MARKERS;
    const sessionCwd = String(input.cwd ?? process.cwd());
    const cdTarget = extractCdTarget(command);
    const gitC = extractGitCDir(command);
    if (
      resolvesOutsideSharedRoot(cdTarget, ws, isolatedMarkers, sessionCwd) ||
      resolvesOutsideSharedRoot(gitC, ws, isolatedMarkers, sessionCwd) ||
      (!cdTarget && !gitC && resolvesOutsideSharedRoot(sessionCwd, ws, isolatedMarkers, sessionCwd))
    ) {
      process.exit(0);
    }

    if (READONLY_PREFIX.test(command)) process.exit(0);

    if (ws.config.inFlightGuard !== false && verdict.mutating && ws.gitDir) {
      const markers = IN_FLIGHT_MARKERS.filter((m) => fs.existsSync(path.join(ws.gitDir, m)));
      if (markers.length > 0) {
        console.error(
          `pi-checkout-guard: \`${command.slice(0, 120)}\` mutates git state while another git operation is in flight (${markers.join(", ")}). Finish or abort it first. If verified, prefix the command with ${overrideEnv}=1.`,
        );
        process.exit(2);
      }
    }

    if (verdict.destructive || verdict.broadAdd || verdict.amend || verdict.resetHard) {
      const damaged = readRows(reg).damaged;
      if (damaged > 0) {
        console.error(
          `pi-checkout-guard: cannot verify other sessions — ${damaged} unparsable line(s) in ${reg}, so peer state is unknown.\n` +
            `Repair the file (delete the damaged line(s), or delete it entirely to reset presence) or prefix the command with ${overrideEnv}=1.`,
        );
        process.exit(2);
      }
    }

    const peers = livePeers(reg, staleMs);
    const unconditional = verdict.amend || verdict.resetHard;
    const needsBlock = unconditional || ((verdict.destructive || verdict.broadAdd) && peers.length > 0);
    if (!needsBlock) process.exit(0);

    const listing = peers
      .slice(0, 6)
      .map((r) => `  - ${r.name ?? "?"} — ${r.cwd ?? "?"}`)
      .join("\n");
    const what = verdict.amend
      ? "can fold your staged change into another session's already-pushed commit — make a NEW commit instead"
      : verdict.resetHard
        ? "discards ALL uncommitted changes at this shared checkout (other sessions' WIP included)"
        : verdict.broadAdd
          ? "sweeps OTHER sessions' uncommitted files into your commit (use path-scoped git add)"
          : "mutates shared git state at this shared checkout";
    // Only mention peers when peers exist: a solo session was told to "message
    // the session(s) listed above" while the list said "(no other live sessions)".
    const peerSection =
      peers.length === 0
        ? `\nThis is blocked with no other live session registered: it discards work that may never have been registered.\n`
        : ` while ${peers.length} other live session(s) are registered here:\n${listing}\n` +
          `${ws.config.notifyHint ?? "Message the session(s) listed above before proceeding."}\n`;
    console.error(
      `pi-checkout-guard: \`${command.slice(0, 120)}\` ${what}` +
        (unconditional ? peerSection : peerSection) +
        `If nobody is affected, prefix the command with ${overrideEnv}=1.`,
    );
    process.exit(2);
  }
}
process.exit(0);
