import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BROAD_ADD_GIT,
  DESTRUCTIVE_GIT,
  classifyGit,
  extractCdTarget,
  extractGitCDir,
  isReadOnlyMention,
} from "../src/git-rules.ts";

test("destructive verbs match", () => {
  assert.ok(DESTRUCTIVE_GIT.test("git reset HEAD~1"));
  assert.ok(DESTRUCTIVE_GIT.test("git stash"));
  assert.ok(DESTRUCTIVE_GIT.test("git stash drop stash@{0}"));
  assert.ok(DESTRUCTIVE_GIT.test("git checkout main"));
  assert.ok(DESTRUCTIVE_GIT.test("git restore ."));
  assert.ok(DESTRUCTIVE_GIT.test("git clean -fd"));
  assert.ok(DESTRUCTIVE_GIT.test("git rebase main"));
  assert.ok(DESTRUCTIVE_GIT.test("git merge feature"));
  assert.ok(DESTRUCTIVE_GIT.test("git branch -D wip"));
  assert.ok(DESTRUCTIVE_GIT.test("git branch -d merged-feat"));
  assert.ok(DESTRUCTIVE_GIT.test("git worktree remove wt1"));
  assert.ok(DESTRUCTIVE_GIT.test("git push origin main --force"));
});

test("read-only variants never match (incident: false positives trained agents to ignore the guard)", () => {
  assert.ok(!DESTRUCTIVE_GIT.test("git merge-base main feature"));
  assert.ok(!DESTRUCTIVE_GIT.test("git checkout-index --help"));
  assert.ok(!DESTRUCTIVE_GIT.test("git stash list"));
  assert.ok(!DESTRUCTIVE_GIT.test("git stash show"));
  assert.ok(!DESTRUCTIVE_GIT.test("git stash log -1"));
  assert.ok(!DESTRUCTIVE_GIT.test("git status"));
  assert.ok(!DESTRUCTIVE_GIT.test("git log --oneline"));
  assert.ok(!DESTRUCTIVE_GIT.test("git branch new-feat"));
  assert.ok(!DESTRUCTIVE_GIT.test("git branch --list"));
});

test("reset --hard/--keep detected, soft reset not", () => {
  assert.ok(classifyGit("git reset --hard").resetHard);
  assert.ok(classifyGit("git reset --keep").resetHard);
  assert.ok(classifyGit("git -C sub reset --hard origin/main").resetHard);
  assert.ok(!classifyGit("git reset --soft HEAD~1").resetHard);
  assert.ok(!classifyGit("git reset").resetHard);
});

test("amend detected, plain commit not", () => {
  assert.ok(classifyGit("git commit --amend --no-edit").amend);
  assert.ok(classifyGit("git commit -m x --amend").amend);
  assert.ok(!classifyGit("git commit -m 'feat: x'").amend);
});

test("broad add detected, path-scoped add not", () => {
  assert.ok(BROAD_ADD_GIT.test("git add -A"));
  assert.ok(BROAD_ADD_GIT.test("git add --all"));
  assert.ok(BROAD_ADD_GIT.test("git add ."));
  assert.ok(!BROAD_ADD_GIT.test("git add src/lib.ts"));
  assert.ok(!BROAD_ADD_GIT.test("git add src/ tests/"));
});

test("verbs mentioned inside quoted strings never classify (incident: docs commit explaining --amend was blocked as an amend)", () => {
  assert.ok(!classifyGit('git commit -m "never run --amend on main"').amend);
  assert.ok(!classifyGit("git commit -m 'why reset --hard is dangerous'").resetHard);
  assert.ok(!classifyGit('git commit -m "we git clean -fd\u2026 later"').destructive);
  assert.ok(classifyGit('git commit --amend -m "fix typo"').amend); // real amend still caught
  assert.ok(classifyGit('git stash drop "stash@{0}"').destructive); // quoted args of a real verb still caught
});

test("read-only prefixes exempt mentions of verbs", () => {
  assert.ok(isReadOnlyMention("grep 'git reset --hard' logs.txt"));
  assert.ok(isReadOnlyMention("echo 'git clean -fd' >> notes.md"));
  assert.ok(!isReadOnlyMention("git clean -fd"));
});

test("cd and git -C targets extracted", () => {
  assert.equal(extractCdTarget("cd /tmp/wt && git merge main"), "/tmp/wt");
  assert.equal(extractCdTarget('cd "my dir" && git rebase'), '"my dir"');
  assert.equal(extractCdTarget("git merge main"), undefined);
  assert.equal(extractGitCDir("git -C /tmp/wt merge main"), "/tmp/wt");
  assert.equal(extractGitCDir("git merge main"), undefined);
});

test("mutating classification (in-flight gate scope)", () => {
  assert.ok(classifyGit("git commit -m x").mutating);
  assert.ok(classifyGit("git switch -c feat").mutating);
  assert.ok(classifyGit("git pull --rebase").mutating);
  assert.ok(!classifyGit("git status").mutating);
  assert.ok(!classifyGit("git log").mutating);
  assert.ok(!classifyGit("git diff --staged").mutating);
});
