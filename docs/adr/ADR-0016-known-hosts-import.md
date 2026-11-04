# ADR-0016: Import concrete OpenSSH known-host records

Status: Accepted  
Date: 2026-11-03

## Context

The host-trust ledger already records fingerprint provenance and history, but the product baseline also calls for importing existing OpenSSH `known_hosts` trust. Imports can change the current trusted fingerprint, so reading a file and writing its entries in one opaque step would hide an important trust decision.

## Decision

- The user selects a local file through the native file picker. FILEX reads at most 2 MiB and previews supported entries before writing anything.
- Import only exact hostnames/IP addresses and OpenSSH's `[host]:port` form. Calculate the SHA-256 fingerprint from the decoded SSH public-key blob; require the key-blob algorithm to match the line's declared key type.
- Hashed names, wildcard/negated patterns, certificate/revocation markers, certificate key types, malformed entries, and conflicting fingerprints for the same host/port/algorithm are skipped with counted warnings. They are not converted into exact-host trust.
- The preview shows candidate and current fingerprints. A target whose fingerprint would change is highlighted and included in the explicit import confirmation.
- Commit rechecks every candidate's current fingerprint against the preview snapshot and writes the full batch in one SQLite transaction. A stale preview aborts the whole import. Existing trust history remains append-only.

## Consequences

- Existing plaintext `known_hosts` records can seed FILEX trust without an SSH round-trip.
- Unsupported or ambiguous entries remain subject to the normal unknown-host confirmation. FILEX never broadens a wildcard or hashed entry to unrelated hosts.
- Import cannot silently replace trust, and concurrent trust changes cannot be overwritten by an old preview.
- SSH certificate-authority semantics and OpenSSH hashed-host matching remain separate future work; warnings make this limitation visible.
