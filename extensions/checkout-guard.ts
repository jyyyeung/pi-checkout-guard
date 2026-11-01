/**
 * pi-checkout-guard extension for the pi coding agent.
 *
 * Ambient shared-checkout safety for concurrent agent sessions:
 *
 *   1. PRESENCE — on session_start, register this session (name, pid, cwd,
 *      isolation kind) in the workspace registry; deregister on shutdown.
 *      Crashed sessions drop out via pid-liveness — the extension lives
 *      inside the agent process, so process.pid IS the session pid.
 *
 *   2. GIT GUARD — shared-root sessions get destructive git verbs blocked
 *      while other live sessions are registered (and unconditionally for
 *      reset --hard/--keep and commit --amend, whose victims need not be
 *      live). Ops resolving INSIDE an isolated worktree are never blocked.
 *
 *   3. IN-FLIGHT GATE — git-mutating verbs are blocked while a rebase/merge/
 *      cherry-pick/revert/bisect is mid-flight in the git common dir,
 *      regardless of sessions (liveness cannot see a dead mid-rebase session).
 *      `git rebase --abort|--continue|--skip` are exempt: they RESOLVE the
 *      in-flight state, so gating them deadlocked the escape hatch.
 *
 *   4. EDIT CONTAINMENT — sessions inside an isolated worktree/lane cannot
 *      edit outside it; shared-root sessions get a warn tripwire when they
 *      edit into someone's isolated tree.
 *
 *   5. /sessions — list live sessions (and recent claims) for this workspace.
 *
 * Workspace resolution is LAZY, per tool call, from the session cwd: pi
 * started outside a repo and then asked to work inside one used to leave the
 * extension permanently passive, because the factory resolved nothing at load.
 *
 * Disable entirely with CHECKOUT_GUARD_DISABLE=1. Override a single block by
 * prefixing the command with CHECKOUT_GUARD_OVERRIDE=1 (configurable).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { CheckoutGuard, sessionDisplayName } from "../src/guard.ts";
import { appendClaim, appendPresence, readClaims, removeSelf } from "../src/registry.ts";
import { resolveWorkspace, type WorkspaceInfo } from "../src/resolve.ts";

const TRACE = process.env.CHECKOUT_GUARD_TRACE === "1";
function trace(msg: string): void {
  if (!TRACE) return;
  try {
    fs.appendFileSync("/tmp/ccg-trace.log", `${Date.now()} ${msg}\n`);
  } catch {
    /* tracing best-effort */
  }
}

/** Tool names whose `command` input is a shell command line. */
const SHELL_TOOLS = new Set(["bash", "bash-in", "powershell"]);

interface Active {
  ws: WorkspaceInfo;
  guard: CheckoutGuard;
}

export default function checkoutGuardExtension(pi: ExtensionAPI): void {
  if (process.env.CHECKOUT_GUARD_DISABLE === "1") return;

  const name = sessionDisplayName();
  let active: Active | undefined;
  const registered = new Set<string>(); // `${root}|${kind}` already announced

  /** Resolve (and memoise) the workspace for this cwd. Returns undefined when
   *  the cwd belongs to no workspace we understand — the guard is passive for
   *  that call, which is correct: nothing to protect, nobody to warn. */
  function forCwd(cwd: string | undefined): Active | undefined {
    const dir = cwd ?? process.cwd();
    const ws = resolveWorkspace(dir);
    if (!ws) return undefined;
    const sameRoot = active && active.ws.root === ws.root && active.ws.sessionKind === ws.sessionKind;
    if (!sameRoot) {
      active = { ws, guard: new CheckoutGuard(ws, { pid: process.pid, name }) };
      trace(`resolved ws root=${ws.root} kind=${ws.sessionKind} from ${dir}`);
    }
    const key = `${ws.root}|${ws.sessionKind}`;
    if (!registered.has(key)) {
      registered.add(key);
      appendPresence(active!.guard.registryPath, active!.guard.presenceRow(dir));
    }
    return active;
  }

  pi.on("session_start", async (_event, ctx) => {
    trace(`session_start cwd=${ctx?.cwd}`);
    forCwd(ctx?.cwd);
  });

  pi.on("session_shutdown", async () => {
    trace("session_shutdown");
    if (!active) return;
    removeSelf(active.guard.registryPath, active.guard.selfPid);
  });

  pi.registerCommand("sessions", {
    description: "List live sessions in this shared checkout (and recent claims); `claim <text>` declares intent",
    handler: async (args: string, ctx) => {
      const current = forCwd(ctx?.cwd);
      if (!current) {
        report(ctx, "No shared workspace here — nothing to list.");
        return;
      }
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "claim" && parts.length > 1) {
        const claim = parts.slice(1).join(" ");
        appendClaim(current.guard.registryPath, name, process.pid, claim);
        report(ctx, `claim recorded for ${name}: ${claim}`);
        return;
      }
      const damage = current.guard.registryDamage;
      // Claims are written by `claim <text>`; without this they were write-only.
      const now = Date.now();
      const claims = readClaims(current.guard.registryPath)
        .filter((c) => now - c.ts < current.ws.config.staleMs)
        .map((c) => `  - ${c.name}: ${c.claim} (${Math.round((now - c.ts) / 60000)}m ago)`)
        .join("\n");
      report(
        ctx,
        `Live sessions in ${current.ws.root}:\n${current.guard.formatPeers()}` +
          (claims ? `\n\nRecent claims:\n${claims}` : "") +
          (damage > 0 ? `\n\nWARNING: ${damage} unparsable line(s) in ${current.guard.registryPath} — peer state is incomplete; destructive git ops are blocked until it is repaired.` : ""),
      );
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName: string = (event as { toolName?: string }).toolName ?? "";
    const input = ((event as { input?: unknown }).input ?? {}) as Record<string, unknown>;
    const command = typeof input.command === "string" ? input.command : "";
    trace(`tool_call ${toolName} ${command.slice(0, 60)}`);

    const current = forCwd(ctx?.cwd);
    if (!current) return;

    if (SHELL_TOOLS.has(toolName)) {
      const execDir = typeof input.dir === "string" && input.dir ? input.dir : undefined;
      const decision = current.guard.onBashCommand(command, execDir, ctx?.cwd ?? process.cwd());
      if (decision) return { block: true, reason: decision.reason };
      return;
    }

    const decision = current.guard.onEditCommand(toolName, input, ctx?.cwd ?? process.cwd());
    if (!decision) return;
    if ("block" in decision) return { block: true, reason: decision.reason };
    await pi.sendMessage(
      {
        customType: "pi-checkout-guard-warn",
        content: decision.warn,
        display: true,
      },
      { deliverAs: "steer" },
    );
  });
}

function report(ctx: { ui?: { notify?: (msg: string, level?: "info" | "warning" | "error") => void } }, message: string): void {
  try {
    ctx.ui?.notify?.(message, "info");
  } catch {
    /* non-interactive mode: nothing to render */
  }
}
