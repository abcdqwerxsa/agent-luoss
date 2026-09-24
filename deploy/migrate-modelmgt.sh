#!/usr/bin/env bash
# Migrate model providers (with encrypted keys) from the old server's PG
# to the new one. Run from a host that can ssh to BOTH servers.
# Idempotent-ish: truncates modelmgt tables on the target first.
set -euo pipefail

OLD_SSH="ssh -p 2225 -o ConnectTimeout=20 -o ServerAliveInterval=4 -o ServerAliveCountMax=8 root@192.168.28.165"
NEW_SSH="ssh -o ConnectTimeout=20 -o ServerAliveInterval=5 -o ServerAliveCountMax=8 root@100.121.15.127"
PG="docker exec agentluoss-postgres-1"

echo "== probe old server"
$OLD_SSH echo old-alive

echo "== KEY_MASTER parity"
OLD_KM=$($OLD_SSH 'docker exec agentluoss-modelmgt-1 env' | grep KEY_MASTER || echo "KEY_MASTER=?")
NEW_KM=$($NEW_SSH 'docker exec agentluoss-modelmgt-1 env' | grep KEY_MASTER)
echo "old: $OLD_KM"
echo "new: $NEW_KM"
if [ "$OLD_KM" != "$NEW_KM" ]; then
  echo "!! KEY_MASTER differs — encrypted api keys will NOT decrypt on the new server."
  echo "   options: (a) set new compose KEY_MASTER to the old value (nothing encrypted with the new one yet),"
  echo "            (b) import anyway and re-enter keys in the admin UI."
  read -r -p "continue anyway? [y/N] " a
  [ "$a" = y ] || exit 1
fi

echo "== dump modelmgt from old"
$OLD_SSH "$PG pg_dump -U agent -d agentluoss --schema=modelmgt --data-only" > /tmp/modelmgt.sql
grep -c INSERT /tmp/modelmgt.sql || true

echo "== restore into new (truncate first)"
$NEW_SSH "$PG psql -U agent -d agentluoss -c 'TRUNCATE modelmgt.models, modelmgt.providers CASCADE'"
$NEW_SSH "$PG psql -U agent -d agentluoss -v ON_ERROR_STOP=1" < /tmp/modelmgt.sql

echo "== restart modelmgt + runtimes (render models.json + reload)"
$NEW_SSH 'docker restart agentluoss-modelmgt-1 agentluoss-runtime1-1 agentluoss-runtime2-1' >/dev/null
sleep 5

echo "== verify"
$NEW_SSH 'TOK=$(curl -s -X POST http://127.0.0.1:18090/api/v1/auth/login -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"admin12345\"}" | grep -o "\"access_token\":\"[^\"]*" | cut -d\" -f4); curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:18090/api/v1/admin/providers | head -c 600; echo; docker exec agentluoss-modelmgt-1 head -c 300 /data/config/models.json'
echo
echo "done."
