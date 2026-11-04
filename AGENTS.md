# FILEX repository instructions

FILEX is in phased implementation and acceptance for a secure cross-platform remote operations workbench.

## Required design skill

Before product, UI, architecture, or implementation work, read `skills/gitbx-software-design/SKILL.md` and the references it routes to.

- Product or UI work: read `references/experience-and-visual-system.md` and `references/delivery-workflow.md`.
- Architecture or implementation: also read `references/application-architecture.md` and `references/engineering-quality.md`.

## Scope boundaries

- Preserve the GITBX-derived workbench density, visual grammar, accessibility, internationalization, architecture boundaries, security, performance, and quality discipline.
- Do not copy GITBX branding or Git-domain functionality.
- Treat FinalShell only as a market reference. Do not copy its brand, proprietary implementation, exact artwork, copy, packaging, acceleration service, or paid-feature model.
- FILEX business requirements come from `docs/PRODUCT_DESIGN.md`.
- Do not start production implementation while a request is explicitly design-only.

## Product invariants

- Local-first and usable without a FILEX account.
- Host identity is verified; unknown or changed host keys are never silently accepted.
- Passwords, passphrases, and private key material never enter ordinary configuration or logs.
- Remote destructive operations require clear target context and confirmation proportional to risk.
- UI components do not call SSH, SFTP, filesystem, or Tauri transports directly; they use typed domain facades.
- Long-running connection, transfer, monitoring, and tunnel work is cancellable, bounded, and observable.

## Repository conventions

- Keep design decisions and scope changes in `docs/` before implementation changes.
- Prefer small domain modules over god stores, services, or route files.
- Preserve structured error codes across Rust and TypeScript boundaries.
- When implementation begins, update `docs/ROADMAP.md` and add verification evidence for each completed phase.

