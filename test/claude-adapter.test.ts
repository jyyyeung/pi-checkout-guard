/**
 * Claude Code hook adapter tests: spawn hooks/claude-checkout-guard.mjs with
 * fake PreToolUse hook-input JSON (exactly how Claude Code invokes it) and
 * assert the tree-scoped git-verb exemption matches src/guard.ts:
 * ops resolving inside an isolated tree are never blocked, the same verbs at
 * the shared root keep the full guard, and presence registration is unchanged.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { test } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "claude-checkout-guard.mjs");

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccg-hook-"));
}

function write(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** Plain single-repo workspace (adapter's findRoot walks up to .git): root/.git dir. */
function plainRepo(): string {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

function runAdapter(input: Record<string, unknown>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ADAPTER], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function hookInput(cwd: string, command: string): Record<string, unknown> {
  return {
    session_id: "test-claude",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    cwd,
    tool_input: { command },
  };
}

test("adapter: worktree-scoped git verbs allowed (cwd inside tree, git -C, cd prefix)", async () => {
  const root = plainRepo();
  const wtA = path.join(root, "worktrees", "wt-a");
  write(wtA, ".worktree", "WORKTREE_NAME=wt-a\n");

  // amend with the session cwd inside the own worktree
  const inTree = await runAdapter(hookInput(wtA, "git commit --amend --no-edit"));
  assert.equal(inTree.code, 0, inTree.stderr);

  // git -C into the worktree from the shared root (relative and absolute)
  const cRel = await runAdapter(hookInput(root, "git -C worktrees/wt-a push"));
  assert.equal(cRel.code, 0, cRel.stderr);
  const cAbs = await runAdapter(hookInput(root, `git -C ${wtA} rebase main`));
  assert.equal(cAbs.code, 0, cAbs.stderr);

  // leading cd into the worktree — the cd target wins over the session cwd
  const cd = await runAdapter(hookInput(root, "cd worktrees/wt-a && git commit --amend --no-edit"));
  assert.equal(cd.code, 0, cd.stderr);

  // non-git behavior untouched: every invocation still registers presence (TTL row)
  const reg = path.join(root, ".git", "pi-checkout-guard", "registry.jsonl");
  const rows = fs.readFileSync(reg, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.type === "presence" && r.session === "test-claude" && typeof r.expireAt === "number"));
});

test("adapter: same git verbs at the shared root still blocked", async () => {
  const root = plainRepo();
  const wtA = path.join(root, "worktrees", "wt-a");
  write(wtA, ".worktree", "WORKTREE_NAME=wt-a\n");

  // amend is blocked regardless of live peers
  const amend = await runAdapter(hookInput(root, "git commit --amend --no-edit"));
  assert.equal(amend.code, 2);
  assert.match(amend.stderr, /amend|--amend/);

  // push and rebase hit the in-flight gate while a rebase is mid-flight
  write(root, path.join(".git", "rebase-merge"), "on to main\n");
  const push = await runAdapter(hookInput(root, "git push"));
  assert.equal(push.code, 2);
  assert.match(push.stderr, /rebase-merge/);
  const rebase = await runAdapter(hookInput(root, "git rebase main"));
  assert.equal(rebase.code, 2);
  assert.match(rebase.stderr, /rebase-merge/);
});

test("adapter: worktree-scoped verbs exempt from the in-flight gate too", async () => {
  const root = plainRepo();
  write(root, path.join(".git", "rebase-merge"), "on to main\n");
  const wtA = path.join(root, "worktrees", "wt-a");
  write(wtA, ".worktree", "WORKTREE_NAME=wt-a\n");

  // shared root has an op in flight, but ops resolving into the tree pass
  const cd = await runAdapter(hookInput(root, "cd worktrees/wt-a && git push"));
  assert.equal(cd.code, 0, cd.stderr);
  const cDir = await runAdapter(hookInput(root, "git -C worktrees/wt-a push"));
  assert.equal(cDir.code, 0, cDir.stderr);
  const cwd = await runAdapter(hookInput(wtA, "git push"));
  assert.equal(cwd.code, 0, cwd.stderr);
});
