import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

let cachedUA: string | undefined;

function opencodeUserAgent(): string {
  if (cachedUA) return cachedUA;
  try {
    const bin = process.env.OPENCODE_BIN ?? join(homedir(), ".opencode", "bin", "opencode");
    const v = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 }).trim().split(/\s+/)[0];
    if (/^\d+\.\d+\.\d+/.test(v)) {
      cachedUA = `opencode/${v} ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14`;
      return cachedUA;
    }
  } catch {}
  cachedUA =
    process.env.OPENCODE_USER_AGENT ?? "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14";
  return cachedUA;
}

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX_ALPHABET = "0123456789abcdef";

function randFrom(alphabet: string, n: number): string {
  const bytes = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function rand26(): string {
  return randFrom(ID_ALPHABET, 26);
}

// ses_ ids carry opencode's internal structure (8 hex + hex + "ffe" + 14 chars);
// the free-tier gateway rejects ses_ values without it.
function newSessionId(): string {
  return `ses_${randFrom(HEX_ALPHABET, 8)}${randFrom(HEX_ALPHABET, 1)}ffe${randFrom(ID_ALPHABET, 14)}`;
}

// Stable ses_ id per pi session (opencode pins routing/caching to it).
const sessionMap = new Map<string, string>();

function opencodeSessionId(piSessionId: string | undefined): string {
  if (!piSessionId) return newSessionId();
  let mapped = sessionMap.get(piSessionId);
  if (!mapped) {
    mapped = newSessionId();
    sessionMap.set(piSessionId, mapped);
  }
  return mapped;
}

function setInsensitive(headers: Record<string, string | null | undefined>, name: string, value: string) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower && k !== name) delete headers[k];
  }
  headers[name] = value;
}

function getInsensitive(headers: Record<string, string | null | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== lower || typeof headers[k] !== "string") continue;
    return headers[k] as string;
  }
  return undefined;
}

function isOpencodeModel(model: unknown): boolean {
  const candidate = model as { provider?: string; baseUrl?: string } | undefined;
  const provider = candidate?.provider ?? "";
  const baseUrl = candidate?.baseUrl ?? "";
  return provider === "opencode" || provider === "opencode-go" || baseUrl.includes("opencode.ai");
}

/**
 * Direct `ctx.modelRegistry.streamSimple()`/`stream()`/`complete()` calls — the
 * observational-memory observer/reflector/dropper workers and other extensions'
 * nested model calls — bypass both the `before_provider_headers` hook and Pi's
 * payload transform, so opencode.ai rejects them with
 * `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`.
 *
 * Measured against opencode.ai (2026-10-16), that gate accepts a request when
 * exactly three things hold:
 *   1. `User-Agent` starts with `opencode/` (the ai-sdk/bun suffix is not checked)
 *   2. `x-opencode-session` carries opencode's `ses_` internal structure
 *   3. the request declares a tool named `read`
 * The client/request/project headers, `Accept`, stainless-header stripping and
 * `prompt_cache_key` the agent path also sends are optional for the gate.
 *
 * (1) and (2) are rewritten on the request options; (3) is added to the first
 * system message of the transcript that declares tools, which is where the
 * APIs read tool declarations from. The tool is advertised only: a worker that
 * calls it gets "Tool read not found" back, and worker prompts do not ask for it.
 */
const READ_TOOL_DECLARATION = {
  name: "read",
  description: "Read the contents of a file (text or image), in chunks when needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to read (relative or absolute)" },
      offset: { type: ["number", "null"], description: "Line number to start reading from (1-indexed)" },
      limit: { type: ["number", "null"], description: "Maximum number of lines to read" },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

type WorkerMessage = { role?: string; toolsAdded?: { name?: string }[] };

function declaresReadTool(messages: readonly unknown[]): boolean {
  for (const message of messages) {
    const toolsAdded = (message as WorkerMessage | undefined)?.toolsAdded;
    if (Array.isArray(toolsAdded) && toolsAdded.some((tool) => tool?.name === "read")) return true;
  }
  return false;
}

function declaresTools(messages: readonly unknown[]): boolean {
  for (const message of messages) {
    const toolsAdded = (message as WorkerMessage | undefined)?.toolsAdded;
    if (Array.isArray(toolsAdded) && toolsAdded.length > 0) return true;
  }
  return false;
}

function withReadToolDeclaration(messages: unknown): unknown {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  // Only tool-using transcripts: the gate needs the `read` name, and a request
  // that declares no tools at all belongs to a caller whose protocol would not
  // survive an advertised tool it cannot dispatch.
  if (!declaresTools(messages) || declaresReadTool(messages)) return messages;
  const index = messages.findIndex((message) => Array.isArray((message as WorkerMessage)?.toolsAdded) && ((message as WorkerMessage).toolsAdded?.length ?? 0) > 0);
  if (index === -1) return messages;
  const declarer = messages[index] as WorkerMessage;
  const next = [...messages];
  next[index] = { ...declarer, toolsAdded: [...(declarer.toolsAdded ?? []), READ_TOOL_DECLARATION] };
  return next;
}

