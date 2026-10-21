import assert from "node:assert/strict";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { test } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import { CheckoutGuard } from "../src/guard.ts";
import { resolveWorkspace } from "../src/resolve.ts";
import { appendClaim, appendPresence, readClaims, readLivePeers, removeSelf } from "../src/registry.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccg-"));
}

/** Real live peer pid: a child that stays alive until killed. */
function liveChild(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  return { pid: child.pid!, kill: () => child.kill() };
}

function write(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** Plain single-repo workspace: root/.git dir + one source file. */
function plainRepo(): string {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  write(root, "src/a.ts", "export {};\n");
  return root;
}

test("resolve: plain git repo -> shared session at root", () => {
  const root = plainRepo();
  const ws = resolveWorkspace(path.join(root, "src"));
  assert.ok(ws);
  assert.equal(ws.root, root);
  assert.equal(ws.sessionKind, "shared");
  assert.equal(ws.registryPath, path.join(root, ".git", "pi-checkout-guard", "registry.jsonl"));
});

test("resolve: linked git worktree (.git file) -> isolated session, registry in common dir", () => {
  const main = plainRepo();
  const wt = path.join(path.dirname(main), "wt-x");
  fs.mkdirSync(wt, { recursive: true });
  write(main, ".git/worktrees/wt-x/HEAD", "ref: refs/heads/wt-x\n");
  write(wt, ".git", `gitdir: ${path.join(main, ".git", "worktrees", "wt-x")}\n`);
  const ws = resolveWorkspace(path.join(wt, "src"));
  assert.ok(ws);
  assert.equal(ws.sessionKind, "isolated");
  assert.equal(ws.isolation?.kind, "git-worktree");
  assert.equal(ws.isolation?.name, "wt-x");
  assert.equal(ws.root, main);
  assert.equal(ws.registryPath, path.join(main, ".git", "pi-checkout-guard", "registry.jsonl"));
});

test("resolve: config marker -> multi-repo workspace root (child repos resolve up)", () => {
  const root = tmpdir();
  write(root, ".pi-checkout-guard.json", JSON.stringify({ isolatedMarkers: [".wt"] }));
  fs.mkdirSync(path.join(root, "backend", ".git"), { recursive: true });
  const ws = resolveWorkspace(path.join(root, "backend", "src"));
  assert.ok(ws);
  assert.equal(ws.root, root);
  assert.equal(ws.sessionKind, "shared");
  assert.deepEqual(ws.config.isolatedMarkers, [".wt"]);
});

test("resolve: marker dir -> isolated session, workspace root still resolved", () => {
  const root = tmpdir();
  write(root, ".pi-checkout-guard.json", "{}");
  const wt = path.join(root, "worktrees", "w1");
  write(wt, ".worktree", "WORKTREE_NAME=w1\n");
  write(wt, "src/a.ts", "");
  const ws = resolveWorkspace(path.join(wt, "src"));
  assert.ok(ws);
  assert.equal(ws.sessionKind, "isolated");
  assert.equal(ws.isolation?.name, "w1");
  assert.equal(ws.isolation?.kind, "worktree");
  assert.equal(ws.root, root);
});

test("resolve: no git, no config below ceiling -> inactive", () => {
  const prev = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
  try {
    assert.equal(resolveWorkspace(tmpdir()), null);
  } finally {
    if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prev;
  }
});

test("registry: pid liveness filters dead and self; expireAt rows honored", () => {
  const root = plainRepo();
  const ws = resolveWorkspace(root)!;
  const reg = ws.registryPath;
  const child = liveChild();
  const fakeNow = Date.now();
  const now = () => fakeNow;
  appendPresence(reg, { name: "live-peer", pid: child.pid, cwd: root }, now);
  appendPresence(reg, { name: "dead-peer", pid: 2147483000, cwd: root }, now); // nonexistent pid
  appendPresence(reg, { name: "self", pid: process.pid, cwd: root }, now);
  appendPresence(reg, { name: "ttl-peer", expireAt: fakeNow + 60_000, cwd: root }, now);
  appendPresence(reg, { name: "expired-peer", expireAt: fakeNow - 1, cwd: root }, now);

  const live = readLivePeers(reg, process.pid, 12 * 3600_000, now);
  assert.deepEqual(live.map((p) => p.name).sort(), ["live-peer", "ttl-peer"]);

  const later = fakeNow + 13 * 3600_000; // everything stale by then
  assert.equal(readLivePeers(reg, process.pid, 12 * 3600_000, () => later).length, 0);
  child.kill();
});

test("registry: removeSelf drops own presence rows only", () => {
  const root = plainRepo();
  const reg = resolveWorkspace(root)!.registryPath;
  appendPresence(reg, { name: "a", pid: 111, cwd: root });
  appendPresence(reg, { name: "me", pid: process.pid, cwd: root });
  appendClaim(reg, "me", process.pid, "doing x");
  removeSelf(reg, process.pid);
  const live = readLivePeers(reg, 999, 12 * 3600_000);
  // pid 111 is dead -> filtered by liveness, not removal; claim rows persist
  assert.equal(live.length, 0);
  assert.equal(readClaims(reg).length, 1);
});

test("guard: destructive verb blocked only with live peer; reset --hard / amend unconditional", () => {
  const root = plainRepo();
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "test" });

  // no peers: plain destructive passes
  assert.equal(guard.onBashCommand("git checkout main", undefined, root), undefined);
  // with peer: blocked
  const child = liveChild();
  appendPresence(ws.registryPath, { name: "peer", pid: child.pid, cwd: root });
  const blocked = guard.onBashCommand("git checkout main", undefined, root);
  assert.ok(blocked?.block);
  assert.match(blocked.reason, /peer/);

  // unconditional classes: blocked even without peers
  const fresh = plainRepo();
  const ws2 = resolveWorkspace(fresh)!;
  const guard2 = new CheckoutGuard(ws2, { pid: process.pid, name: "test" });
  assert.ok(guard2.onBashCommand("git reset --hard", undefined, fresh)?.block);
  assert.ok(guard2.onBashCommand("git commit --amend --no-edit", undefined, fresh)?.block);
  assert.equal(guard2.onBashCommand("git reset --soft HEAD~1", undefined, fresh), undefined);
  child.kill();
});

