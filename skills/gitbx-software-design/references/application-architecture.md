# Application architecture

Use this reference when choosing a stack, scaffolding a project, or implementing the product. The goal is a portable core with thin runtime adapters and a strongly typed workbench UI.

## Choose the baseline deliberately

For a desktop-first, local-data, cross-platform product, default to:

- Vue 3 Composition API with `<script setup lang="ts">`.
- TypeScript in strict mode, Pinia, Tailwind CSS 3-style semantic utilities, Lucide icons, and Vite.
- Tauri 2 as the desktop shell and Rust as the local core.
- A Cargo workspace with shared contracts, a domain/core crate, and capability-focused crates.
- Axum only when a self-hosted Web runtime is required; it should expose the same use cases as the desktop adapter.

For a pure Web, mobile, or cloud-native product, keep the dependency boundaries, typed contracts, UI state model, semantic tokens, error model, and quality requirements, but choose a runtime that fits the platform. Do not add Rust, Axum, Canvas, CodeMirror, MCP, or AI solely because GITBX uses them.

## Layering and dependency direction

For compile-time dependencies, each arrow below means “the layer on the left may depend on the layer on the right”:

```text
presentation or runtime adapters -> application/capability use cases -> domain/core -> contracts
```

Inner layers never import outer frameworks. Runtime call flow may travel from presentation through a typed facade and runtime adapter into a use case, then return a structured result; do not confuse that call sequence with compile-time dependency direction.

- `contracts`: serializable DTOs, identifiers, commands/queries, operation results, and structured errors. No framework dependencies.
- `domain/core`: invariants and use cases. It must not know Tauri commands, HTTP routes, window APIs, or Vue.
- `capability services`: reusable subsystems that deserve isolation because they have their own algorithms, I/O, or test surface.
- `runtime adapters`: Tauri commands, Axum handlers, persistence drivers, credential stores, OS integrations. Map parameters and forward to use cases; do not reimplement domain logic.
- `presentation`: Vue components, stores, composables, view models, and typed domain API facades.

When both desktop and Web runtimes exist, share contracts and use cases. Duplicate only transport-specific parsing, authentication, and response serialization.

## Suggested project shape

Adapt names to the new domain:

```text
src/
  api/
    common.ts
    domain/
      <domain>Api.ts
  assets/
  components/
    layout/
    ui/
    dialogs/
    <domain>/
  composables/
  i18n/
    locales/
  services/
  stores/
  types/
  utils/
crates/
  <product>-contracts/
  <product>-core/
  <capability>/
src-tauri/
src-web/              # only when requested
tests/
  unit/
  integration/
  e2e/
```

Use PascalCase component files, camelCase TypeScript modules, and snake_case Rust modules. Split by domain and use case before files become catch-all facades. A compatibility facade may re-export smaller APIs, but it must not become the implementation home.

## Typed runtime API facade

Presentation components and stores import typed domain functions. They never call `invoke()` or `fetch()` directly.

The API layer owns:

- Runtime detection and desktop-versus-Web dispatch.
- Request/response serialization and naming conversion.
- Authentication headers and request IDs.
- Structured error parsing and normalization.
- Redaction of credentials and sensitive URLs before diagnostics.
- Timeout, cancellation, and retry policy where safe.

Keep shared transport mechanics in `api/common.ts` and domain calls in `api/domain/<domain>Api.ts`. Use identical logical input/output types across adapters even if transport envelopes differ.

Use a structured result/error contract such as:

```ts
type OperationResult<T> =
  | { ok: true; data: T; requestId?: string }
  | { ok: false; error: AppError; requestId?: string };

type AppError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
  field?: string;
};
```

Do not make the UI parse error meaning from message fragments.

## Front-end state and view composition

Organize Pinia stores by domain. Keep transient UI state separate from domain data:

- Domain stores: entities, active context, caches, and use-case actions.
- UI store: dialog visibility, selected transient targets, pane state, and global modes.
- Settings store: theme, locale, fonts, layout preferences, and non-secret user preferences.
- Notification store: toast queue and announcements.
- Confirmation store: promise-based confirm/prompt requests.
- Activity/console store: sanitized commands, progress, diagnostics, and filters when the product needs an operator console.

Components call semantic store actions such as `openDialog`, `selectItem`, or `refreshContext`; they do not mutate store refs from arbitrary locations. Keep view-only computed state near the component unless it is shared.

Use a persistent app shell for the workbench. Lazy-load expensive or rarely opened panels and dialogs. A domain component owns its UI, while orchestration stays in the store/use-case layer.

## Bootstrap, settings, and persistence

Bootstrap in this order:

1. Read safe local preferences needed for first paint.
2. Apply theme, font family, font size, and direction before mounting.
3. Initialize the durable application configuration.
4. Load i18n and the root application.
5. Start background services only after the shell can report failures.

For fast startup, safe preferences may have a browser/local mirror, while the native configuration remains authoritative. Normalize and validate every loaded value. Serialize configuration writes through one queue and use atomic temp-file-plus-rename writes.

Secrets, passwords, API tokens, and private-key passphrases go to the OS credential store. Ordinary configuration stores only non-sensitive metadata or a reference to the credential. Secret-bearing fields must be skipped during serialization, redacted from debug output, and excluded from telemetry.

## Async and resource discipline

- Give context-changing loads a monotonic sequence or cancellation token. Discard a late response when it no longer matches the active context.
- Always settle UI state in `finally`: close menus, clear spinners, and release temporary locks even when the operation fails.
- Await or explicitly handle every promise. Clipboard, file picker, and window operations need failure feedback.
- Serialize writes to the same resource. Avoid read-then-write TOCTOU windows.
- Use RAII/scope guards for temporary files, locks, processes, subscriptions, and event listeners.
- Bound caches and background queues. Paginate or virtualize large collections; do not run an expensive full-data transformation per row.

## Desktop and Web adapters

For a Tauri desktop shell:

- Start near 1280 x 800 with a minimum near 900 x 600; use custom decorations only when the application supplies complete cross-platform window controls and drag regions.
- Grant the minimum Tauri capabilities. Keep a restrictive content security policy and narrow filesystem/dialog/shell access to actual use cases.
- Isolate OS-specific behavior behind adapter traits or modules and compile-check relevant platforms.
- Keep updater, signing, and distribution endpoints product-specific; never inherit GITBX release URLs or identifiers.

For an optional Web runtime:

- Fail closed when security configuration is missing outside explicit local development.
- Canonicalize filesystem paths before checking them against configured roots.
- Authenticate all non-health endpoints; compare secrets safely and rate-limit sensitive operations.
- Define CORS narrowly, allow only required methods/headers, and validate every boundary payload.
- Expose the same structured contracts as the desktop path and test parity for representative use cases.

## Architecture acceptance

Before expanding features, demonstrate one vertical slice that crosses UI, typed API, adapter, core use case, persistence or external I/O, structured error handling, and tests. Confirm that the core can be tested without launching Tauri or a Web server and that presentation tests can replace the runtime facade with a fake.


