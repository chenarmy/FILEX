# ADR-0011: Assistant provider data-sharing consent

Status: accepted  
Date: 2026-11-03

## Context

An external assistant provider receives the current prompt, selected FILEX context, and bounded recent conversation history. Provider retention and model-training practices vary by endpoint and cannot be verified by FILEX. The existing per-request disclosure identifies outgoing context, but provider setup did not require explicit consent.

## Decision

- Show a provider-setup notice that identifies the data recipient and explains that retention/training behavior is controlled by the endpoint operator.
- Persist a provider-level consent flag beside the provider configuration. Missing flags in existing settings deserialize as false.
- Keep consent false after configuring or replacing a provider. The user grants or revokes consent in the assistant panel without re-entering the API key.
- Enforce consent in the Rust request command. The UI also disables sending without consent, but the backend is authoritative.
- Serialize provider replacement and consent changes. Do not change consent while an assistant request is active.
- Continue showing the selected context categories and approximate outgoing size before every request.

## Consequences

- Existing configured providers require one explicit consent action after upgrade; the credential remains in the OS credential store.
- Changing the endpoint or model requires consent again because provider configuration replacement resets the flag.
- FILEX reports the provider's policy boundary but cannot verify retention or training behavior.
- Consent is a local preference and is included in normal SQLite backups with the provider metadata.
