import assert from "node:assert/strict";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { test } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import { CheckoutGuard } from "../src/guard.ts";
import { resolveWorkspace } from "../src/resolve.ts";
import { alive, appendClaim, appendPresence, formatPeers, readClaims, readLivePeers, readRegistry, removeSelf } from "../src/registry.ts";

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
  // Assert on the rows themselves, not on liveness: whether some unrelated
  // process owns pid 111 depends on the environment (a CI container's low
  // pids are live), which made a readLivePeers-based assertion fail off-laptop.
  const rows = readRegistry(reg).rows;
  const presence = rows.filter((r) => r.type === "presence");
  assert.equal(presence.length, 1);
  assert.equal(presence[0].name, "a");
  // claim rows persist: removeSelf only drops presence rows
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

test("guard: plain mutating verbs (push/commit) pass even with live peers", () => {
  const root = plainRepo();
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "test" });
  const child = liveChild();
  appendPresence(ws.registryPath, { name: "peer", pid: child.pid, cwd: root });

  assert.equal(guard.onBashCommand("git push -q -u origin main", undefined, root), undefined);
  assert.equal(guard.onBashCommand('git commit -q -m "feat: x"', undefined, root), undefined);
  assert.equal(guard.onBashCommand("git pull --rebase", undefined, root), undefined);
  // graded classes still block with the same peer present
  assert.ok(guard.onBashCommand("git checkout main", undefined, root)?.block);
  child.kill();
});

test("guard: ops in a DIFFERENT checkout or a workspace-less dir are never blocked (regression: git init in fresh sibling dir)", () => {
  const root = plainRepo();
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "test" });
  const child = liveChild();
  appendPresence(ws.registryPath, { name: "peer", pid: child.pid, cwd: root });

  // different checkout (another repo)
  const other = plainRepo();
  assert.equal(guard.onBashCommand(`cd ${other} && git merge main`, undefined, root), undefined);
  // no workspace at all (fresh dir, no git, no config)
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ccg-bare-"));
  assert.equal(guard.onBashCommand(`cd ${bare} && git init`, undefined, root), undefined);
  // same-root child repo still guarded (config marker declares one workspace)
  const wsRoot = tmpdir();
  write(wsRoot, ".pi-checkout-guard.json", "{}");
  const childRepo = path.join(wsRoot, "backend");
  fs.mkdirSync(path.join(childRepo, ".git"), { recursive: true });
  const ws2 = resolveWorkspace(wsRoot)!;
  const guard2 = new CheckoutGuard(ws2, { pid: process.pid, name: "test" });
  const peer2 = liveChild();
  appendPresence(ws2.registryPath, { name: "peer", pid: peer2.pid, cwd: wsRoot });
  assert.ok(guard2.onBashCommand(`cd ${childRepo} && git merge main`, undefined, wsRoot)?.block);
  peer2.kill();
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

test("guard: editing inside a tree this session owns (OWNER_SESSION) is silent", () => {
  const root = tmpdir();
  write(root, ".pi-checkout-guard.json", "{}");
  const wt = path.join(root, "worktrees", "w1");
  write(wt, ".worktree", "WORKTREE_NAME=w1\nOWNER_SESSION=test\n");
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "test" });

  assert.equal(guard.onEditCommand("write", { path: path.join(wt, "x.ts") }, root), undefined);
  // once-per-tree bookkeeping: still silent on later edits
  assert.equal(guard.onEditCommand("write", { path: path.join(wt, "y.ts") }, root), undefined);
});

