#!/usr/bin/env bash
set -euo pipefail

app_password="$(cat "$VIBE_APP_PASSWORD_FILE")"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=app_password="$app_password" <<'SQL'
CREATE ROLE vibe LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
SELECT format('ALTER ROLE vibe PASSWORD %L', :'app_password') \gexec
ALTER DATABASE vibe OWNER TO vibe;
GRANT USAGE, CREATE ON SCHEMA public TO vibe;
CREATE DATABASE vibe_d1_tests OWNER vibe;
SQL
unset app_password
