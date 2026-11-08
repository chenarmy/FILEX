# ADR-0023: Assistant provider presets and model-only switching

Status: accepted  
Date: 2026-11-08

## Context

FILEX already had one OpenAI-compatible provider configuration inside the assistant panel. The GITBX reference demonstrates a more usable provider/model selection pattern, but its provider catalogue includes multiple protocols and autonomous tool execution that do not match FILEX's current transport or authority model.

Operators also need a keyless local-model path and a fast way to change models without re-entering a provider token. Replacing provider configuration currently resets consent, which is desirable, but it previously required the token to be supplied again even when only the model changed.

## Decision

- Keep one active provider configuration. Presets are non-secret frontend metadata that prefill an OpenAI-compatible endpoint and a bounded list of suggested model IDs; the current transport remains the same for every preset.
- Centralize provider setup in Settings → AI. The assistant panel links to that section and no longer duplicates credential input beside the transcript.
- Permit an omitted provider token only when the endpoint is `http` and its host is a loopback literal (`localhost`, `127.0.0.1` or `::1`). Non-loopback endpoints continue to require an OS-keyring provider-token reference.
- Add a typed model-only update use case. It preserves the endpoint and credential reference, revalidates the stored provider while holding the provider lock, rejects active requests, and resets external-data consent.
- The model selector offers preset suggestions plus a manual model ID. Selecting a model never reads or returns the credential to Vue.
- Conversation menus and model selection are transient presentation state. Conversation content, provider metadata and consent remain behind their existing typed facades.
- Assistant Markdown is parsed locally into escaped Vue structures. No HTML from provider output is injected, and no code-block action can execute or forward a command.

## Consequences

- A user can configure common OpenAI-compatible providers faster while unsupported protocols stay out of the shared transport by construction.
- Ollama and other loopback-only local APIs can run without a token, while HTTP or keyless remote endpoints remain invalid.
- Changing models is quick but always forces the per-provider external-data consent to be reviewed again.
- Preset model lists can become stale; manual model entry is the compatibility path.
- The configuration remains a single active provider rather than a multi-profile provider registry. Multiple provider profiles require a separate storage and migration decision.
