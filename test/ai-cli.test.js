import test from "node:test";
import assert from "node:assert/strict";
import { isCliProvider, listCliTools, normalizeCliProvider } from "../src/ai-cli.js";
import { aiReady } from "../src/summarizer.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const aiCliSource = require("node:fs").readFileSync(new URL("../src/ai-cli.js", import.meta.url), "utf8");

test("cli providers are recognized", () => {
  assert.equal(isCliProvider("codex-cli"), true);
  assert.equal(isCliProvider("claude-cli"), true);
  assert.equal(isCliProvider("antigravity-cli"), true);
  assert.equal(isCliProvider("gemini-cli"), true); // alias → antigravity
  assert.equal(isCliProvider("openai"), false);
  const tools = listCliTools();
  assert.ok(tools.some(tool => tool.id === "antigravity-cli"));
  assert.ok(!tools.some(tool => tool.id === "gemini-cli"));
  assert.ok(tools.every(tool => tool.canAutoInstall));
});

test("gemini-cli migrates to antigravity-cli", () => {
  assert.equal(normalizeCliProvider("gemini-cli"), "antigravity-cli");
  assert.equal(normalizeCliProvider("antigravity-cli"), "antigravity-cli");
});

test("antigravity uses print-mode -p with prompt string", () => {
  assert.match(aiCliSource, /promptFlag:\s*"-p"/);
  assert.match(aiCliSource, /wingetId:\s*"Google\.AntigravityCLI"/);
  assert.doesNotMatch(aiCliSource, /@google\/gemini-cli/);
});

test("aiReady accepts enabled cli without api key", () => {
  assert.equal(aiReady({ enabled: true, provider: "codex-cli" }), true);
  assert.equal(aiReady({ enabled: true, provider: "antigravity-cli" }), true);
  assert.equal(aiReady({ enabled: false, provider: "codex-cli" }), false);
  assert.equal(aiReady({ enabled: true, provider: "openai", apiKey: "" }), false);
  assert.equal(aiReady({ enabled: true, provider: "openai", apiKey: "sk-test" }), true);
});
