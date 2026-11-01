---
name: gitbx-software-design
description: Design or implement a new desktop-class application using GITBX's non-functional product language, workbench shell, architecture, and quality baseline while replacing every Git-specific capability and the GITBX identity. Use when a user asks for a new app based on GITBX, to reuse the GITBX style or engineering baseline, or to reverse its non-business design. Do not use for GITBX releases, ordinary GITBX feature work, or generic websites.
---

# GITBX-derived software design

Treat GITBX as a non-functional reference, never as the feature specification for the new product.

## Preserve and replace

Preserve the dense desktop-workbench experience, application shell, visual tokens, component and feedback behavior, adjustable layout, light/dark themes, typography controls, internationalization and RTL model, accessibility, layering, runtime abstraction, structured errors, security posture, performance discipline, tests, and cross-platform delivery quality.

Replace the product name, logo, icon, copy, URLs, storage keys, domain entities, data model, workflows, permissions, commands, test fixtures, and every Git-, repository-, branch-, commit-, diff-, worktree-, stash-, MCP-, or GITBX-specific capability. Derive functions only from the user's brief. When functions are intentionally unspecified, create a neutral, replaceable shell and clearly labelled domain placeholders; do not invent Git-like functions.

Use the GITBX palette and dimensions as the default baseline. If the user supplies a new brand or platform constraint, preserve semantic roles, density, contrast, interaction states, and architectural invariants while adapting the literal values.

## Route the request

- For product definition, UI design, wireframes, or prototypes, read [experience-and-visual-system.md](references/experience-and-visual-system.md) and [delivery-workflow.md](references/delivery-workflow.md). Stop at a verifiable design artifact unless implementation is requested.
- For architecture, scaffolding, or implementation, also read [application-architecture.md](references/application-architecture.md).
- Before coding, reviewing, or accepting an implementation, read [engineering-quality.md](references/engineering-quality.md).
- For a review of an existing product, apply the same references as a gap analysis; do not rewrite unrelated code without authorization.

## Working contract

1. Establish the target users, platforms, core objects, primary tasks, data sensitivity, and offline/network needs from the user's brief.
2. Record an `inherit / adapt / replace` table before choosing modules. The GITBX shell and quality model may be inherited; business capabilities must be replaced.
3. Define information architecture, semantic tokens, component states, theme/locale/accessibility behavior, and measurable acceptance checks before polishing screens.
4. For implementation, keep compile-time dependencies pointing inward: presentation and runtime adapters may depend on application/capability use cases, which may depend on domain/core and contracts; inner layers never import outer frameworks. Deliver one real vertical slice before expanding breadth.
5. Verify observable behavior in representative dark, light, RTL, keyboard-only, loading, empty, error, disabled, and focus states. Run type, test, build, and platform checks in proportion to the requested scope.

## Non-negotiable boundaries

- Do not copy the GITBX brand, product copy, domain names, or feature inventory.
- Do not let presentation components call Tauri commands or HTTP endpoints directly; route through typed domain APIs.
- Do not flatten errors to strings, serialize secrets into ordinary settings, log credentials, or grant broad desktop/Web permissions.
- Do not reproduce oversized stores, services, transport modules, or translation files. Split by domain/use case and keep adapters thin.
- Do not force Canvas, CodeMirror, MCP, AI, Axum, or even Rust when the target product does not need them. The default stack is a strong baseline for desktop-first local software, not a substitute for platform fit.

