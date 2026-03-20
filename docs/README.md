# Документація whitehall_cscard

Цей каталог містить базову документацію, перенесену з робочого проєкту Horoshop.

Основні файли:
- `PLAN_MODULAR_SINGLE_REPO_2026_03.md` — план модульної реархітектури в одному репозиторії з можливістю заміни конектора (Horoshop → CS-Cart).
- `CURRENT_FUNCTIONALITY.md` — опис поточного функціоналу (імпорт, фіналізація, експорт).
- `IMPLEMENTATION_STAGES.md` — початковий план перенесення логіки з Apps Script у Node.js/БД.
- `RUNBOOK_FINALIZE_STABILITY_2026_03.md` — ранбук стабілізації етапу finalize.
- `README_FEED_EXTENSION.md` — розширення імпорту фідів.
- `ARCHITECTURE_BASELINE_2026_03.md` — що вже закладено в `whitehall_cscard` після рев’ю документації та як це мапиться на legacy-код.
- `CSCART_CONNECTOR_NOTES.md` — конспект CS-Cart REST API та мапінг під наш нейтральний preview.
- `AUTH_SIMPLE_ROLES.md` — план простої авторизації (admin/viewer) без реєстрації, з сесіями та хешованими паролями.

Посилання на вихідну бізнес-логіку:
- Кодова база Horoshop (джерело істини логіки, імпорт/фіналізація/експорт): `/Users/monstermac/WebstormProjects/whitehall.store_integration`.
- Основні сервіси: `src/services/importService.js`, `src/services/finalizeService.js`, `src/services/exportService.js`, `src/jobs/runners.js` у репозиторії вище.

Цей репозиторій `whitehall_cscard` буде використовувати спільне ядро та окремий конектор під CS-Cart. Для заміни конектора див. план у `PLAN_MODULAR_SINGLE_REPO_2026_03.md` (етапи 1–5).

## Посилання на вихідний код бізнес-логіки (Horoshop проєкт)
- Імпорт постачальників/джерел: `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/importService.js`
- Фіналізація та дедуп: `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/finalizeService.js` та `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/dedupService.js`
- Експорт і попередній перегляд для магазину: `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/exportService.js`
- Оркестрація пайплайна/cron: `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/jobs/runners.js` та `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/jobs/scheduler.js`
- Конфіг/оточення: `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/config.js`
