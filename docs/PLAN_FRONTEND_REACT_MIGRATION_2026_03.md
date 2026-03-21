# План міграції фронтенду на React (CS-Cart scope, March 2026)

## Мета
- Перенести операторський UI з legacy-проєкту на React у цьому репозиторії.
- Не змінювати бізнес-логіку backend, тільки покращити UX, модульність і керованість інтерфейсу.

## Джерело істини
- Legacy UI: `/Users/monstermac/WebstormProjects/whitehall.store_integration/admin-ui/src/App.jsx`
- Поточний React UI в новому репозиторії:
  - `frontend/src/App.jsx`
  - build у `public/admin`

## Поточний стан (вже зроблено)
- Піднято React/Vite frontend-модуль:
  - `frontend/package.json`
  - `frontend/vite.config.js`
  - `frontend/src/*`
- Додано root scripts:
  - `npm run frontend:dev`
  - `npm run frontend:build`
- Реалізовано базові екрани:
  - `Огляд` (stats/readiness + job actions)
  - `Постачальники` (search/sort/list + CRUD + bulk update)
  - `Джерела та мапінг` (source CRUD + source-sheets/source-preview + mapping builder + JSON editor + comment/header_row)
  - `Націнки та override` (markup rule sets: list/default/apply, price overrides: list/upsert/update)
  - `Змерджений / Final / Compare` (preview + export links)
  - `Джоби та логи` (list + cancel + logs stream)

## Етапи повного переносу legacy UX

### Phase 1 (completed)
- React shell + базова навігація + критичні operator flows.

### Phase 2 (done)
- Supplier/source/mapping operator flows перенесено у React.
- Додано lightweight job details panel (`/admin/api/jobs/:jobId`) для дебагу.
- Додано табличний data-review UX (filters/sort/paging controls).

### Phase 3 (done)
- Перенесено pricing/admin секції:
  - markup rule sets: `list/create/update/default/apply` + conditions editor.
  - price overrides: `list/upsert/update`.

### Phase 4
- Розширення data-review UX:
  - серверна пагінація і сортування в таблицях merged/final/compare
  - jobs details drawer (`/admin/api/jobs/:jobId`)
  - logs filters (level, job).

### Phase 5
- UX hardening:
  - optimistic feedback + retry actions
  - фіксований error panel
  - preflight warnings перед destructive runs.

## Telegram alerts (окремий backend-модуль)
- У legacy є інтеграція через:
  - `src/services/telegramService.js`
  - `src/services/logService.js` (error -> Telegram)
- У `whitehall_cscard` цей функціонал **перенесено** окремим модулем:
  - `src/core/alerts/TelegramAlertService.ts`
  - підключення в `createApplication` -> `LogService` (error-level)
  - env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, optional `TELEGRAM_APP_NAME`, `TELEGRAM_TIMEOUT_MS`
  - якщо Telegram недоступний, pipeline не переривається.