test("guard: OWNER_SESSION tolerant id match — short/full session ids and PI_SESSION_ID", () => {
  const root = tmpdir();
  write(root, ".pi-checkout-guard.json", "{}");
  const ws = resolveWorkspace(root)!;

  // stamp holds the SHORT id, session name is the full id (prefix relation)
  const wtShort = path.join(root, "worktrees", "short");
  write(wtShort, ".worktree", "OWNER_SESSION=sess-42\n");
  const byName = new CheckoutGuard(ws, { pid: process.pid, name: "sess-42-full-abcdef" });
  assert.equal(byName.onEditCommand("write", { path: path.join(wtShort, "x.ts") }, root), undefined);

  // stamp holds the FULL id, session only knows the short one via env
  const wtFull = path.join(root, "worktrees", "full");
  write(wtFull, ".worktree", "OWNER_SESSION=another-777-full-abcdef\n");
  const prev = process.env.PI_SESSION_ID;
  process.env.PI_SESSION_ID = "another-777";
  try {
    const byEnv = new CheckoutGuard(ws, { pid: process.pid, name: "unrelated-name" });
    assert.equal(byEnv.onEditCommand("write", { path: path.join(wtFull, "x.ts") }, root), undefined);
  } finally {
    if (prev === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = prev;
  }
});

test("guard: editing inside a foreign tree with a live owner names the owner; unknown keeps generic warn", () => {
  const root = tmpdir();
  write(root, ".pi-checkout-guard.json", "{}");
  const owned = path.join(root, "worktrees", "owned");
  write(owned, ".worktree", "WORKTREE_NAME=owned\n");
  const unknown = path.join(root, "worktrees", "unknown");
  write(unknown, ".worktree", "WORKTREE_NAME=unknown\n");
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "test" });
  const child = liveChild();
  appendPresence(ws.registryPath, { name: "wt-owner", pid: child.pid, cwd: path.join(owned, "src") });

  const named = guard.onEditCommand("write", { path: path.join(owned, "x.ts") }, root);
  assert.ok(named !== undefined && "warn" in named);
  assert.match(named.warn, /Owned by wt-owner \(live\) — coordinate with them before editing\./);
  assert.doesNotMatch(named.warn, /verify ownership/);

  // nothing resolvable: no OWNER_SESSION, no live peer inside the tree
  const generic = guard.onEditCommand("write", { path: path.join(unknown, "x.ts") }, root);
  assert.ok(generic !== undefined && "warn" in generic);
  assert.match(generic.warn, /verify ownership \(live sessions: \/sessions\) before continuing\./);
  child.kill();
});

test("guard: worktree-scoped git verbs never blocked (cd prefix, git -C, cwd inside the tree)", () => {
  const root = tmpdir();
  write(root, ".pi-checkout-guard.json", "{}");
  const wtA = path.join(root, "worktrees", "wt-a");
  write(wtA, ".worktree", "WORKTREE_NAME=wt-a\n");
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "test" });
  const child = liveChild();
  appendPresence(ws.registryPath, { name: "peer", pid: child.pid, cwd: root });

  // cd prefix into the worktree — with and without an explicit tool exec dir
  assert.equal(guard.onBashCommand("cd worktrees/wt-a && git commit --amend --no-edit", undefined, root), undefined);
  assert.equal(guard.onBashCommand("cd worktrees/wt-a && git commit --amend --no-edit", root, root), undefined);
  // git -C into the worktree
  assert.equal(guard.onBashCommand("git -C worktrees/wt-a commit --amend --no-edit", undefined, root), undefined);
  assert.equal(guard.onBashCommand("git -C worktrees/wt-a push", undefined, root), undefined);
  assert.equal(guard.onBashCommand("git -C worktrees/wt-a rebase main", undefined, root), undefined);
  assert.equal(guard.onBashCommand("git -C worktrees/wt-a reset --hard", undefined, root), undefined);
  // session cwd itself inside the worktree (guard resolved from the shared root)
  assert.equal(guard.onBashCommand("git commit --amend --no-edit", undefined, wtA), undefined);
  assert.equal(guard.onBashCommand("git rebase main", undefined, wtA), undefined);

  // the same graded verbs at the shared root still block
  assert.ok(guard.onBashCommand("git commit --amend --no-edit", undefined, root)?.block);
  assert.ok(guard.onBashCommand("git rebase main", undefined, root)?.block);
  assert.ok(guard.onBashCommand("git merge main", undefined, root)?.block);
  child.kill();
});

test("guard: worktree-scoped verbs are exempt from the in-flight gate too", () => {
  const root = plainRepo();
  write(root, ".git/rebase-merge", "on to main\n");
  const wtA = path.join(root, "worktrees", "wt-a");
  write(wtA, ".worktree", "WORKTREE_NAME=wt-a\n");
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "test" });

  assert.equal(guard.onBashCommand("cd worktrees/wt-a && git push", undefined, root), undefined);
  assert.equal(guard.onBashCommand("git -C worktrees/wt-a push", undefined, root), undefined);
  // shared-root mutations still hit the in-flight gate
  const blocked = guard.onBashCommand("git push", undefined, root);
  assert.ok(blocked?.block);
  assert.match(blocked.reason, /rebase-merge/);
});

