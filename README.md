# Dealer Inventory Demand Layer

Turns a dealer's inventory feed into an event stream and converts out-of-stock
shoppers into ADF XML leads for any dealer CRM. DAMG is the design partner.

## Status

| # | Milestone | State |
| --- | --- | --- |
| 1 | Schema, RLS, DAMG seed | Done |
| 2 | Feed adapter + ingester | — |
| 3 | Diff engine | — |
| 4 | Widget + interests API | — |
| 5 | Matcher + ADF sender | — |
| 6 | Admin view | — |

## Database

- `supabase/migrations/` — schema and RLS policies
- `supabase/seed.sql` — dealer `damg`, its eight rooftops and the Pixel Motion feed
- `supabase/tests/` — RLS and idempotency tests

Access model: users map to dealers through `dealer_members` (`admin` or
`viewer`). Members read only their dealer's rows; admins can also edit
rooftops, feeds, model aliases and interests. `anon` has no table access — the
public API writes with the service role after validation and Turnstile.
Pipeline tables (`feed_runs`, `units`, `unit_events`, `lead_sends`) are written
only by the service role.

Run the database tests against a throwaway local Postgres (15+):

```sh
pnpm test:db
```

With the Supabase CLI and Docker, `supabase db reset` applies the same
migrations and seed to a local stack.
