# Simple auth/roles plan (admin + readonly, no signup)

Goal: мінімальна, але чітка авторизація для admin-ui і API, без реєстрації. Підтримка 4–5 користувачів, 2 ролі.

Ролі:
- `admin` — повний доступ (створення/редагування/запуски job-ів, зміна конфігів).
- `viewer` — тільки перегляд (дашборд, логи, стани job-ів, прев’ю експорту), без mutating endpoints.

Auth-носій:
- Cookie-based сесія (httpOnly, secure в prod, sameSite=lax) + csrf-token для POST/PUT/DELETE.
- Логін-форма: email + пароль, перевірка через server-side, при успіху видаємо сесію.

Джерело користувачів (без реєстрації):
- Варіант 1 (рекомендовано): таблиця `users` у БД з полями `email`, `password_hash`, `role`, `is_active`; первинне наповнення — скрипт/seed з `.env` (див. нижче). Хеш — bcrypt.
- Варіант 2 (fallback): чисто `.env` список (`AUTH_USERS_JSON=[{"email":"a","password":"...","role":"admin"}]`), паролі зберігаються хешовані (bcrypt). Парсити при старті й тримати in-memory.

ENV/конфіг:
- `AUTH_STRATEGY=db|env` (default `db`).
- `AUTH_SESSION_SECRET` — обов’язково.
- `AUTH_USERS_JSON` — для `env` стратегії (bcrypt-хеші, не plain).
- `AUTH_SESSION_TTL_MINUTES` (наприклад, 720).
- `AUTH_ADMIN_EMAILS` (опційно — білий список для швидкої валідації).

Маршрути/захист:
- Усі `/admin` та `/admin/api` закриті middleware перевірки сесії + ролі.
- API: додати role-check middleware з мапою HTTP-методів до мінімальної ролі; GET дозволено viewer, mutating — тільки admin.
- Healthcheck `/health` публічний.

UI:
- Лендінг `/admin/login` з формою, редірект на `/admin`.
- Відображення ролі та кнопка logout.
- Помилки auth/403 — прості повідомлення.

Логи/аудит:
- Записувати події логіну/логауту та блокування користувача (admin).

Впровадження етапами:
1) Додати middleware auth/session + env-strategy (щоб швидко підняти).
2) Додати DB-strategy + міграцію `users` (seed із `.env`).
3) Покрити admin-ui: login page, logout, role-based приховування кнопок (але авторизація тільки на бекенді).
