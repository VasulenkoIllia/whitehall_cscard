# Runbook: backend тест без запису в магазин (CS-Cart)

## Мета
- Перевірити імпорт, finalize, preview/export і compare без `PUT/POST` у CS-Cart.
- Бачити реальні дані пайплайна у новій БД та порівняння з магазином через read-only mirror.

## Критичне правило безпеки
- Не запускати ендпоїнти:
  - `POST /admin/api/store-import`
  - `POST /admin/api/jobs/store-import`
  - `POST /admin/api/jobs/update-pipeline` (всередині викликає `store_import`)

## 1) Увійти в API (cookie session)
```bash
BASE_URL="http://127.0.0.1:3000"
COOKIE_JAR="/tmp/wh_cscart.cookies"

curl -sS -c "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/auth/login" \
  -d '{"email":"<ADMIN_EMAIL>","password":"<ADMIN_PASSWORD>"}'
```

## 2) Імпорт у локальну БД (без магазину)
```bash
# supplierId приклад: 10 (sevrukosha manual), 31 (Склад WHITE HALL)
curl -sS -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/admin/api/jobs/import-supplier" \
  -d '{"supplierId":10}'

curl -sS -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/admin/api/jobs/import-supplier" \
  -d '{"supplierId":31}'
```

## 3) Finalize у локальній БД
```bash
curl -sS -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/admin/api/jobs/finalize" \
  -d '{}'
```

## 4) Подивитися дані без завантаження в CS-Cart
```bash
# Огляд у JSON
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/admin/api/final-preview?supplierId=31&limit=100&offset=0"

# Повний CSV для аналізу
curl -sS -L -b "$COOKIE_JAR" \
  "$BASE_URL/admin/api/final-export?supplierId=31" \
  -o /tmp/final_supplier_31.csv
```

## 5) Compare зі станом магазину (read-only)
`store_mirror_sync` читає CS-Cart і пише тільки у локальну `store_mirror`, у магазин не записує.

```bash
cd /Users/monstermac/WebstormProjects/whitehall_cscard
npm run mirror:sync
```

```bash
# Розбіжності preview
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/admin/api/compare-preview?store=cscart&supplierId=31&missingOnly=true&limit=100&offset=0"

# Розбіжності CSV
curl -sS -L -b "$COOKIE_JAR" \
  "$BASE_URL/admin/api/compare-export?store=cscart&supplierId=31&missingOnly=true" \
  -o /tmp/compare_supplier_31_missing.csv
```

## 6) Мінімальні SQL-перевірки в локальній БД
```sql
SELECT supplier_id, COUNT(*) AS raw_rows
FROM products_raw
GROUP BY supplier_id
ORDER BY supplier_id;
```

```sql
SELECT supplier_id, COUNT(*) AS final_rows
FROM products_final
GROUP BY supplier_id
ORDER BY supplier_id;
```

```sql
SELECT store, COUNT(*) AS mirror_rows
FROM store_mirror
GROUP BY store;
```

## Де дивитися маршрути у коді
- safe preview/export/read маршрути: `src/app/http/server.ts` (`/admin/api/final-preview`, `/admin/api/final-export`, `/admin/api/compare-preview`, `/admin/api/compare-export`, `/admin/api/jobs/import-supplier`, `/admin/api/jobs/finalize`, `/admin/api/jobs/store-mirror-sync`).
- write маршрути, які не чіпаємо в цьому runbook: `store-import` і `update-pipeline`.