test("formatPeers caps the visible list at 5 names with an …and N more tail", () => {
  const root = plainRepo();
  const reg = resolveWorkspace(root)!.registryPath;
  const fakeNow = Date.now();
  const now = () => fakeNow;
  const children = Array.from({ length: 7 }, (_, i) => liveChild());
  children.forEach((c, i) => appendPresence(reg, { name: `p${i + 1}`, pid: c.pid, cwd: root }, now));
  const peers = readLivePeers(reg, process.pid, 12 * 3600_000, now);

  const crowded = formatPeers(peers, root);
  assert.ok(crowded.includes("  - p5 —"));
  assert.ok(!crowded.includes("  - p6 —"));
  assert.match(crowded, /…and 2 more \(\/sessions for full list\)/);

  const small = formatPeers(peers.slice(0, 5), root);
  assert.ok(small.includes("  - p5 —"));
  assert.doesNotMatch(small, /…and /);
  children.forEach((c) => c.kill());
});

test("guard: block message swaps per-session notifyHint for a broadcast hint when peers exceed 5", () => {
  const root = plainRepo();
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "test" });

  const children = Array.from({ length: 6 }, () => liveChild());
  children.forEach((c, i) => appendPresence(ws.registryPath, { name: `p${i + 1}`, pid: c.pid, cwd: root }));
  const crowded = guard.onBashCommand("git merge main", undefined, root);
  assert.ok(crowded?.block);
  assert.match(crowded.reason, /…and 1 more \(\/sessions for full list\)/);
  assert.match(crowded.reason, /broadcast once \(e\.g\. via intercom\)/);
  assert.doesNotMatch(crowded.reason, /Message the session\(s\) listed above/);
  children.forEach((c) => c.kill());

  const one = liveChild();
  const root2 = plainRepo();
  const ws2 = resolveWorkspace(root2)!;
  const guard2 = new CheckoutGuard(ws2, { pid: process.pid, name: "test" });
  appendPresence(ws2.registryPath, { name: "solo", pid: one.pid, cwd: root2 });
  const small = guard2.onBashCommand("git merge main", undefined, root2);
  assert.ok(small?.block);
  assert.match(small.reason, /Message the session\(s\) listed above before proceeding\./);
  assert.doesNotMatch(small.reason, /broadcast once/);
  one.kill();
});

test("guard: abort-like verbs are never blocked by the in-flight gate (the deadlock)", () => {
  const root = plainRepo();
  write(root, ".git/rebase-merge", "on to main\n");
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "solo-session" });
  // regression: these were blocked by the very gate whose message told you to run them
  assert.equal(guard.onBashCommand("git rebase --abort", undefined, root), undefined);
  assert.equal(guard.onBashCommand("git rebase --continue", undefined, root), undefined);
  assert.equal(guard.onBashCommand("git rebase --skip", undefined, root), undefined);
  assert.equal(guard.onBashCommand("git merge --abort", undefined, root), undefined);
  assert.equal(guard.onBashCommand("git cherry-pick --abort", undefined, root), undefined);
  // a second, genuinely mutating verb on the same line still counts
  const both = guard.onBashCommand("git rebase --abort; git commit -m wip", undefined, root);
  assert.ok(both?.block);
});

test("guard: abort-like verbs pass with a live peer too", () => {
  const root = plainRepo();
  write(root, ".git/rebase-merge", "on to main\n");
  const peer = liveChild();
  try {
    const ws = resolveWorkspace(root)!;
    const guard = new CheckoutGuard(ws, { pid: process.pid, name: "me" });
    appendPresence(ws.registryPath, { name: "peer", pid: peer.pid, cwd: root, kind: "shared" });
    assert.equal(guard.onBashCommand("git rebase --abort", undefined, root), undefined);
  } finally {
    peer.kill();
  }
});

