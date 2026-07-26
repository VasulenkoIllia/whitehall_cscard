# Інцидент: паралельні знімки магазину знищували store_mirror (липень 2026)

## Симптом

Розмір `HQ4670-44.5` був у фінальних товарах із залишком 1, але на сайті лишався
з нульовою наявністю і старою ціною. Пайплайн при цьому відзвітував `success`.

## Що сталося насправді

22.07.2026 о 12:27 `store_import` #3994 відправив у магазин **0 товарів зі
153 670**. З логу:

```json
"featureScope": { "mirrorTotal": 613 },
"delta": { "total": 153311, "missingInMirror": 153233, "changed": 0 },
"batchRows": 0,
"importResult": { "imported": 0, "failed": 0, "warnings": [] }
```

У дзеркалі магазину було 613 рядків замість ~242 600.

### Ланцюг подій

1. `store_mirror_sync` існував і як крок ① пайплайну, і як окрема крон-задача
   кожні 2 години. О 00:00, 06:00, 12:00 і 18:00 вони збігалися.
2. Планувальник запускає всі задачі, яким настав час, в одному тіку. #3988
   (`update_pipeline`) і #3989 (самостійний знімок) стартували з різницею 3 мс.
3. `acquireJobLock` вважав мертвим будь-який job не в статусі `running`. Між
   `createJob` (статус `queued`) і `startJob` є вікно — у нього #3989 забрав лок.
4. Обидва знімки 19 хвилин писали в `store_mirror`, кожен зі своїм маркером
   `seen_at`.
5. `pruneSnapshot` видаляв усе, у чого `seen_at` не дорівнює **його** маркеру.
   #3989 фінішував о 12:19:03 і зніс 44 006 рядків #3990. #3990 фінішував о
   12:19:15 і зніс 197 988 рядків #3989.
6. Вижило тільки те, що #3990 записав між двома prune — 613 рядків, рівно
   остання сторінка каталогу (242 613 = 242 × 1000 + 613).
7. О 12:27 `store_import` порівняв фінальні товари з цим огризком, не знайшов
   153 233 SKU і мовчки викинув їх: при `CSCART_ALLOW_CREATE=false` відсутній у
   дзеркалі рядок пропускався без жодного попередження.

### Масштаб

За 7 днів спостережень (20–26.07) з 25 шестигодинних рубежів **втрачено 18**:

| результат | що сталося | разів |
|---|---|---|
| нормально | лок спрацював, самостійний знімок пропущено з 409 | 7 |
| дзеркало знищено | обидва знімки пройшли, відправка вхолосту | 9 |
| пайплайн скасовано | самостійний знімок забрав лок першим, `update_pipeline` отримав 409 | 9 |

Очікувалось 49 прогонів пайплайну — у логах 40. Тобто 18 із 49 прогонів (37%)
не оновили магазин. Провали лягали виключно на години, кратні 6; о 03:00, 09:00,
15:00 і 21:00 — жодного збою.

## Першопричина

Знімок став кроком пайплайну ще в березні (коміт `9517dbc`), і тоді ж задачу
прибрали з інтерфейсу. Але рядок у `cron_settings` лишився `is_enabled = true`.
Задача працювала наосліп: у коді дефолт `false`, в env не задана, в UI не
показана. Через це проблема жила чотири місяці непоміченою.

## Що виправлено

| зміна | файл |
|---|---|
| `pruneSnapshot` видаляє лише `seen_at < marker`, маркер береться з Postgres | `src/core/jobs/StoreMirrorService.ts` |
| prune відмовляється видаляти понад `STORE_MIRROR_MAX_PRUNE_RATIO` (0.2) дзеркала | `src/core/jobs/StoreMirrorService.ts` |
| `acquireJobLock` не забирає лок у job молодшого за 120 с у статусі `queued` | `src/core/jobs/JobService.ts` |
| `store_import` падає при порожньому/протухлому дзеркалі та при частці відсутніх понад `CSCART_MAX_MISSING_IN_MIRROR_RATIO` (0.8) | `src/app/createApplication.ts` |
| самостійну крон-задачу прибрано з планувальника і `ALLOWED_TASK_NAMES` | `src/app/createApplication.ts`, `src/core/jobs/SchedulerSettingsService.ts` |
| осиротілий рядок `cron_settings` вимкнено | `migrations/041_disable_standalone_store_mirror_sync.sql` |
| поріг свіжості дзеркала для бейджа готовності — з `CSCART_DELTA_MAX_MIRROR_AGE_MINUTES`, а не зашитий 120 | `src/app/http/server.ts`, `frontend/src/App.jsx` |

Регресії: `concurrent-mirror-snapshots`, `mirror-prunes-vanished-rows`,
`mirror-prune-safety-valve`, `job-lock-queued-grace` у
`src/scripts/runInvariantIntegrationTests.js`. Suite підтримує вибір окремих
перевірок аргументами.

## Зміни в поведінці після фікса

- `store_import` тепер **падає** там, де раніше тихо нічого не робив. Червоний
  job — очікуваний результат, а не новий баг.
- Якщо запобіжник prune спрацює всередині `update_pipeline`, пайплайн
  переривається на кроці ①: імпорту від постачальників і фіналізації не буде.
- Дзеркало оновлюється лише в складі пайплайну, раз на 3 години. Вкладка
  «В магазині» показує дані до 3 годин давності.
- Ручна «Відправка в магазин» після довгого простою пайплайну (понад 8 годин)
  відмовиться працювати і попросить спершу зробити знімок.

## Що лишилось невиправленим

- Знімок ходить по магазину посторінково (`/api/products?page=N`) майже 20
  хвилин. Якщо каталог змінюється під час обходу, окремі товари можуть
  проскочити. Після фікса вони просто не оновляться цього разу замість того, щоб
  зникнути з дзеркала. Радикально лікується пагінацією за `product_id`.
- Поріг prune 0.2 — груба верхня межа. За спостереженнями нормальний `deleted`
  становить 0–90 рядків із 242 600 (0.04%), тож поріг можна суттєво звузити
  після періоду спостережень.
- `StoreMirrorService.syncSnapshot` не має жодного виклику — мертвий код.

## Перевірка після деплою

```sql
-- 1. Задача не реєструється і рядок вимкнено
SELECT name, cron, is_enabled FROM cron_settings ORDER BY name;

-- 2. На найближчому рубежі (00/06/12/18) має бути РІВНО ОДИН знімок з parent_job
SELECT id, type, started_at AT TIME ZONE 'Europe/Kyiv' AS started,
       meta->>'pipeline_job_id' AS parent
FROM jobs WHERE type = 'store_mirror_sync'
ORDER BY id DESC LIMIT 5;

-- 3. Дзеркало повне, deleted мале
SELECT j.id, (l.data->>'fetched')::int AS fetched, (l.data->>'deleted')::int AS deleted
FROM jobs j JOIN logs l ON l.job_id = j.id AND l.message = 'store_mirror_sync finished'
WHERE j.type = 'store_mirror_sync' ORDER BY j.id DESC LIMIT 5;

-- 4. Відправка бачить повне дзеркало
SELECT j.id,
       (l.data->'batchMeta'->'featureScope'->>'mirrorTotal')::int AS mirror_total,
       (l.data->>'batchRows')::int AS batch_rows,
       (l.data->'importResult'->>'imported')::int AS imported
FROM jobs j JOIN logs l ON l.job_id = j.id AND l.message = 'store_import finished'
WHERE j.type = 'store_import' ORDER BY j.id DESC LIMIT 5;
```

`mirror_total` має бути ~242 600, а не 611.
