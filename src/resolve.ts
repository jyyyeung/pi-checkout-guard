/**
 * Workspace resolution: which shared checkout does this session belong to,
 * and is the session isolated (worktree/lane) or at the shared root?
 *
 * Two passes, because isolation markers are configured per-workspace and the
 * config is only readable once the root is known:
 *
 *   Pass A (root discovery), walking up from the session cwd:
 *     1. config file (.pi-checkout-guard.json) -> root, config loaded
 *     2. `.git` FILE (linked git worktree, any manager) -> root = main
 *        checkout (common dir parent), config from there if present
 *     3. `.git` DIR -> root, default config
 *
 *   Pass B (isolation discovery), walking from the cwd up to (exclusive) the
 *   root: configured marker file, or a `.git` FILE, marks an isolated session.
 *
 * An isolated session still registers presence in the shared workspace
 * registry; the git guard only ever guards shared-root sessions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_FILE, type GuardConfig, defaultConfig, loadConfig } from "./config.ts";

export type SessionKind = "shared" | "isolated";

export interface IsolationInfo {
  root: string;
  kind: "worktree" | "lane" | "git-worktree";
  name: string;
}

export interface WorkspaceInfo {
  /** Shared workspace root (registry + peer scope). */
  root: string;
  registryPath: string;
  config: GuardConfig;
  sessionKind: SessionKind;
  isolation?: IsolationInfo;
  /** Git common dir when known (in-flight operation checks live here). */
  gitCommonDir?: string;
}

