# UI DNA

## Design Tokens

- Use system colors and color-scheme support so admin surfaces inherit the host theme.
- Keep spacing on an 8px rhythm, with tighter 6px gaps inside compact form controls.
- Use 6-8px radii for controls and panels; avoid pill-like shapes for operational UI.
- Prefer borders and contrast over shadows; this interface should feel like a tool, not a landing page.

## Component Patterns

- Primary actions use filled high-contrast buttons; secondary actions use outlined buttons.
- Form controls are full-width in their column and keep labels close to inputs.
- Repeated operational records use simple cards with fixed metadata rows and redacted secrets.
- Status messages reserve stable vertical space so polling and errors do not shift layout.

## Interaction And Motion

- Avoid decorative animation; live state changes should be textual and immediate.
- Disable actions that cannot run yet, and restore them once the required state exists.
- Polling flows should keep the latest actionable result visible.

## Accessibility Baseline

- Preserve keyboard-usable native controls and visible focus states.
- Keep text contrast readable in light and dark system themes.
- Use clear button labels that describe the command outcome.

## Voice And Tone

- Use concise operator language: direct verbs, short statuses, no marketing copy.
- Error text should say what failed and what the operator can do next.

## Layout And Responsive

- Use a constrained main column for setup flows and two-column grids only when width allows.
- Keep mobile layouts single-column with no horizontal scrolling.
- Make token/account output copyable without forcing users to inspect huge lines.

## Anti-Patterns

- Do not use hero sections, decorative gradients, or large promotional headings.
- Do not expose full tokens in summaries; show only minimal redacted identifiers.
- Do not hide required setup state behind hover-only interactions.
