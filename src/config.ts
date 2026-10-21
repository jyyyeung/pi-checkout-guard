/**
 * pi-checkout-guard — shared-checkout safety for concurrent agent sessions.
 *
 * Ambient session presence + peer-aware blocking of destructive git
 * operations, plus edit-escape containment for isolated worktrees.
 * See README.md for the failure classes this guards against.
 */

import * as fs from "node:fs";

export interface GuardConfig {
  /** Dirs carrying one of these marker files are isolated contexts
   *  (never git-guarded; edit-guarded against escapes). */
  isolatedMarkers: string[];
  /** Registry rows older than this are ignored (pid-liveness is primary). */
  staleMs: number;
  /** Prefix this env assignment to a blocked command to override once. */
  overrideEnv: string;
  /** Extra guidance appended to block messages (how to reach peers). */
  notifyHint: string;
  /** Peer-aware + unconditional git verb blocking at the shared root. */
  gitGuard: boolean;
  /** Block edit/write tools whose target resolves outside an isolation root. */
  editGuard: boolean;
  /** Warn (never block) when a shared-root session edits inside an isolated tree. */
  rootEditWarn: boolean;
  /** Block git-mutating verbs while another git operation is in flight
   *  (rebase-merge/, MERGE_HEAD, ...) regardless of live sessions. */
  inFlightGuard: boolean;
  /** Registry file path: absolute, or relative to the workspace root. */
  registry?: string;
}

/** Config file doubles as the workspace-root marker for multi-repo setups. */
export const CONFIG_FILE = ".pi-checkout-guard.json";

export function defaultConfig(): GuardConfig {
  return {
    isolatedMarkers: [".worktree", ".lane"],
    staleMs: 12 * 60 * 60 * 1000,
    overrideEnv: "CHECKOUT_GUARD_OVERRIDE",
    notifyHint: "Message the session(s) listed above before proceeding.",
    gitGuard: true,
    editGuard: true,
    rootEditWarn: true,
    inFlightGuard: true,
  };
}

/** Load and merge config from a directory; unreadable/bad JSON -> defaults. */
export function loadConfig(dir: string, readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): GuardConfig {
  const merged = defaultConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(`${dir}/${CONFIG_FILE}`));
  } catch {
    return merged;
  }
  if (typeof raw !== "object" || raw === null) return merged;
  const c = raw as Record<string, unknown>;
  if (Array.isArray(c.isolatedMarkers)) {
    merged.isolatedMarkers = c.isolatedMarkers.filter((m): m is string => typeof m === "string" && m.length > 0);
  }
  if (typeof c.staleMs === "number" && c.staleMs > 0) merged.staleMs = c.staleMs;
  if (typeof c.overrideEnv === "string" && c.overrideEnv) merged.overrideEnv = c.overrideEnv;
  if (typeof c.notifyHint === "string") merged.notifyHint = c.notifyHint;
  if (typeof c.gitGuard === "boolean") merged.gitGuard = c.gitGuard;
  if (typeof c.editGuard === "boolean") merged.editGuard = c.editGuard;
  if (typeof c.rootEditWarn === "boolean") merged.rootEditWarn = c.rootEditWarn;
  if (typeof c.inFlightGuard === "boolean") merged.inFlightGuard = c.inFlightGuard;
  if (typeof c.registry === "string" && c.registry) merged.registry = c.registry;
  return merged;
}
