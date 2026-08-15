# Runbook: invariant integration tests (CS-Cart)

## Goal
- Перевіряти критичні інваріанти без зміни бізнес-логіки перед cutover/релізом.
- Покривати:
  - mapping validation (`mapping`),
  - dedup winner selection (`dedup-winner`),
  - price override precedence (`override-precedence`) — ⚠️ **зламана перевірка**, див. нижче,
  - supplier sku prefix isolation (`supplier-sku-prefix-isolation`),
  - store_import resume mismatch guards (`resume-guards`),
  - job lock не відбирається в щойно створеного job (`job-lock-queued-grace`),
  - паралельні знімки магазину не видаляють рядки один одного (`concurrent-mirror-snapshots`),
  - prune все ж видаляє товари, що зникли з магазину (`mirror-prunes-vanished-rows`),
  - prune відмовляється видаляти більшість дзеркала (`mirror-prune-safety-valve`),
  - Compare-таб бере «Колекція»/«Варіація-група» з власного рядка дзеркала, а в
    запасному шляху показує ВСІ групи колекції (`compare-collection-and-group`).

Чотири перевірки дзеркала — регресії на інцидент 22.07.2026, див.
[`RUNBOOK_STORE_MIRROR_RACE_2026_07.md`](./RUNBOOK_STORE_MIRROR_RACE_2026_07.md).

`compare-collection-and-group` — регресія на баг, знайдений 15.08.2026: обидві
колонки читались лише через LATERAL `collection_code = base.article`, через що
15 972 товари зі 173 795 показували «-», хоча значення лежали в `store_mirror`
для тих самих SKU, а `LIMIT 1` без `ORDER BY` повертав довільну групу з
неоднозначної колекції (2 139 колекцій із 63 757 містять більше однієї).
Перевірка тримає три речі одразу: власне значення SKU має пріоритет; запасний
пер-колекційний пошук лишається для товарів, яких у магазині ще немає; у
запасному шляху показуються ВСІ групи впорядковано, а не одна довільна.

## Prerequisites
- Доступний PostgreSQL за `DATABASE_URL`.
- Виконані міграції основної БД.

## Run
```bash
cd /Users/monstermac/WebstormProjects/whitehall_cscard
set -a; source .env; set +a
npm run build
npm run test:invariants
```

Можна прогнати лише окремі перевірки, передавши їхні назви аргументами:

```bash
node dist/scripts/runInvariantIntegrationTests.js concurrent-mirror-snapshots job-lock-queued-grace
```

Без аргументів виконуються всі.

### Прогін на одноразовому Postgres (не чіпаючи робочу БД)
```bash
docker run -d --name wh-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test \
  -e POSTGRES_DB=test -p 55432:5432 postgres:16-alpine
DATABASE_URL='postgres://test:test@127.0.0.1:55432/test' node dist/scripts/runInvariantIntegrationTests.js
docker rm -f wh-test-pg
```

## Expected result
- Скрипт повертає `exit code 0`.
- У stdout є JSON:
  - `"ok": true`
  - `"suite": "invariant-integration"`
  - `"checks"` — список фактично виконаних перевірок (усі, якщо запуск без аргументів).

## Відома поломка: `override-precedence`
Перевірка очікує, що активний рядок у `price_overrides` замінить `price_final`
у прев'ю експорту. Але `price_overrides` не читається ніде в пайплайні —
ні у `finalizerDb.ts`, ні в `exportPreviewDb.ts`. Таблиця створюється
міграцією 001 і залишається мертвою. Додатково умова пошуку в тесті
(`article === 'A2'` + `size === 'M'`) застаріла: прев'ю склеює артикул із
розміром і повертає `'A2-M'`.

Поки не вирішено, чи фіча має існувати, запускай suite без цієї перевірки:

```bash
node dist/scripts/runInvariantIntegrationTests.js mapping dedup-winner \
  supplier-sku-prefix-isolation resume-guards job-lock-queued-grace \
  concurrent-mirror-snapshots mirror-prunes-vanished-rows mirror-prune-safety-valve
```

## Implementation notes
- Тести запускаються в окремій тимчасовій schema і видаляють її після завершення.
- Основні production-таблиці не змінюються.
- `createTables` має містити всі таблиці, по яких джойняться production-класи.
  Через відсутність `size_mappings` (міграція 029) suite не запускався взагалі —
  падав на `relation "size_mappings" does not exist` ще до першої перевірки.
