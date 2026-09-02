# Repository Instructions

Before starting any task, read `docs/spec/README.md`.

Use the routing tables in that file to identify the specification documents relevant to the task, then read those documents before making changes.

- Read only the routed documents needed for the current task by default.
- Read multiple specification documents when the task crosses their boundaries.
- Do not load every specification document unless the task is repository-wide or the router explicitly requires it.
- Keep implementation and relevant specification documents consistent.
- If a requested change conflicts with the specification, surface the conflict instead of silently ignoring the specification.

## Design documents

For frontend or dashboard work, also read the design documents under `docs/design/`.

| Document | When to read |
| --- | --- |
| [docs/design/wireframe-dashboard.md](./docs/design/wireframe-dashboard.md) | Before building or changing the dashboard's screen structure, regions, interactions, or state representation — EJS views, the IP grid, the detail drawer, the toolbar, or scan/error states. |
| [docs/design/design-system.md](./docs/design/design-system.md) | Before applying or changing visual rules — colors, typography, components, spacing, motion, or accessibility. Any CSS, design token, or `public/styles.css` work. |

- The dashboard's *what* comes from `docs/spec/04-web-and-realtime.md`; *how it looks and behaves* comes from the design documents above.
- State fields and status decisions follow `docs/spec/03-state-and-storage.md`; the design documents define only their presentation.
- The chosen direction is the Subnet Map with a right slide-in detail drawer, a light-only theme, and a system font stack (no external fonts).
- If a design document conflicts with the specification, prefer the specification and surface the conflict.
