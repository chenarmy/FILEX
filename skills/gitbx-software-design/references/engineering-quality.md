# Engineering quality

Read this reference before implementation, review, or acceptance. Apply checks proportionally to the task, but do not omit a relevant risk class merely because the initial feature set is small.

## Code and repository baseline

- UTF-8, LF, final newline, and trimmed trailing whitespace.
- Two-space indentation for TypeScript, Vue, CSS, JSON, YAML, and Markdown structure; four spaces for Rust.
- TypeScript: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, isolated modules, and no emitted JS from type checking.
- Avoid `any` at boundaries. Catch errors as `unknown`, normalize them once, and preserve machine-readable codes.
- Prefer small domain/use-case modules over large stores, services, API handlers, or translation files. Extract shared logic only after it has a stable responsibility.
- Add linting for a new project even though the GITBX reference did not originally make it a complete gate.

## Security and privacy

- Default to minimum permissions and fail-closed behavior. Development-only relaxations must be explicit and visibly warned.
- Validate and normalize all input at the boundary. Canonicalize paths before allowlist checks and prevent traversal/symlink escapes according to the product threat model.
- Keep secrets in an OS credential manager or a purpose-built secret store. Never serialize, echo, expose through errors, or log secret-bearing URLs and headers.
- Use a strict CSP for desktop WebViews and Web deployment. Narrow connect, image, style, and script sources to what the product actually needs.
- Protect privileged or destructive operations with policy checks and shared confirmation UI. A confirmation is not authorization; the backend must still enforce permissions.
- Compare tokens in constant time when the runtime makes that meaningful. Rate-limit authentication and expensive endpoints.
- Redact logs at their source and test the redactor with realistic URL, header, token, and multiline cases.
- Pin CI actions/dependencies where supply-chain risk warrants it, validate workflow inputs, and never interpolate untrusted input into shell commands.

## Reliability and correctness

- Use structured errors end to end. Preserve cause and diagnostic context without leaking secrets.
- Serialize conflicting writes and keep lock discipline consistent. Use atomic writes for configuration and user data.
- Clean temporary resources on every exit path with RAII/scope guards.
- Prevent stale asynchronous results from overwriting newer selections by request version, active-key comparison, or cancellation.
- Wrap asynchronous UI actions in `try/catch/finally`; never leave menus, dialogs, or loading state stuck after failure.
- Make retries explicit, bounded, and limited to idempotent or safely resumable operations.
- Prefer one shared domain implementation over desktop/Web copies. Add adapter parity tests when both exist.
- Treat empty, partial, offline, permission-denied, corrupt, and interrupted states as first-class cases.

## Performance and resource budgets

Define budgets before optimization and report measurements rather than claims. The GITBX experience suggests these aspirations for a lightweight local workbench:

- Sub-second cold startup on a representative production machine.
- Idle memory measured in tens rather than hundreds of megabytes when the domain permits it.
- 60 fps interaction for scrolling, resizing, and dense visual surfaces.
- No unbounded collection, log, cache, or lock registry.
- Large collections use pagination, windowing, incremental computation, or background work; do not perform a full expensive transformation once per row.
- Keep the first paint independent of optional network services and downloadable assets.

Adapt budgets to the new product and hardware. Measure production builds with repeatable fixtures. Capture startup, first usable interaction, peak/idle memory, long-task duration, and representative large-dataset latency.

## Test strategy

Use a layered suite:

- Unit tests for pure domain rules, normalization, redaction, state transitions, layout clamps, and error mapping.
- Adapter contract tests for desktop and Web transports using the same logical cases.
- Integration tests for persistence, credential references, filesystem boundaries, and concurrency-sensitive writes.
- Component tests for keyboard behavior, focus, dialogs, forms, and important state matrices.
- E2E tests for one critical vertical slice, theme switching, persistence, recovery from a failed operation, and optional desktop/Web parity.
- Visual inspection or screenshots at 1440 x 900 and minimum supported size in dark, light, and RTL states.

E2E runs should fail on uncaught page errors and record failed requests and severe console errors. Do not encode GITBX business fixtures or historical pass counts into the new product.

## Build and CI gates

Use the target stack's equivalent commands. For the default Vue/Rust baseline, gate on:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Run Rust checks on the main desktop platform and at least one additional relevant platform. Add package/version consistency checks when multiple manifests repeat the version. Signing, updater metadata, and release assets belong to the new product's delivery plan; do not inherit GITBX identifiers, URLs, keys, or asset-count rules.

## Review for inherited defects

Reject an implementation that copies these shapes from the reference:

- A god store mixing domain entities, network calls, dialog flags, and transient selection.
- A god service or route file containing unrelated use cases.
- Desktop and Web adapters with duplicated domain logic.
- Components that parse error strings, mutate global state directly, or call transports themselves.
- A single enormous locale file.
- Unbounded logs/caches, per-row full scans, dangling listeners, or temporary files that survive failure.
- Hard-coded English, inaccessible icon buttons, hover-only controls, missing focus traps, or color-only status.
- Claims of security, performance, or cross-platform support without an observable check.

## Definition of done

The requested scope is complete only when its observable behavior works, relevant error paths are represented, secrets remain outside ordinary configuration/logs, quality gates pass, and the user can inspect the produced artifact. Document known platform gaps or deferred checks plainly rather than silently lowering the bar.