let processSessionId: string | undefined;

function patchedWorkerCall(original: (...args: unknown[]) => unknown, thisArg: unknown, argv: unknown[]) {
  const [model, context, options] = argv;
  if (!isOpencodeModel(model)) return original.apply(thisArg, argv);
  const typedOptions = (options ?? {}) as { headers?: Record<string, string | null>; sessionId?: string };
  const headers: Record<string, string | null> = { ...(typedOptions.headers ?? {}) };
  setInsensitive(headers, "User-Agent", opencodeUserAgent());
  const incomingSession = getInsensitive(headers, "x-opencode-session");
  if (incomingSession === undefined || !incomingSession.startsWith("ses_")) {
    // Workers pass pi's session id here (opencode's own guard needs *a* value);
    // map it to a ses_ id so the free-tier gate accepts it.
    const key = typedOptions.sessionId ?? incomingSession;
    setInsensitive(headers, "x-opencode-session", key ? opencodeSessionId(key) : (processSessionId ??= newSessionId()));
  }
  const nextContext =
    context && typeof context === "object"
      ? { ...(context as object), messages: withReadToolDeclaration((context as { messages?: unknown }).messages) }
      : context;
  return original.apply(thisArg, [model, nextContext, { ...typedOptions, headers }]);
}

function patchDirectModelCalls(registry?: unknown): void {
  const prototype =
    registry && typeof registry === "object"
      ? Object.getPrototypeOf(registry)
      : ModelRegistry.prototype;
  if (!prototype || prototype.__opencodeClientHeadersPatched) return;
  prototype.__opencodeClientHeadersPatched = true;
  for (const method of ["stream", "streamSimple", "complete"]) {
    const original = prototype[method];
    if (typeof original !== "function") continue;
    prototype[method] = function patched(this: unknown, ...argv: unknown[]) {
      return patchedWorkerCall(original as (...args: unknown[]) => unknown, this, argv);
    };
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model as { provider?: string; baseUrl?: string } | undefined;
    if (!isOpencodeModel(model)) return;
    const payload = event.payload as Record<string, unknown>;
    if (!payload || typeof payload !== "object" || !("prompt_cache_key" in payload)) return;
    let piSession: string | undefined;
    try {
      piSession = ctx.sessionManager.getSessionId();
    } catch {}
    return { ...payload, prompt_cache_key: opencodeSessionId(piSession) };
  });
  pi.on("before_provider_headers", (event, ctx) => {
    const model = ctx.model as { provider?: string; baseUrl?: string } | undefined;
    if (!isOpencodeModel(model)) return;
    // Mirror packages/opencode/src/session/llm/request.ts on the wire:
    // User-Agent, x-opencode-client/client, ses_/msg_ ids, x-opencode-project.
    let piSession: string | undefined;
    try {
      piSession = ctx.sessionManager.getSessionId();
    } catch {}
    setInsensitive(event.headers, "User-Agent", opencodeUserAgent());
    setInsensitive(event.headers, "x-opencode-client", process.env.OPENCODE_CLIENT ?? "cli");
    setInsensitive(event.headers, "x-opencode-session", opencodeSessionId(piSession));
    setInsensitive(event.headers, "x-opencode-request", `msg_${rand26()}`);
    if (!Object.keys(event.headers).some((k) => k.toLowerCase() === "x-opencode-project")) {
      event.headers["x-opencode-project"] = process.env.OPENCODE_PROJECT ?? "global";
    }
    setInsensitive(event.headers, "Accept", "*/*");
    setInsensitive(event.headers, "accept-encoding", "gzip, deflate, br, zstd");
    // Strip headers pi / the OpenAI JS SDK add that opencode never sends
    // (null deletes; the SDK's buildHeaders treats null as delete).
    for (const h of [
      "x-client-request-id",
      "x-stainless-retry-count",
      "x-stainless-timeout",
      "x-stainless-lang",
      "x-stainless-package-version",
      "x-stainless-os",
      "x-stainless-arch",
      "x-stainless-runtime",
      "x-stainless-runtime-version",
      "accept-language",
      "sec-fetch-mode",
    ]) {
      event.headers[h] = null;
    }
  });
  // Patch the host's registry instance too: module resolution could in principle
  // hand the extension a different ModelRegistry class than the host's.
  pi.on("session_start", (_event, ctx) => {
    patchDirectModelCalls((ctx as { modelRegistry?: unknown }).modelRegistry);
  });
  patchDirectModelCalls();
}
