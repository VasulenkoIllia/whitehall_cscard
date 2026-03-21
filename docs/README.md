# Документація whitehall_cscard

Цей каталог містить актуальну документацію по модульному CS-Cart пайплайну і архівні матеріали з legacy-переносу.

Основні файли:
- `AUDIT_MODULAR_BASELINE_2026_03.md` — фактичний аудит legacy vs `whitehall_cscard`, критичні ризики, скоригований план і вже внесені стабілізаційні правки.
- `PLAN_MODULAR_SINGLE_REPO_2026_03.md` — план модульної реархітектури в одному репозиторії з можливістю заміни конектора (Horoshop → CS-Cart).
- `CURRENT_FUNCTIONALITY.md` — опис поточного функціоналу (імпорт, фіналізація, експорт).
- `IMPLEMENTATION_STAGES.md` — архівний початковий план (historical context, не source of truth).
- `RUNBOOK_FINALIZE_STABILITY_2026_03.md` — ранбук стабілізації етапу finalize.
- `RUNBOOK_LOAD_AUDIT_2026_03.md` — сценарій контрольованого load-аудиту 100k/300k/500k.
- `RUNBOOK_BACKEND_STRESS_AUDIT_2026_03.md` — stress-аудит backend (multi-iteration, dry-run store batch, без запису в сайт).
- `RUNBOOK_INVARIANT_INTEGRATION_TESTS_2026_03.md` — інтеграційний suite критичних інваріантів (mapping/dedup/override/resume guards).
- `RUNBOOK_SUPPLIER_CONFIG_MIGRATION_2026_03.md` — вигрузка/перенос supplier config зі старої БД у нову для тестування parity.
- `RUNBOOK_SAFE_BACKEND_TEST_NO_STORE_WRITE_2026_03.md` — покроковий тест пайплайна без запису в магазин (тільки local DB + read-only compare).
- `RUNBOOK_BACKEND_CUTOVER_CHECKLIST_2026_03.md` — preflight-гейти готовності backend перед production store import.
- `PLAN_FRONTEND_REACT_MIGRATION_2026_03.md` — план повного переносу frontend на React з покроковим покриттям legacy UX.
- `README_FEED_EXTENSION.md` — розширення імпорту фідів.
- `ARCHITECTURE_BASELINE_2026_03.md` — що вже закладено в `whitehall_cscard` після рев’ю документації та як це мапиться на legacy-код.
- `CSCART_CONNECTOR_NOTES.md` — конспект CS-Cart REST API та мапінг під наш нейтральний preview.
- `AUTH_SIMPLE_ROLES.md` — план простої авторизації (admin/viewer) без реєстрації, з сесіями та хешованими паролями.

Посилання на вихідну бізнес-логіку:
- Кодова база Horoshop (джерело істини логіки, імпорт/фіналізація/експорт): `/Users/monstermac/WebstormProjects/whitehall.store_integration`.
- Основні сервіси: `src/services/importService.js`, `src/services/finalizeService.js`, `src/services/exportService.js`, `src/jobs/runners.js` у репозиторії вище.

Цей репозиторій `whitehall_cscard` буде використовувати спільне ядро та окремий конектор під CS-Cart. Для заміни конектора див. план у `PLAN_MODULAR_SINGLE_REPO_2026_03.md` (етапи 1–5).

Важливо: `CURRENT_FUNCTIONALITY.md` — головне джерело фактичного стану реалізації. `AUDIT_MODULAR_BASELINE_2026_03.md` та `IMPLEMENTATION_STAGES.md` зберігаються як історичний контекст.

Швидкий доступ / auth:
- Стратегія зараз `AUTH_STRATEGY=env` (мінімальна), користувачі задаються в `.env` через `AUTH_USERS_JSON`.
- За замовчуванням додано admin: логін `admin@example.com` **або** короткий `admin`, пароль `admin` (хеш — bcrypt). Логін-форма приймає email або короткий логін.
- Для локального запуску через `source .env` значення `AUTH_USERS_JSON` має бути в одинарних лапках (`'[...]'`), інакше shell зламає bcrypt-хеш із символом `$`.

## Посилання на вихідний код бізнес-логіки (Horoshop проєкт)
- Імпорт постачальників/джерел: `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/importService.js`
- Фіналізація та дедуп: `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/finalizeService.js` та `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/dedupService.js`
- Експорт і попередній перегляд для магазину: `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/exportService.js`
- Оркестрація пайплайна/cron: `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/jobs/runners.js` та `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/jobs/scheduler.js`
- Конфіг/оточення: `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/config.js`

Scheduler у новому репозиторії:
- Вбудований env-driven scheduler реалізовано в `src/core/jobs/JobScheduler.ts`.
- Параметри запуску див. у `ARCHITECTURE_BASELINE_2026_03.md` (розділ `Scheduler env`).

Frontend (React admin):
- Dev: `npm run frontend:dev`
- Build: `npm run frontend:build`
- Build output: `public/admin` (сервер віддає `dist/public/admin` або fallback на `public/admin`).

Telegram alerts (optional):
- Реалізовано окремим модулем `src/core/alerts/TelegramAlertService.ts`.
- Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, optional `TELEGRAM_APP_NAME`, `TELEGRAM_TIMEOUT_MS`.
