#!/usr/bin/env bash
# One-shot resume for the 2026-09-22 server shutdown:
# the excel-master import fix (906ebec) never reached the server before it
# went down. Run this once the box is back:
#   bash deploy/resume-after-reboot.sh
set -e
SRV="root@192.168.28.165"
PORT=2225
GW="http://127.0.0.1:18090"

echo "[1/4] waiting for ssh..."
until ssh -p $PORT -o ConnectTimeout=10 -o BatchMode=yes $SRV true 2>/dev/null; do sleep 10; done
echo "  server reachable"

echo "[2/4] containers up? (restart: unless-stopped should auto-start them)"
ssh -p $PORT $SRV 'cd /root/agent-luoss/deploy && docker compose -f docker-compose.standard.yml up -d && sleep 10 && docker compose -f docker-compose.standard.yml ps --format "{{.Name}}\t{{.Status}}" | head -12'

echo "[3/4] sync fixed import-catalog.mjs + run importer"
scp -P $PORT deploy/import-catalog.mjs $SRV:/root/agent-luoss/deploy/import-catalog.mjs
ssh -p $PORT $SRV "cd /root/agent-luoss/deploy && node import-catalog.mjs $GW 2>&1 | grep -E 'excel|FAIL|all .* experts'"

echo "[4/4] verify expert list (expect 10 experts incl. 办公协作·Excel 专家)"
ssh -p $PORT $SRV "GW=$GW/api/v1; TOK=\$(curl -s -X POST \$GW/auth/login -H 'Content-Type: application/json' -d '{\"username\":\"admin\",\"password\":\"admin12345\"}' | sed 's/.*\"access_token\":\"\([^\"]*\)\".*/\1/'); curl -s \$GW/experts -H \"Authorization: Bearer \$TOK\" | python3 -c 'import json,sys; es=json.load(sys.stdin)[\"experts\"]; print(len(es), \"experts:\"); [print(\" -\", e[\"id\"], e[\"name\"]) for e in es]'"