test("guard: broad add blocked with peer; override env and read-only prefix pass", () => {
  const root = plainRepo();
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "test" });
  const child = liveChild();
  appendPresence(ws.registryPath, { name: "peer", pid: child.pid, cwd: root });

  assert.ok(guard.onBashCommand("git add -A", undefined, root)?.block);
  assert.equal(guard.onBashCommand("CHECKOUT_GUARD_OVERRIDE=1 git add -A", undefined, root), undefined);
  assert.equal(guard.onBashCommand("grep 'git clean -fd' log.txt", undefined, root), undefined);
  child.kill();
});

test("guard: ops resolving into isolated dirs are never blocked", () => {
  const root = tmpdir();
  write(root, ".pi-checkout-guard.json", "{}");
  const wt = path.join(root, "worktrees", "w1");
  write(wt, ".worktree", "WORKTREE_NAME=w1\n");
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "test" });
  const child = liveChild();
  appendPresence(ws.registryPath, { name: "peer", pid: child.pid, cwd: root });

  // leading cd into worktree
  assert.equal(guard.onBashCommand(`cd ${wt} && git merge main`, undefined, root), undefined);
  // git -C into worktree
  assert.equal(guard.onBashCommand(`git -C ${wt} reset --hard`, undefined, root), undefined);
  // bash-in style explicit dir
  assert.equal(guard.onBashCommand("git merge main", wt, root), undefined);
  // same op at root still blocked
  assert.ok(guard.onBashCommand("git merge main", undefined, root)?.block);
  child.kill();
});

test("guard: in-flight operation gate blocks mutations regardless of sessions", () => {
  const root = plainRepo();
  write(root, ".git/rebase-merge", "on to main\n");
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "test" });
  const blocked = guard.onBashCommand("git commit -m wip", undefined, root);
  assert.ok(blocked?.block);
  assert.match(blocked.reason, /rebase-merge/);
  // read-only op passes even mid-flight
  assert.equal(guard.onBashCommand("git status", undefined, root), undefined);
});

test("guard: isolated session — git never guarded, edit escape blocked, inside edit allowed", () => {
  const root = tmpdir();
  write(root, ".pi-checkout-guard.json", "{}");
  const wt = path.join(root, "worktrees", "w1");
  write(wt, ".worktree", "WORKTREE_NAME=w1\n");
  write(wt, "src/a.ts", "");
  const ws = resolveWorkspace(path.join(wt, "src"))!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "w1" });
  const insideCwd = path.join(wt, "src");

  assert.equal(guard.onBashCommand("git reset --hard", undefined, insideCwd), undefined);
  const escape = guard.onEditCommand("edit", { path: path.join(root, "shared.ts") }, insideCwd);
  assert.ok(escape !== undefined && "block" in escape);
  assert.equal(guard.onEditCommand("edit", { path: path.join(wt, "src", "b.ts") }, insideCwd), undefined);
});

test("guard: shared session editing into isolated tree warns once", async () => {
  const root = tmpdir();
  write(root, ".pi-checkout-guard.json", "{}");
  const wt = path.join(root, "worktrees", "w1");
  write(wt, ".worktree", "WORKTREE_NAME=w1\n");
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "root" });

  const first = guard.onEditCommand("write", { path: path.join(wt, "x.ts") }, root);
  assert.ok(first !== undefined && "warn" in first);
  const second = guard.onEditCommand("write", { path: path.join(wt, "y.ts") }, root);
  assert.equal(second, undefined); // once per tree
});
