# План повного паритету бізнес-логіки (CS-Cart, March 2026)

## Scope (зафіксовано)
- Активний конектор: `CS-Cart`.
- `Horoshop` на паузі як окремий майбутній конектор і не входить у поточний delivery scope.
- Бізнес-логіка не змінюється: переносимо legacy-правила 1:1, покращуємо тільки архітектуру, стабільність і швидкодію.

## Незмінні вимоги
- Пайплайн має стабільно тримати ітерації `~500k` товарів, `3-5` запусків на добу.
- Без повних hot-path `DELETE` на критичних таблицях.
- Кожна довга job: керована (`cancel`) і відновлювана (`resume`, де застосовно).
- Дані/логи/джоби мають контрольований retention.

## Поточний статус (вже реалізовано)
- Модульний TypeScript каркас (`core`, `connectors`, `app`) у робочому стані.
- Імпорт Google Sheets (`products_raw`) з валідацією mapping і skip-статистикою.
- Finalize перенесений у staging merge path (без небезпечного `ON CONFLICT` припущення).
- Runtime-партиціювання `products_raw` активоване.
- Керований jobs-layer: `import_all`, `finalize`, `store_import`, `update_pipeline`, `cleanup`, `store_mirror_sync`, cancel flow.
- CS-Cart import оптимізований через попередній mirror-index і skip незмінених SKU.
- `store_import` має progress checkpoints + resume.
- Додано паритетні джоби імпорту з legacy:
  - `import_source`
  - `import_supplier`

## Етапи повного паритету

### Phase 1 (done): Import parity + orchestration parity
Ціль:
- повний контроль імпорту по сценаріях legacy: all/source/supplier;
- однакова lock/конкурентна семантика.

Статус:
- `import_all`: done
- `import_source`: done
- `import_supplier`: done
- API:
  - `POST /admin/api/jobs/import-all`
  - `POST /admin/api/jobs/import-source`
  - `POST /admin/api/jobs/import-supplier`

### Phase 2 (done): Admin/data-management parity (без зміни правил)
Ціль:
- перенести CRUD і операційні API з legacy в модульну структуру:
  - suppliers
  - sources
  - mappings
  - markup rule sets
  - price overrides
  - stats/logs/read APIs

Принцип:
- правила ціноутворення/дедупу не змінювати;
- виділяти read/write сервіси per-domain для прогнозованої підтримки.

Поточний статус:
- `suppliers`: done (CRUD + bulk update + search + A-Я sort API)
- `sources`: done (CRUD API)
- `mappings`: done (latest get/save API, `comment` field support)
- `source-sheets/source-preview`: done (API for mapping flow)
- `markup rule sets`: done (list/create/update/default/apply API, `markup_settings` wired)
- `price overrides`: done (list/upsert/update API)
- `stats/logs/read parity`: done (`/admin/api/logs`, `/admin/api/stats`)
- `preview/export parity`: done (`merged/final/compare` preview + CSV export API)
- `cron/scheduler settings parity`: done (`/admin/api/cron-settings` + DB persistence + runtime apply)

### Phase 3 (done): Export/preview parity для CS-Cart
Ціль:
- довести preview/export контролі до parity з legacy для оператора:
  - final preview/export
  - compare preview/export
  - стабільні bounded payload responses для великих вибірок.

Статус:
- `final/compare` preview/export працюють у backend API і React admin UI.

### Phase 4 (in progress): Високе навантаження і стабільність
Ціль:
- підтвердити виробничу стабільність під цільовим обсягом.

Обов’язково:
- data-integrity gate перед store import:
  - відсутність дубльованих SKU (`product_code`) у CS-Cart;
  - контрольний `store_mirror_sync` після cleanup дублів;
- staged load tests: 100k / 300k / 500k
- вимірювання throughput:
  - import rows/sec
  - finalize duration
  - store import rate + ETA accuracy
- tuning:
  - `CSCART_RATE_LIMIT_RPS`
  - `CSCART_RATE_LIMIT_BURST`
  - `CSCART_IMPORT_CONCURRENCY`
  - scheduler cadence

Поточний статус:
- scripted load-audit контур додано (`npm run audit:load`, `docs/RUNBOOK_LOAD_AUDIT_2026_03.md`)
- scripted stress-аудит контур додано (`npm run audit:stress`, `docs/RUNBOOK_BACKEND_STRESS_AUDIT_2026_03.md`)
- scripted invariant integration suite додано (`npm run test:invariants`, `docs/RUNBOOK_INVARIANT_INTEGRATION_TESTS_2026_03.md`)
- readiness preflight snapshot додано (`npm run backend:readiness`, `GET /admin/api/backend-readiness`)
- SKU duplicate audit додано (`npm run store:sku-audit`)
- лишається staging-прогін і фіксація фактичного tuning baseline для target store

### Phase 5 (in progress): Migration cutover readiness
Ціль:
- закрити ризики production cutover.

Критерії:
- всі core сценарії legacy доступні в новому API/UI;
- документація відповідає фактичній реалізації;
- retention і recovery runbook перевірені на staging.
- є керований шлях переносу supplier config зі старої БД (`export/import legacy-config` runbook).

## Що залишилось закрити (фактичний backlog)
- E2E cutover-прогін на staging/production-like даних (`import_supplier -> finalize -> store_import`) з фіксацією метрик.
- Фіксація tuning baseline на staging для `CSCART_RATE_LIMIT_RPS`, `CSCART_RATE_LIMIT_BURST`, `CSCART_IMPORT_CONCURRENCY`.

## Пропозиції для прискорення без зміни бізнес-логіки
- Підтримувати регулярний прогін інваріантного інтеграційного suite:
  - `npm run test:invariants` (mapping validation, dedup winner selection, price override precedence, resume mismatch guards).
- Винести важкі SQL (stats/export) у окремі query-модулі з контрольованими timeout.
- Додати явні operational метрики в jobs meta:
  - rows imported/finalized/exported
  - duration per stage
  - warnings density.

## Короткий execution plan на найближчі кроки
1. Прогнати staging E2E (`import_supplier -> finalize -> store_import`) і зафіксувати tuning-профіль у runbook.
2. Зафіксувати параметри `CSCART_RATE_LIMIT_RPS`, `CSCART_RATE_LIMIT_BURST`, `CSCART_IMPORT_CONCURRENCY` для target store.
3. Перед production запуском пройти preflight: `store:sku-audit` -> cleanup дублів (якщо є) -> `mirror:sync` -> `backend:readiness`.
