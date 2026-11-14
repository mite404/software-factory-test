# Feature 07: SQLite-backed observation API

As an operator, I can refresh factory status and inspect acceptance evidence without model calls,
so a missing heartbeat cannot hide durable work or make old activity look current.

Scope: Medium. Risk: elevated. Blast radius: the dashboard consumes this contract, and private
coordinator records must not leak through it. Prove reads neither mutate state nor turn stale
observations into current activity.

## Acceptance criteria

1. `/api/status` reads durable ticket/run identity and acceptance from the existing SQLite store.
   Live titles and activity remain timestamped observations, not durable acceptance evidence.
2. Preserve the current frontend response fields. Add a curated evidence projection including
   pending review and revision-bound gate/review references where recorded. Never invent evidence.
3. Missing/stale observations cannot hide accepted work or advertise working agents. Missing or
   corrupt durable state is explicit; GET never initializes, migrates, or rewrites storage.
4. Serve only allowlisted fields, not raw database rows, private configuration, report contents,
   credentials, worker rationale, or arbitrary filesystem paths. Reads create no model calls.
5. Existing same-origin, loopback-bound dashboard and authenticated Amp portal usage remains intact.
   Unknown paths and write methods remain rejected. No new command endpoint or frontend redesign.

## Verification

Exercise real HTTP and SQLite with missing/stale/fresh observations, accepted and reviewing work,
corrupt storage, and a planted private-field canary. Verify database contents do not change after
reads. Use the actual post-graft review lifecycle on this ticket, not a simulated reviewer alone.
