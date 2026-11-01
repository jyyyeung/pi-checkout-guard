/**
 * Presence registry: one append-only JSONL file per workspace, shared across
 * linked worktrees via the git common dir (never committed).
 *
 * Row shapes:
 *   {"ts":1730000000000,"type":"presence","name":"alice","pid":123,"cwd":"/ws","kind":"shared"}
 *   {"ts":...,"type":"presence","name":"w1","pid":456,"cwd":"/ws/wt/w1","kind":"isolated","ref":"w1"}
 *   {"ts":...,"type":"claim","name":"alice","pid":123,"claim":"fixing auth flow"}
 *
 * Liveness is pid-based for in-process agents (pi extensions live inside the
 * agent process, so process.pid IS the session pid). Cross-agent adapters
 * whose hooks are ephemeral processes (e.g. Claude Code) may omit pid and set
 * expireAt instead — those rows live until the timestamp, refreshed by
 * heartbeats (same trade-off as session-lock style TTL locks).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface PresenceRow {
  ts: number;
  type: "presence";
  name: string;
  pid?: number;
  cwd?: string;
  kind?: string;
  ref?: string;
  expireAt?: number;
}

export interface ClaimRow {
  ts: number;
  type: "claim";
  name: string;
  pid?: number;
  claim: string;
}

export type RegistryRow = PresenceRow | ClaimRow;

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process EXISTS but belongs to another user (containers,
    // sudo-launched agents, shared dev boxes). Reading it as dead was fail-open
    // and silently dropped real peers. Only ESRCH (no such process) is dead.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export interface RegistryRead {
  rows: RegistryRow[];
  /** Lines that were not valid JSON — peer state is incomplete by that much. */
  damaged: number;
}

/** Parse line by line: ONE corrupt line must never erase every other peer
 *  (a whole-file try/catch returned [] and the guard then treated a busy
 *  checkout as empty — fail-open on the only data it has). Damage is counted
 *  and reported so callers can block instead of guessing. */
export function readRegistry(registryPath: string): RegistryRead {
  let text: string;
  try {
    text = fs.readFileSync(registryPath, "utf8");
  } catch {
    return { rows: [], damaged: 0 }; // no registry yet is not damage
  }
  const rows: RegistryRow[] = [];
  let damaged = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as RegistryRow).type === "string") {
        rows.push(parsed as RegistryRow);
      } else {
        damaged++;
      }
    } catch {
      damaged++;
    }
  }
  return { rows, damaged };
}

function readRows(registryPath: string): RegistryRow[] {
  return readRegistry(registryPath).rows;
}

function append(registryPath: string, row: RegistryRow): void {
  try {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.appendFileSync(registryPath, JSON.stringify(row) + "\n");
  } catch {
    /* registry write is best-effort; the guard degrades to pid-less operation */
  }
}

export function appendPresence(
  registryPath: string,
  row: Omit<PresenceRow, "ts" | "type">,
  now: () => number = Date.now,
): void {
  append(registryPath, { ts: now(), type: "presence", ...row });
}

export function appendClaim(
  registryPath: string,
  name: string,
  pid: number | undefined,
  text: string,
  now: () => number = Date.now,
): void {
  append(registryPath, { ts: now(), type: "claim", name, pid, claim: text });
}

/** Best-effort self-removal on clean shutdown; pid-liveness covers crashes. */
export function removeSelf(registryPath: string, pid: number): void {
  try {
    const rows = readRows(registryPath).filter(
      (r) => !(r.type === "presence" && r.pid === pid),
    );
    const tmp = registryPath + ".tmp";
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    fs.renameSync(tmp, registryPath);
  } catch {
    /* non-fatal */
  }
}

export interface LivePeer extends PresenceRow {
  ageMs: number;
}

/** Live = not self, fresh (staleMs), and (pid alive OR not yet expired). */
export function readLivePeers(
  registryPath: string,
  selfPid: number,
  staleMs: number,
  now: () => number = Date.now,
): LivePeer[] {
  return readLivePeersReport(registryPath, selfPid, staleMs, now).peers;
}

/** Same liveness read, plus the damaged-line count so the guard can fail CLOSED
 *  (block, "peer state unknown") instead of open (allow, "nobody here"). */
export function readLivePeersReport(
  registryPath: string,
  selfPid: number,
  staleMs: number,
  now: () => number = Date.now,
): { peers: LivePeer[]; damaged: number } {
  const nowMs = now();
  const { rows, damaged } = readRegistry(registryPath);
  const peers = rows.flatMap((r): LivePeer[] => {
    if (r.type !== "presence") return [];
    if (r.pid === selfPid) return [];
    if (nowMs - r.ts >= staleMs) return [];
    if (typeof r.pid === "number") {
      if (!alive(r.pid)) return [];
    } else if (typeof r.expireAt === "number") {
      if (nowMs >= r.expireAt) return [];
    } else {
      return [];
    }
    return [{ ...r, ageMs: nowMs - r.ts }];
  });
  return { peers, damaged };
}

/** Latest claim per live session, newest first. */
export function readClaims(registryPath: string, limit = 5, now: () => number = Date.now): ClaimRow[] {
  return readRows(registryPath)
    .filter((r): r is ClaimRow => r.type === "claim")
    .slice(-limit)
    .reverse();
}

/** Visible peer rows in guard messages; beyond this the list collapses to
 *  a `…and N more` line so coordination hints stay cheap to read. */
export const PEER_LIST_CAP = 5;

export function formatPeers(peers: LivePeer[], rootDir: string): string {
  if (peers.length === 0) return "  (no other live sessions)";
  return (
    peers
      .slice(0, PEER_LIST_CAP)
      .map((r) => {
        const age = Math.round(r.ageMs / 60000);
        const where = (r.cwd || "").startsWith(rootDir + "/") ? (r.cwd || "").slice(rootDir.length + 1) : (r.cwd || "");
        const ref = r.ref ? ` (${r.kind}:${r.ref})` : r.kind ? ` (${r.kind})` : "";
        return `  - ${r.name}${ref} — ${where || "."} — active ${age}m ago`;
      })
      .join("\n") +
    (peers.length > PEER_LIST_CAP ? `\n  …and ${peers.length - PEER_LIST_CAP} more (/sessions for full list)` : "")
  );
}
