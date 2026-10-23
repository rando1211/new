#!/usr/bin/env bash
# Applies migrations + seed to a throwaway local Postgres and runs the RLS tests.
# Needs Postgres 15+ server binaries (initdb, pg_ctl) on PATH or in PG_BIN.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
export PATH="$PG_BIN:$PATH"

DATA="$(mktemp -d)"
SOCK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  # initdb refuses to run as root.
  chown postgres "$DATA" "$SOCK"
  RUN_AS=(runuser -u postgres --)
fi

cleanup() {
  "${RUN_AS[@]}" pg_ctl -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DATA" "$SOCK"
}
trap cleanup EXIT

"${RUN_AS[@]}" initdb -D "$DATA" -U postgres --auth=trust >/dev/null
"${RUN_AS[@]}" pg_ctl -D "$DATA" -o "-k $SOCK -c listen_addresses=''" -w start >/dev/null

psql_run() {
  "${RUN_AS[@]}" psql -h "$SOCK" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"
}

psql_run -f "$ROOT/supabase/tests/supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "migrate  $(basename "$f")"
  psql_run -f "$f"
done
echo "seed     seed.sql (twice, to prove it is idempotent)"
psql_run -f "$ROOT/supabase/seed.sql"
psql_run -f "$ROOT/supabase/seed.sql"

for f in "$ROOT"/supabase/tests/*.test.sql; do
  echo "test     $(basename "$f")"
  psql_run -o /dev/null -f "$f" 2>&1 | sed -E "s/^psql:[^ ]+ (NOTICE|ERROR): +/  /"
done
echo "all database tests passed"