test("guard: a damaged registry fails CLOSED, not open", () => {
  const root = plainRepo();
  const peer = liveChild();
  try {
    const ws = resolveWorkspace(root)!;
    const guard = new CheckoutGuard(ws, { pid: process.pid, name: "me" });
    appendPresence(ws.registryPath, { name: "peer", pid: peer.pid, cwd: root, kind: "shared" });
    fs.appendFileSync(ws.registryPath, "{oops not json\n");
    // regression: one bad line made readLivePeers() return [] -> `git checkout .` passed
    const decision = guard.onBashCommand("git checkout .", undefined, root);
    assert.ok(decision?.block);
    assert.match(decision.reason, /unparsable line/);
    assert.match(decision.reason, /CHECKOUT_GUARD_OVERRIDE=1/);
    // the override still works, and read-only ops are unaffected
    assert.equal(guard.onBashCommand("CHECKOUT_GUARD_OVERRIDE=1 git checkout .", undefined, root), undefined);
    assert.equal(guard.onBashCommand("git status", undefined, root), undefined);
    assert.equal(guard.registryDamage, 1);
  } finally {
    peer.kill();
  }
});

test("guard: read-only spellings pass at one peer, real ones still block", () => {
  const root = plainRepo();
  const peer = liveChild();
  try {
    const ws = resolveWorkspace(root)!;
    const guard = new CheckoutGuard(ws, { pid: process.pid, name: "me" });
    appendPresence(ws.registryPath, { name: "peer", pid: peer.pid, cwd: root, kind: "shared" });
    // read-only / non-destructive spellings that used to be blocked
    assert.equal(guard.onBashCommand("git clean -nd", undefined, root), undefined);
    assert.equal(guard.onBashCommand("git clean -nfd", undefined, root), undefined);
    assert.equal(guard.onBashCommand("git clean --dry-run", undefined, root), undefined);
    assert.equal(guard.onBashCommand("git checkout -b feat/x", undefined, root), undefined);
    assert.equal(guard.onBashCommand("git switch -c feat/y", undefined, root), undefined);
    // gaps that used to pass
    assert.ok(guard.onBashCommand("git clean -fd", undefined, root)?.block);
    assert.ok(guard.onBashCommand("git branch --delete old", undefined, root)?.block);
    assert.ok(guard.onBashCommand("git push origin +main", undefined, root)?.block);
    assert.ok(guard.onBashCommand("git push --delete origin old", undefined, root)?.block);
    assert.ok(guard.onBashCommand("git push --force-with-lease", undefined, root)?.block);
    // path-discarding checkout forms still block
    assert.ok(guard.onBashCommand("git checkout -b x -- .", undefined, root)?.block);
    assert.ok(guard.onBashCommand("git checkout .", undefined, root)?.block);
  } finally {
    peer.kill();
  }
});

test("guard: solo unconditional block does not tell you to message sessions that do not exist", () => {
  const root = plainRepo();
  const ws = resolveWorkspace(root)!;
  const guard = new CheckoutGuard(ws, { pid: process.pid, name: "solo" });
  const decision = guard.onBashCommand("git reset --hard HEAD", undefined, root);
  assert.ok(decision?.block);
  assert.doesNotMatch(decision.reason, /no other live sessions/);
  assert.doesNotMatch(decision.reason, /Message the session\(s\) listed above/);
  assert.match(decision.reason, /no other live session registered/);
});

test("registry: alive() treats EPERM as alive (process exists, other owner)", () => {
  // pid 1 always exists and is never ours -> EPERM on any normal account
  assert.equal(alive(1), true);
  assert.equal(alive(process.pid), true);
  assert.equal(alive(0x7ffffff0), false); // ESRCH
});

test("registry: one corrupt line no longer erases every live peer", () => {
  const root = plainRepo();
  const peer = liveChild();
  try {
    const ws = resolveWorkspace(root)!;
    appendPresence(ws.registryPath, { name: "peer", pid: peer.pid, cwd: root, kind: "shared" });
    fs.appendFileSync(ws.registryPath, "{oops not json\n");
    const peers = readLivePeers(ws.registryPath, process.pid, 12 * 3600_000);
    assert.equal(peers.length, 1);
    assert.equal(peers[0].name, "peer");
  } finally {
    peer.kill();
  }
});
