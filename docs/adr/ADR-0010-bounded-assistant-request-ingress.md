# ADR-0010: Bounded assistant request ingress

Status: accepted  
Date: 2026-11-03

## Context

The assistant UI already limits prompts, context attached to the provider request, and concurrent use through its busy state. The Tauri command is still a trust boundary: webview callers can bypass UI controls, and an arbitrarily large context string or unexpected mode should not be accepted. Multiple concurrent requests can also multiply provider cost and memory use.

## Decision

- Validate the request mode as exactly `explain` or `draft` in the Rust command.
- Cap the decoded context string at 64 KiB before constructing the provider request. The provider payload remains capped to 12,000 context characters after this ingress check.
- Allow one active assistant request per app process, regardless of request ID; reject duplicate IDs and concurrent requests with the assistant-busy error.
- Acquire the active-request guard immediately after validating the request ID, before reading provider configuration or credentials and before assembling provider messages. Release it through RAII on every return path so cancellation is registered throughout setup; prioritize cancellation before polling the HTTP send or stream read.
- Apply a 15-second connection timeout and a 90-second total request/stream timeout. Disable redirects so the bearer credential is never forwarded to a redirect target.
- Accept only a syntactically valid `provider-token` credential reference in assistant configuration. When replacing a provider, delete the prior reference only if it also has the provider-token type.
- Revalidate persisted provider settings before returning endpoint/model details to the UI or issuing a request. Endpoints require HTTPS, except HTTP to loopback, and may not contain URL user information, query strings, or fragments.
- Keep existing prompt, history, response, timeout, cancellation, and redaction limits.

## Consequences

- The backend enforces the same explain/draft-only product boundary even when the UI is bypassed.
- Oversized or concurrent calls fail before opening a provider request.
- A stop request can cancel an assistant operation while provider configuration, credential access, or request construction is in progress.
- Provider redirects fail as provider errors without forwarding authorization credentials to another URL.
- Corrupt assistant settings cannot make the assistant read or delete an SSH password or private-key passphrase reference.
- Invalid persisted endpoint details are not returned to the UI or used for a provider request.
- Larger context workflows require an explicit product and disclosure change rather than increasing limits implicitly.