function atFsRoot(dir: string): boolean {
  return path.dirname(dir) === dir;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readMarker(dir: string, marker: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = fs.readFileSync(path.join(dir, marker), "utf8");
    for (const line of text.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {
    /* unreadable marker -> ignore */
  }
  return out;
}

/** For a linked worktree (.git FILE containing "gitdir: <main>/.git/worktrees/<n>"),
 *  return the common dir (<main>/.git). */
function linkedGitCommonDir(dir: string): string | undefined {
  try {
    const text = fs.readFileSync(path.join(dir, ".git"), "utf8").trim();
    const m = /^gitdir:\s*(.+)$/.exec(text);
    if (!m) return undefined;
    const gitdir = path.resolve(dir, m[1]);
    const wt = /[/\\]worktrees[/\\][^/\\]+$/.exec(gitdir);
    return wt ? gitdir.slice(0, wt.index) : gitdir;
  } catch {
    return undefined;
  }
}

/** Git-compatible stop-dirs: walk-up never enters these (GIT_CEILING_DIRECTORIES,
 *  colon- or comma-separated). Protects against stray .git dirs high in the
 *  tree (e.g. a forgotten /tmp/.git) capturing unrelated directories. */
function ceilingDirs(): string[] {
  const raw = process.env.GIT_CEILING_DIRECTORIES ?? "";
  return raw
    .split(/[:;,]/)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => path.resolve(d));
}

interface RootDiscovery {
  root: string;
  config: GuardConfig;
  gitCommonDir?: string;
}

function discoverRoot(cwd: string): RootDiscovery | null {
  const ceilings = ceilingDirs();

  // Single level-ordered walk: record the first hit of each kind with its
  // depth (0 = cwd). Level matters: a config marker ABOVE a child repo's .git
  // declares a multi-repo workspace (config wins); a config nested INSIDE a
  // repo (nearer than its .git) is stray and the repo wins.
  let configHit: { dir: string; level: number } | undefined;
  let linkedHit: { dir: string; level: number } | undefined;
  let gitdirHit: { dir: string; level: number } | undefined;
  let level = 0;
  for (let d = path.resolve(cwd); !atFsRoot(d); d = path.dirname(d), level++) {
    if (ceilings.includes(d)) break;
    if (!configHit && fs.existsSync(path.join(d, CONFIG_FILE))) configHit = { dir: d, level };
    if (!linkedHit && isFile(path.join(d, ".git"))) linkedHit = { dir: d, level };
    if (!gitdirHit && isDir(path.join(d, ".git"))) gitdirHit = { dir: d, level };
    if (configHit && linkedHit && gitdirHit) break;
  }

  // Decision. A config file claims its whole subtree: it wins over any .git
  // found at the same walk or above it (both the multi-repo child-repo case
  // and the stray-ancestor-repo case reduce to the same topology, and the
  // innermost declared scope is the useful reading). A .git dir strictly
  // below the config is a child repo: kept as the git common dir for
  // in-flight checks, but the config dir stays the workspace root.
  if (configHit) {
    const childGitdir = gitdirHit && gitdirHit.level < configHit.level ? gitdirHit : undefined;
    return {
      root: configHit.dir,
      config: loadConfig(configHit.dir),
      gitCommonDir: childGitdir ? path.join(childGitdir.dir, ".git") : undefined,
    };
  }
  // No config: git's own rules. Linked worktree nearer than any plain .git
  // -> shared root is the main checkout; else nearest plain repo root.
  if (linkedHit && (!gitdirHit || linkedHit.level < gitdirHit.level)) {
    const common = linkedGitCommonDir(linkedHit.dir);
    if (common) {
      const root = path.dirname(common);
      return {
        root,
        config: fs.existsSync(path.join(root, CONFIG_FILE)) ? loadConfig(root) : defaultConfig(),
        gitCommonDir: common,
      };
    }
  }
  if (gitdirHit) {
    return { root: gitdirHit.dir, config: loadConfig(gitdirHit.dir), gitCommonDir: path.join(gitdirHit.dir, ".git") };
  }
  return null;
}

function findIsolation(cwd: string, root: string, config: GuardConfig): IsolationInfo | undefined {
  for (let d = path.resolve(cwd); !atFsRoot(d) && d !== root; d = path.dirname(d)) {
    for (const marker of config.isolatedMarkers) {
      if (fs.existsSync(path.join(d, marker))) {
        const meta = readMarker(d, marker);
        const kind = marker === ".lane" ? "lane" : "worktree";
        return { root: d, kind, name: meta[`${kind.toUpperCase()}_NAME`] || path.basename(d) };
      }
    }
    if (isFile(path.join(d, ".git"))) {
      return { root: d, kind: "git-worktree", name: path.basename(d) };
    }
  }
  return undefined;
}

export function resolveWorkspace(cwd: string): WorkspaceInfo | null {
  const discovery = discoverRoot(cwd);
  if (!discovery) return null; // no workspace: extension stays passive
  const { root, config, gitCommonDir } = discovery;
  const isolation = findIsolation(cwd, root, config);

  const hasConfigAtRoot = fs.existsSync(path.join(root, CONFIG_FILE));
  const registryPath = config.registry
    ? path.isAbsolute(config.registry)
      ? config.registry
      : path.join(root, config.registry)
    : hasConfigAtRoot
      ? path.join(root, ".pi-checkout-guard", "registry.jsonl")
      : gitCommonDir
        ? path.join(gitCommonDir, "pi-checkout-guard", "registry.jsonl")
        : path.join(root, ".pi-checkout-guard", "registry.jsonl");

  return {
    root,
    registryPath,
    config,
    sessionKind: isolation ? "isolated" : "shared",
    isolation,
    gitCommonDir,
  };
}

/** If target sits inside an isolated tree, return that tree. Used by the
 *  shared-root warn tripwire (root session editing into someone's worktree). */
export function findIsolatedTree(target: string, config: GuardConfig): IsolationInfo | null {
  let dir = path.dirname(path.resolve(target));
  for (let i = 0; i < 16 && !atFsRoot(dir); i++) {
    for (const marker of config.isolatedMarkers) {
      if (fs.existsSync(path.join(dir, marker))) {
        const meta = readMarker(dir, marker);
        const kind = marker === ".lane" ? "lane" : "worktree";
        return { root: dir, kind, name: meta[`${kind.toUpperCase()}_NAME`] || path.basename(dir) };
      }
    }
    if (isFile(path.join(dir, ".git"))) {
      return { root: dir, kind: "git-worktree", name: path.basename(dir) };
    }
    dir = path.dirname(dir);
  }
  return null;
}

export function isInside(target: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
