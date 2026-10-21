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
 * NOTE: the git verb regexes are duplicated from src/git-rules.ts (TypeScript
 * source is not importable from a no-build hook). Keep them in sync.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const CONFIG_FILE = ".pi-checkout-guard.json";
const DEFAULT_STALE_MS = 12 * 60 * 60 * 1000;
const TTL_MS = 5 * 60 * 1000; // expireAt freshness for hook-written rows

function stripQuoted(command) {
  return command.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' "…" ');
}

const DESTRUCTIVE_GIT =
  /\bgit\s+(?:-{1,2}[\w-]+\s+)*(?:reset\b|stash(?!\s+(?:list|show|log))\b|checkout(?!-index)\b|restore\b|clean\b|rebase\b|merge(?!-(?:base|ours|theirs|file))\b|branch\s+-\w*[Dd]\b|worktree\s+(?:remove|destroy)\b|push\s+.*--force)/;
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

function readRows(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function livePeers(file, staleMs) {
  const now = Date.now();
  return readRows(file).filter((r) => {
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
    const verdict = {
      destructive: DESTRUCTIVE_GIT.test(bare),
      amend: AMEND_ROOT_GIT.test(bare),
      resetHard: RESET_HARD_ROOT_GIT.test(bare),
      broadAdd: BROAD_ADD_GIT.test(bare),
      mutating: GIT_MUTATING.test(bare),
    };
    if (!verdict.destructive && !verdict.amend && !verdict.resetHard && !verdict.broadAdd && !verdict.mutating) {
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
    console.error(
      `pi-checkout-guard: \`${command.slice(0, 120)}\` ${what}` +
        (unconditional ? "" : ` while ${peers.length} other live session(s) are registered here:`) +
        `\n${listing || "  (registry rows expired; TTL peers may still be active)"}\n` +
        `${ws.config.notifyHint ?? "Message the session(s) listed above before proceeding."}\n` +
        `If nobody is affected, prefix the command with ${overrideEnv}=1.`,
    );
    process.exit(2);
  }
}
process.exit(0);
