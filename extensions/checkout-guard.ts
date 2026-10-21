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
 *
 *   4. EDIT CONTAINMENT — sessions inside an isolated worktree/lane cannot
 *      edit outside it; shared-root sessions get a warn tripwire when they
 *      edit into someone's isolated tree.
 *
 *   5. /sessions — list live sessions (and recent claims) for this workspace.
 *
 * Disable entirely with CHECKOUT_GUARD_DISABLE=1. Override a single block by
 * prefixing the command with CHECKOUT_GUARD_OVERRIDE=1 (configurable).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { CheckoutGuard, sessionDisplayName } from "../src/guard.ts";
import { appendClaim, appendPresence, removeSelf } from "../src/registry.ts";
import { resolveWorkspace } from "../src/resolve.ts";

const TRACE = process.env.CHECKOUT_GUARD_TRACE === "1";
function trace(msg: string): void {
  if (!TRACE) return;
  try {
    fs.appendFileSync("/tmp/ccg-trace.log", `${Date.now()} ${msg}\n`);
  } catch {
    /* tracing best-effort */
  }
}

export default function checkoutGuardExtension(pi: ExtensionAPI): void {
  if (process.env.CHECKOUT_GUARD_DISABLE === "1") return;

  const cwd = process.cwd();
  trace(`factory cwd=${cwd}`);
  const ws = resolveWorkspace(cwd);
  if (!ws) return; // not a workspace we understand; passive

  const guard = new CheckoutGuard(ws, { pid: process.pid, name: sessionDisplayName() });

  pi.on("session_start", async () => {
    trace("session_start");
    appendPresence(guard.registryPath, guard.presenceRow(cwd));
  });

  pi.on("session_shutdown", async () => {
    trace("session_shutdown");
    removeSelf(guard.registryPath, guard.selfPid);
  });

  pi.registerCommand("sessions", {
    description: "List live sessions in this shared checkout (and recent claims); `claim <text>` declares intent",
    handler: async (args: string, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "claim" && parts.length > 1) {
        appendClaim(guard.registryPath, sessionDisplayName(), process.pid, parts.slice(1).join(" "));
        report(ctx, `claim recorded for ${sessionDisplayName()}: ${parts.slice(1).join(" ")}`);
        return;
      }
      report(ctx, `Live sessions in ${ws.root}:\n${guard.formatPeers()}`);
    },
  });

  pi.on("tool_call", async (event) => {
    const toolName: string = (event as { toolName?: string }).toolName ?? "";
    const input = ((event as { input?: unknown }).input ?? {}) as Record<string, unknown>;
    trace(`tool_call ${toolName} ${(typeof input.command === "string" ? input.command : "").slice(0, 60)}`);

    if (toolName === "bash" || toolName === "bash-in") {
      const command = typeof input.command === "string" ? input.command : "";
      const execDir = typeof input.dir === "string" && input.dir ? input.dir : undefined;
      const decision = guard.onBashCommand(command, execDir, cwd);
      if (decision) return { block: true, reason: decision.reason };
      return;
    }

    const decision = guard.onEditCommand(toolName, input, cwd);
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
