import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model as { provider?: string; baseUrl?: string } | undefined;
    const provider = model?.provider ?? "";
    const baseUrl = model?.baseUrl ?? "";
    if (provider !== "opencode" && provider !== "opencode-go" && !baseUrl.includes("opencode.ai")) return;
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
    const provider = model?.provider ?? "";
    const baseUrl = model?.baseUrl ?? "";
    if (provider !== "opencode" && provider !== "opencode-go" && !baseUrl.includes("opencode.ai")) return;
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
}
