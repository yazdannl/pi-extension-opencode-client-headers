# Pi Extension: OpenCode Client Headers

Adjusts request payloads and headers for Pi models using OpenCode. It applies only when the model provider is `opencode` or `opencode-go`, or its base URL contains `opencode.ai`. It supplies OpenCode-style client metadata and stable synthetic session IDs, and removes several SDK headers OpenCode does not normally send. It does not provide or store authentication credentials.

It also patches direct `ctx.modelRegistry.streamSimple()`/`stream()`/`complete()` calls (the observational-memory observer/reflector/dropper workers and other extensions' nested model calls), which bypass Pi's `before_provider_headers` hook and payload transform. opencode.ai's free-tier gate rejects those with `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode` unless the request carries an `opencode/...` user agent, a `ses_`-shaped `x-opencode-session`, and a declared tool named `read`; the patch ensures all three and leaves provider-routed traffic otherwise untouched.

## Install

From this repository's root:

```bash
mkdir -p ~/.pi/agent/extensions
cp opencode-client-headers.ts ~/.pi/agent/extensions/
```

Restart Pi or run `/reload`. For a one-off test:

```bash
pi --extension ./opencode-client-headers.ts
```

The path above is Pi's default user agent directory. If you use a custom agent directory, install the file under its `extensions/` directory instead.

## Optional environment overrides

- `OPENCODE_BIN` — OpenCode executable path used to detect its version. Defaults to `~/.opencode/bin/opencode`.
- `OPENCODE_USER_AGENT` — fallback user-agent string if the version cannot be detected.
- `OPENCODE_CLIENT` — value for `x-opencode-client`; defaults to `cli`.
- `OPENCODE_PROJECT` — value for `x-opencode-project` when the request does not already have one; defaults to `global`.

No separate npm dependency is required; Pi supplies the imported runtime packages. This extension changes outbound requests for matching models, so review the source and provider behavior before loading it.
