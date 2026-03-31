#!/usr/bin/env bash
# Pipeline benchmark: import-all → finalize → preview
# НЕ торкається store-import
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
EMAIL="${BENCH_EMAIL:-admin}"
PASSWORD="${BENCH_PASSWORD:-admin}"
COOKIE_JAR="/tmp/bench_pipeline.cookies"
LOG_FILE="/tmp/bench_pipeline_$(date +%Y%m%d_%H%M%S).log"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

log()     { echo -e "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
section() { log "${CYAN}──────────────────────────────────────────${NC}"; log "${CYAN}$*${NC}"; }

db_stat() { PGPASSWORD=app psql -h localhost -U app -d app -t -A -c "$1" 2>/dev/null || echo "?"; }

# ─── 0. Стан БД до ───────────────────────────────────────────────────────────
section "0. СТАН БД ДО ТЕСТУ"
log "products_raw:       $(db_stat 'SELECT COUNT(*) FROM products_raw')"
log "products_final:     $(db_stat 'SELECT COUNT(*) FROM products_final')"
log "suppliers (active): $(db_stat "SELECT COUNT(*) FROM suppliers WHERE is_active=TRUE")"
log "sources   (active): $(db_stat "SELECT COUNT(*) FROM sources   WHERE is_active=TRUE")"

# ─── 1. Логін ────────────────────────────────────────────────────────────────
section "1. ЛОГІН"
LOGIN_RESP=$(curl -sS -c "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/auth/login" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
log "Login: $LOGIN_RESP"
if echo "$LOGIN_RESP" | grep -q '"error"'; then
  log "${RED}Логін не вдався.${NC}"; exit 1
fi

# ─── helper: POST з виміром часу ─────────────────────────────────────────────
run_post() {
  # $1=label $2=url $3=body
  # Виводить результат у лог, повертає секунди у глобальній змінній LAST_S
  local label="$1" url="$2" body="${3:-{}}"
  log "→ $label"
  local t0 t1
  t0=$(date +%s)
  local resp
  resp=$(curl -sS -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -X POST "$url" -d "$body" --max-time 3600 2>&1)
  t1=$(date +%s)
  LAST_S=$(( t1 - t0 ))
  echo "$resp" >> "$LOG_FILE"
  # Показуємо помилку або короткий summary
  echo "$resp" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  err=d.get('error','')
  if err:
    print('  ERROR: '+str(err))
  else:
    ignore={'rows','preview','sources'}
    for k,v in d.items():
      if k not in ignore: print(f'  {k}: {v}')
except Exception as e:
  print('  (parse error: '+str(e)+')')
" 2>/dev/null | while IFS= read -r line; do log "  $line"; done
  log "  ⏱  ${YELLOW}${LAST_S}s${NC}"
}

run_get() {
  local label="$1" url="$2"
  log "→ $label"
  local t0 t1
  t0=$(date +%s)
  local resp
  resp=$(curl -sS -b "$COOKIE_JAR" "$url" --max-time 300 2>&1)
  t1=$(date +%s)
  LAST_S=$(( t1 - t0 ))
  echo "$resp" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  total=d.get('total',d.get('count','?'))
  print(f'  total: {total}')
except: pass
" 2>/dev/null | while IFS= read -r line; do log "$line"; done
  log "  ⏱  ${YELLOW}${LAST_S}s${NC}"
}

# ─── 2. Import all ───────────────────────────────────────────────────────────
section "2. IMPORT ALL (всі активні джерела)"
run_post "import-all" "$BASE_URL/admin/api/jobs/import-all" '{}'
S_IMPORT=$LAST_S

log ""
log "Після імпорту:"
log "  products_raw rows: $(db_stat 'SELECT COUNT(*) FROM products_raw')"
log "  unique suppliers:  $(db_stat 'SELECT COUNT(DISTINCT supplier_id) FROM products_raw')"
log "  unique articles:   $(db_stat 'SELECT COUNT(DISTINCT article) FROM products_raw')"
log "  unique sizes:      $(db_stat 'SELECT COUNT(DISTINCT size) FROM products_raw WHERE size IS NOT NULL')"
log ""
log "По постачальниках (топ-20 за кількістю рядків):"
PGPASSWORD=app psql -h localhost -U app -d app -c "
  SELECT s.name, COUNT(pr.id) AS rows, COUNT(DISTINCT pr.article) AS articles
  FROM products_raw pr
  JOIN suppliers s ON s.id = pr.supplier_id
  GROUP BY s.name ORDER BY rows DESC LIMIT 20;
" 2>/dev/null | tee -a "$LOG_FILE" || true

# ─── 3. Finalize ─────────────────────────────────────────────────────────────
section "3. FINALIZE"
run_post "finalize" "$BASE_URL/admin/api/jobs/finalize" '{}'
S_FINALIZE=$LAST_S

log ""
log "Після finalize:"
log "  products_final rows: $(db_stat 'SELECT COUNT(*) FROM products_final')"
log "  unique articles:     $(db_stat 'SELECT COUNT(DISTINCT article) FROM products_final')"
log "  unique sizes:        $(db_stat 'SELECT COUNT(DISTINCT size) FROM products_final')"
log "  price range:         $(db_stat "SELECT MIN(price_final)||' – '||MAX(price_final) FROM products_final")"

# ─── 4. Preview ──────────────────────────────────────────────────────────────
section "4. PREVIEW QUERIES"
run_get "final-preview  (page 1, limit 50)" "$BASE_URL/admin/api/final-preview?limit=50&offset=0"
S_PREVIEW=$LAST_S

run_get "merged-preview (page 1, limit 50)" "$BASE_URL/admin/api/merged-preview?limit=50&offset=0"
S_MERGED=$LAST_S

# ─── 5. Підсумок ─────────────────────────────────────────────────────────────
section "5. ПІДСУМОК"
log ""
log "  ┌───────────────────────────────┐"
log "  │  Етап           │  Час       │"
log "  ├───────────────────────────────┤"
log "  │  Import-all     │  ${S_IMPORT}s        │"
log "  │  Finalize       │  ${S_FINALIZE}s        │"
log "  │  Preview query  │  ${S_PREVIEW}s        │"
log "  │  Merged query   │  ${S_MERGED}s        │"
log "  └───────────────────────────────┘"
log ""
log "Лог збережено: ${LOG_FILE}"
log "${GREEN}Тест завершено. Store-import НЕ запускався.${NC}"
