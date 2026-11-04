# ADR-0014: ProxyJump routes use independent connection profiles

Status: accepted; runtime source slice implemented, verification pending  
Date: 2026-11-03

## Context

Connection profiles retain the raw `ProxyJump` value imported from SSH Config. At the time of this decision, the runtime rejected every non-empty value. Implementing a jump by borrowing the destination profile's username, authentication method, or credential would violate the product requirement that each hop has independent trust and credentials. Treating an alias as a host address is also ambiguous because SSH Config aliases may resolve through other directives.

The selected SSH engine supports direct TCP/IP channels and `connect_stream`, so it can build an SSH transport over an authenticated upstream channel without launching an external command.

## Decision

- Store the runtime route as an ordered list of connection-profile IDs, separate from the raw imported `ProxyJump` string. Each hop therefore reuses that profile's host, port, username, authentication method, identity file, and OS credential reference.
- Persist the ordered references in a normalized SQLite relation with an owner profile, hop position, and referenced jump profile. Keep the foreign-key relationship restrictive when deleting a referenced jump profile; deleting a profile must not silently make destinations connect directly.
- Limit a route to four hops. A referenced hop profile must be a direct profile with no jump route of its own; the destination owns the ordered route. Reject duplicate references, self-reference, missing IDs, and profiles that use the destination as a hop.
- Keep imported `ProxyJump` text as inert source metadata until the user maps it to saved connection profiles. Do not guess a profile from an alias, display name, or host string. An unresolved value blocks connection with an actionable mapping error.
- Verify each hop's host key against that hop profile's host/port trust record before submitting that hop's credentials. A host-key challenge carries the exact profile ID, display name, endpoint, and hop position; the session summary continues to identify the final destination.
- Authenticate hops in route order, then open a direct TCP/IP channel to the next endpoint. Keep every upstream SSH session alive until the destination session closes and tear the route down in reverse order.
- Load each hop's password or passphrase only from that hop's OS credential reference. Agent signing remains local and destination-bound; never forward the local agent. Do not inherit destination credentials or execute `ProxyCommand`.
- Stop on any DNS, trust, authentication, forwarding, or channel error and report the failing hop. Never fall back to a direct destination connection.

## Implementation status

- The profile contract and SQLite schema store an ordered route of profile references. CRUD validates route ownership and prevents deleting a referenced jump profile.
- The profile editor lists eligible direct profiles and preserves imported aliases until each hop is mapped.
- Host-key challenges identify the active hop; authentication loads that profile's own credential reference or uses the local Agent.
- The SSH runtime probes and authenticates each hop through `connect_stream`, retains upstream sessions for the destination PTY, and closes the route in reverse order on failure, cancellation, disconnect and shutdown.
- Route state snapshots each hop's endpoint, username, authentication method, key path and route references, and fails closed if those fields change after host-key verification. Saving that hop's credential after confirmation remains allowed. Network channel opening does not hold the route mutex.
- Unresolved aliases, missing profiles, unsupported nested routes, or failed hops remain blocked. `ProxyCommand` stays unsupported.

## Consequences

- The route has one explicit mapping step after SSH Config import; FILEX never infers an alias from a profile name or host.
- Each hop prompts for its own host-key trust and authentication, while the session tab remains associated with the final destination.
- Runtime fixture coverage for multi-hop password, key and Agent authentication, changed keys, forwarding failures, teardown order and reconnect remains pending.

## Acceptance evidence

- Source review confirms each hop uses its own profile credentials and host-key trust record, route order is preserved, and upstream handles remain alive for the destination session.
- Unknown or changed keys at any hop block that hop's credentials; confirmation names the exact hop and endpoint.
- Missing, cyclic, duplicate, nested, deleted, or overlong routes fail before any direct-connection fallback.
- Disposable multi-hop fixtures cover per-hop password/key/Agent authentication, changed keys at every position, unreachable hops, channel failure, cancellation, teardown order, reconnect, and target-rich diagnostics. Runtime and cross-platform verification remain pending until the user configures the development environment.
