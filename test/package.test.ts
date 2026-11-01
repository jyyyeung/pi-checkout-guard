import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

/**
 * Packaging smoke test.
 *
 * The unit tests import src/*, so they cannot catch the failure mode that
 * actually breaks an install: the entry point listed in `pi.extensions` is
 * missing from the tarball, or it loads in Node but not under the loader pi
 * uses (jiti, which resolves the `.js` specifiers this fork relies on).
 *
 * So: read package.json, load every declared entry through jiti with a
 * recording stand-in for pi's ExtensionAPI, and compare the registrations
 * with what the package promises.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
  files?: string[];
  pi?: Record<string, string[]>;
};

/** Entry point -> what it must register. Keep in step with the extensions. */
const EXPECTED: Record<string, { tools?: string[]; commands?: string[]; events?: string[] }> = {
    "./extensions/checkout-guard.ts": {
    tools: [],
    commands: ["sessions"],
    events: ["session_start", "session_shutdown", "tool_call"],
  },
};

interface Calls {
  tools: string[];
  commands: string[];
  events: string[];
  sent: unknown[];
}

/** Recording stand-in for pi's ExtensionAPI — only the surface extensions touch. */
function stubApi(): { api: Record<string, unknown>; calls: Calls } {
  const calls: Calls = { tools: [], commands: [], events: [], sent: [] };
  const api: Record<string, unknown> = {
    registerTool: (tool: { name?: string }) => calls.tools.push(tool?.name ?? "?"),
    registerCommand: (name: string) => calls.commands.push(name),
    on: (event: string) => calls.events.push(event),
    sendMessage: (message: unknown) => calls.sent.push(message),
    sendUserMessage: (message: unknown) => calls.sent.push(message),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    getSessionName: () => undefined,
    setSessionName: () => undefined,
  };
  return { api, calls };
}

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });

test("package: every resource path in the manifest exists on disk", () => {
  const declared = pkg.pi ?? {};
  const entries = Object.entries(declared).flatMap(([kind, rels]) =>
    (rels ?? []).map((rel) => [kind, rel] as const),
  );
  assert.ok(entries.length > 0, "package.json declares no pi resources");
  for (const [kind, rel] of entries) {
    const abs = path.join(root, rel);
    assert.ok(fs.existsSync(abs), `${kind} entry missing on disk: ${rel}`);
  }
});

test("package: every entry in `files` exists (a typo ships an empty tarball)", () => {
  for (const rel of pkg.files ?? []) {
    const abs = path.join(root, rel);
    assert.ok(fs.existsSync(abs), `files entry missing on disk: ${rel}`);
  }
});

test("package: extensions load under pi's loader and register what they promise", async () => {
  const entries = pkg.pi?.extensions ?? [];
  assert.ok(entries.length > 0, "package.json declares no extensions");

  for (const rel of entries) {
    const expected = EXPECTED[rel];
    assert.ok(expected, `no EXPECTED registration recorded for ${rel}`);

    const { api, calls } = stubApi();
    const mod = (await jiti.import(path.join(root, rel))) as {
      default?: (pi: unknown) => unknown;
    };
    const init = mod.default ?? (mod as unknown as (pi: unknown) => unknown);
    assert.equal(typeof init, "function", `${rel} has no default export function`);

    await init(api);

    if (expected.tools) {
      assert.deepEqual([...calls.tools].sort(), [...expected.tools].sort(), `${rel}: tools`);
    }
    if (expected.commands) {
      assert.deepEqual([...calls.commands].sort(), [...expected.commands].sort(), `${rel}: commands`);
    }
    if (expected.events) {
      assert.deepEqual([...calls.events].sort(), [...expected.events].sort(), `${rel}: events`);
    }
  }
});
