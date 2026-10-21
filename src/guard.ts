/**
 * Guard decision core — pure logic, no pi API. The extension (and the
 * Claude Code hook adapter) both drive these functions.
 *
 * Severity grading (each rule earned by a real incident):
 *   - reset --hard/--keep, commit --amend at the shared root: blocked even
 *     with NO live peers — the victim's WIP exists on disk whether or not
 *     its session registered.
 *   - other destructive verbs, broad `git add`: blocked only while other
 *     sessions are live.
 *   - git-mutating verbs while an operation is in flight (rebase-merge/,
 *     MERGE_HEAD, ...): blocked regardless of sessions — liveness can never
 *     see a session that died mid-rebase.
 *   - ops whose execution dir resolves INSIDE an isolated worktree/lane:
 *     never blocked (branch-local by construction).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  IN_FLIGHT_MARKERS,
  classifyGit,
  extractCdTarget,
  extractGitCDir,
  isReadOnlyMention,
  stripQuotes,
} from "./git-rules.ts";
import { type WorkspaceInfo, findIsolatedTree, isInside, resolveWorkspace } from "./resolve.ts";
import { type LivePeer, formatPeers, readLivePeers } from "./registry.ts";

export interface GuardDecision {
  block: true;
  reason: string;
}

export interface GuardDeps {
  pid: number;
  name: string;
  now?: () => number;
}

const PATH_FIELDS = ["path", "filePath", "file_path"] as const;

export class CheckoutGuard {
  readonly ws: WorkspaceInfo;
  private readonly pid: number;
  private readonly name: string;
  private readonly now: () => number;
  private readonly warnedTrees = new Set<string>();

  constructor(ws: WorkspaceInfo, deps: GuardDeps) {
    this.ws = ws;
    this.pid = deps.pid;
    this.name = deps.name;
    this.now = deps.now ?? Date.now;
  }

  /** Presence row for session_start. */
  presenceRow(cwd: string): { ts: number; type: "presence"; name: string; pid: number; cwd: string; kind: string; ref?: string } {
    return {
      ts: this.now(),
      type: "presence",
      name: this.name,
      pid: this.pid,
      cwd,
      kind: this.ws.sessionKind,
      ref: this.ws.isolation?.name,
    };
  }

  get registryPath(): string {
    return this.ws.registryPath;
  }

  get selfPid(): number {
    return this.pid;
  }

  livePeers(): LivePeer[] {
    return readLivePeers(this.ws.registryPath, this.pid, this.ws.config.staleMs, this.now);
  }

  formatPeers(): string {
    return formatPeers(this.livePeers(), this.ws.root);
  }

  private inFlightMarkers(): string[] {
    const common = this.ws.gitCommonDir;
    if (!common) return [];
    return IN_FLIGHT_MARKERS.filter((m) => fs.existsSync(path.join(common, m)));
  }

  /**
   * Bash/git guard for a shared-root session.
   * `execDir` = explicit working dir of the command (bash-in style), if any.
   */
  onBashCommand(command: string, execDir: string | undefined, sessionCwd: string): GuardDecision | undefined {
    if (this.ws.sessionKind !== "shared") return undefined; // isolated sessions are never git-guarded
    if (!command) return undefined;
    const { overrideEnv } = this.ws.config;
    if (command.includes(`${overrideEnv}=1`)) return undefined;

    const verdict = classifyGit(command);
    if (!verdict.destructive && !verdict.amend && !verdict.resetHard && !verdict.broadAdd && !verdict.mutating) {
      return undefined;
    }

    // The command may EXECUTE somewhere other than the session cwd. Only ops
    // resolving into THE SAME shared checkout are guarded: isolated targets
    // are branch-local; a target resolving to a DIFFERENT checkout (or to no
    // workspace at all — a brand-new dir, an unrelated tree) is not this
    // session's shared root and must pass (incident: `git init` in a fresh
    // sibling project dir was blocked as a shared-root mutation).
    const targetRaw = execDir || extractCdTarget(command);
    if (targetRaw) {
      const abs = path.isAbsolute(targetRaw) ? targetRaw : path.resolve(sessionCwd, stripQuotes(targetRaw));
      const target = resolveWorkspace(abs);
      if (!target || target.sessionKind === "isolated" || target.root !== this.ws.root) return undefined;
    }
    const gitC = extractGitCDir(command);
    if (gitC) {
      const abs = path.isAbsolute(gitC) ? gitC : path.resolve(sessionCwd, stripQuotes(gitC));
      const target = resolveWorkspace(abs);
      if (!target || target.sessionKind === "isolated" || target.root !== this.ws.root) return undefined;
    }

    if (isReadOnlyMention(command)) return undefined;

    // In-flight operation gate (liveness-independent).
    if (this.ws.config.inFlightGuard && verdict.mutating) {
      const markers = this.inFlightMarkers();
      if (markers.length > 0) {
        const peers = this.livePeers();
        return {
          block: true,
          reason:
            `pi-checkout-guard: \`${command.trim().slice(0, 120)}\` mutates git state while another ` +
            `git operation is in flight (${markers.join(", ")}). A previous session may have died ` +
            `mid-operation — finish or abort it (git rebase --continue|--abort, git merge --abort, ...) first.\n` +
            (peers.length > 0 ? `Live sessions:\n${this.formatPeers()}\n` : "") +
            `\nIf you have verified the operation state, re-run with ${overrideEnv}=1 prefixed.`,
        };
      }
    }

    if (!this.ws.config.gitGuard) return undefined;

    // Only the graded classes guard; a plain mutating verb (push/pull/commit)
    // is normal work — peers do not veto it (regression: `git push` of an
    // unrelated-to-peers branch was blocked while peers were live).
    if (!verdict.destructive && !verdict.broadAdd && !verdict.amend && !verdict.resetHard) {
      return undefined;
    }

    const peers = this.livePeers();
    const unconditional = verdict.amend || verdict.resetHard;
    if (!unconditional && peers.length === 0) return undefined;

    const what = verdict.amend
      ? "rewrites shared-root history (`--amend` at the shared checkout can fold your staged change into another session's already-pushed commit — make a NEW commit instead, or amend inside your worktree)"
      : verdict.resetHard
        ? "discards ALL uncommitted changes at the shared checkout (peers' WIP included, even sessions that never registered). Recover via git-reflog/reflog of the stash, or reset inside your own worktree"
        : verdict.broadAdd
          ? "sweeps OTHER sessions' uncommitted files into your commit (use path-scoped `git add <paths>`)"
          : "mutates shared git state at the shared checkout";

    return {
      block: true,
      reason:
        `pi-checkout-guard: \`${command.trim().slice(0, 120)}\` ${what}` +
        (unconditional ? "" : ` while ${peers.length} other live session(s) are registered here:`) +
        `\n${this.formatPeers()}\n\n` +
        `${this.ws.config.notifyHint}\n` +
        `If nobody is affected, re-run with ${this.ws.config.overrideEnv}=1 prefixed to the same command.`,
    };
  }

  /**
   * Edit/write guard. Isolated session: block targets outside the isolation
   * root. Shared session: warn (once per tree) on edits inside an isolated tree.
   * Returns { block } or { warn } — the caller turns warn into a message.
   */
  onEditCommand(
    toolName: string,
    input: Record<string, unknown>,
    sessionCwd: string,
  ): GuardDecision | { warn: string } | undefined {
    if (/bash/i.test(toolName)) return undefined;
    if (!/(edit|write)/i.test(toolName)) return undefined;

    if (this.ws.sessionKind === "isolated" && this.ws.isolation && this.ws.config.editGuard) {
      const root = this.ws.isolation.root;
      for (const field of PATH_FIELDS) {
        const value = input[field];
        if (typeof value !== "string") continue;
        const abs = path.isAbsolute(value) ? value : path.resolve(sessionCwd, value);
        if (!isInside(abs, root)) {
          return {
            block: true,
            reason:
              `pi-checkout-guard: refusing to edit outside the isolated ${this.ws.isolation.kind} ` +
              `'${this.ws.isolation.name}'. Target ${abs} is not under ${root}. ` +
              `This session was launched inside an isolated context — edits belong inside it; ` +
              `merge back from there instead of editing the shared tree.`,
          };
        }
      }
      return undefined;
    }

    // Shared session editing INTO an isolated tree: warn once per tree.
    if (this.ws.config.rootEditWarn) {
      for (const field of PATH_FIELDS) {
        const value = input[field];
        if (typeof value !== "string") continue;
        const abs = path.isAbsolute(value) ? value : path.resolve(sessionCwd, value);
        const iso = findIsolatedTree(abs, this.ws.config);
        if (iso && !this.warnedTrees.has(iso.root)) {
          this.warnedTrees.add(iso.root);
          return {
            warn:
              `pi-checkout-guard WARN (not blocked): this shared-root session is editing inside ` +
              `isolated ${iso.kind} '${iso.name}' (${iso.root}). Foreign edits in isolated trees are a ` +
              `top data-loss class — verify ownership (live sessions: /sessions) before continuing.`,
          };
        }
      }
    }
    return undefined;
  }
}

export function sessionDisplayName(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv): string {
  const envName = env.PI_SESSION_NAME || env.PI_SESSION;
  if (envName) return envName;
  const i = argv.indexOf("--name");
  if (i > 0 && argv[i + 1]) return String(argv[i + 1]);
  return `pid-${process.pid}`;
}
