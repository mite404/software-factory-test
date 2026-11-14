# Pipeline view

Read-only page that draws the factory's status feed. It only ever calls `GET /api/status` on its
own origin.

## Run it

`amp orb services ensure` starts the page on a recorded feed and prints its portal URL. No
factory and no second orb are needed. The recording is `web/replay.ts`; each poll advances it
one frame, so open one tab at a time.

To use a dashboard running in this orb instead, start `bun factory/dashboard.ts` and run
`bun run web` (the Vite proxy defaults to port 4310, or set `FACTORY_API`).

## The contract with the factory

- `Feed` and `Task` in `web/derive.ts` build on `DashboardSnapshot` from `factory/dashboard.ts`.
  A feed change there fails `bun run typecheck` here.
- `factory/` belongs to the factory thread. Ask for feed changes; do not edit it from here.
- Draw only what the feed reports. Do not infer state the feed has no field for (for example a
  Foreman checkpoint from attempt numbers).
- When the feed gains a field, add a frame that uses it to `web/replay.ts`.

## Live data

The live view is the factory orb's own portal, where its dashboard serves the built page
(`bun run web:build`). Do not proxy another orb's portal from here: it needs a single-use
sign-in cookie and breaks. For a one-off look from this orb, open
`amp portal login-url <factory portal URL>` in `agent-browser`.

## Checks

`bun test web`, `bun run typecheck`, `bun run lint:ci`, `bun run format:check`,
`bun run fallow:ci`. Keep logic in tested functions in `web/derive.ts`; `web/main.ts` only
paints. After any visual change, screenshot the page and look at it.
