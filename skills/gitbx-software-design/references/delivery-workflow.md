# Delivery workflow

Use this reference to turn a request into a design or implementation without importing GITBX business behavior.

## 1. Classify the engagement

Choose the smallest mode that satisfies the request:

- **Design-only:** product brief, information architecture, shell, tokens, component/state specification, wireframes or prototype, and acceptance criteria. Do not create a production codebase unless asked.
- **Architecture:** runtime and boundary decisions, project structure, contracts, data/security model, and a vertical-slice plan.
- **Build:** working application or scaffold plus one or more requested vertical slices, tests, and visual verification.
- **Review/migration:** compare an existing product against this baseline and propose or implement only the authorized changes.

## 2. Establish the target brief

Capture or infer only what is safe and reversible:

| Decision | Required content |
| --- | --- |
| Users and environment | Who uses it, expertise, device/OS, accessibility needs |
| Product outcome | The problem and success condition, not a borrowed feature list |
| Core objects/tasks | Only entities and workflows supplied by the user or existing target domain |
| Runtime | Desktop, Web, both, offline, local-first, multi-user, cloud dependencies |
| Data | Sources, persistence, sensitivity, retention, import/export |
| Brand | New name, voice, icon, palette overrides; otherwise use neutral placeholders |
| Delivery | Design artifact, prototype, code, package, documentation, or review |

If the user intentionally says functions are out of scope, do not block. Produce a neutral shell, design system, architecture, and replaceable module slots. Label placeholders clearly so they cannot be mistaken for completed requirements.

## 3. Write the inheritance ledger

Before naming screens or modules, record an explicit table:

| Area | Inherit | Adapt | Replace |
| --- | --- | --- | --- |
| Workbench density and pane grammar | Usually yes | Platform constraints | Never replace with Git-specific panes |
| Visual tokens and component states | Yes by default | New brand/contrast needs | Literal values only when required |
| Theme, font, i18n, RTL, accessibility | Yes | Target locale set | Never defer as polish |
| Architecture and quality boundaries | Yes | Chosen runtime | Preserve invariants |
| Product identity and copy | No | — | Always new |
| Domain entities, features, workflows, permissions | No | — | Always from the target brief |
| GITBX URLs, keys, storage names, release flow | No | — | Always product-specific |

This ledger is the guardrail against accidental feature cloning.

## 4. Design the experience

Produce, in order:

1. Information architecture and task hierarchy.
2. A workbench map showing title/context bar, action bar, navigation, primary surface, contextual detail, optional activity pane, status, and modal layers.
3. Semantic token set for both themes, typography, spacing, radius, borders, icons, and motion.
4. Component inventory with state matrices: default, hover, focus, active, selected, disabled, loading, empty, warning, error, and success.
5. Keyboard/focus map and RTL behavior.
6. Persistence decisions for theme, font, locale, layout, and safe preferences.
7. Visual acceptance frames at 1440 x 900 and minimum supported size.

Use realistic target-domain sample content only when available. Otherwise use neutral labels such as “Collection”, “Item”, “Details”, and “Activity”, and mark them for replacement.

## 5. Design the system

For architecture or build mode:

1. Decide whether the default Vue/Tauri/Rust stack fits the platform and workload.
2. Define typed contracts and structured errors before transport handlers.
3. Model use cases in a runtime-independent core.
4. Define thin desktop/Web/persistence adapters and their security boundaries.
5. Separate domain, UI, settings, notification, confirmation, and activity state.
6. Plan bootstrap, settings migration, credential storage, offline behavior, and update strategy.
7. Set measurable performance, test, accessibility, and cross-platform checks.

Record major deviations as short architecture decisions with context, choice, alternatives, and consequences.

## 6. Build vertically

If implementation is requested, start with the shell and one real target-domain vertical slice. It should include:

- A typed UI state and component flow.
- The domain API facade.
- A use case in the core/domain layer.
- The required runtime adapter and persistence/I/O.
- Structured success and failure feedback.
- Loading, empty, error, disabled, keyboard, theme, and locale behavior.
- Unit/integration tests and one observable acceptance path.

Do not create every empty module up front. Add another slice only after the first proves the architecture and visual system.

## 7. Verify and hand off

For design-only work, deliver the inheritance ledger, information architecture, annotated shell, tokens, component/state specification, accessibility/i18n notes, and acceptance checklist.

For build work, also deliver the runnable artifact, changed-file summary, validation results, known gaps, and exact next command or entry point. Inspect the UI rather than trusting compilation alone. Confirm that no GITBX brand, Git-domain copy, identifiers, endpoints, fixtures, or release rules leaked into the new product.

Keep claims evidence-based. A passed typecheck is not a visual check; a screenshot is not keyboard or error-path validation; a desktop success does not prove Web parity.

