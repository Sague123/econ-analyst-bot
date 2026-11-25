# Карта репозитория econ-analyst-bot

Задача 0.1. Состояние на 25.11.2026: репозиторий пустой, прототипа нет, пишем с нуля. Карта описывает, что и где появится на этапах 0–3, а также что нужно согласовать до кода.

## Что меняется в плане из-за старта с нуля

- Переносить нечего. Бот на grammY, сборщик RSS ФРС и SEC и пересказ через Claude пишутся заново, в задачах 0.2, 1.5, 1.7 и 3.4.
- Модуль ТА, /signals и бэктесты не создаются: это V2. Каталога `src/ta/` и флага `TA_ENABLED` нет.
- Своих RSS медиа нет: шесть изданий читаем из базы Velora. Сами опрашиваем только ФРС и SEC.

## Структура и ответственность

Каждый модуль пишет только в свои таблицы. Читать чужие можно.

| Каталог | Отвечает за | Пишет | Читает |
| --- | --- | --- | --- |
| `db/migrations/` | схема базы analyst, `migrate.ts` с таблицей применённых миграций | — | — |
| `flowscope/views.sql` | контракт с Flowscope: схема `api`, роль `analyst_ro` | базу Flowscope, вручную, после согласования | — |
| `velora/views.sql` | контракт с Velora: `api.news_items` | базу Velora, вручную, после согласования | — |
| `src/common/` | конфиг на zod, пул Postgres, логгер pino, HTTP-клиент, лимитер, source_health, время UTC и Прага, очередь jobs | `source_health`, `jobs` | — |
| `src/sources/` | клиент на каждый внешний источник, только запрос и разбор, без записи в базу | — | внешние API, базы Flowscope и Velora |
| `src/ingest/` | расписание сборщиков, запись фактов с версиями, копирование новостей | `facts`, `releases`, `news_items`, `sources` | `src/sources` |
| `src/flowscope/` | чтение представлений Flowscope: свечи, OI, funding, ликвидации, свежесть | — | база Flowscope под `analyst_ro` |
| `src/analytics/` | детектор движений, сюрпризы, реакции цены, позиционирование, склейка новостей | `moves`, `price_reactions`, `news_clusters`, `history_klines` | `facts`, `releases`, `news_items`, `src/flowscope` |
| `src/insight/` | атрибуция, пакет фактов, вызов модели, валидатор, рендер, исходы | `insights`, `ai_log`, факты рынка в `facts` | всё выше |
| `src/product/` | Product API на Fastify, схемы ответов, алерты, дайджест, канал | `users`, `alert_rules`, `alerts_sent`, задачи отправки в `jobs` | всё выше |
| `src/bot/` | команды grammY и отправка сообщений с лимитером Telegram | — | только Product API |
| `miniapp/` | Vite + TS, пять вкладок, lightweight-charts | — | только Product API |
| `scripts/` | `check-sources.ts` (0.4), `backfill-klines.ts` (1.4), отчёт теневого журнала (2.8) | `test/fixtures/`, `history_klines` | внешние источники |
| `test/` | vitest: юнит, интеграция, golden-тесты карточек; `fixtures/` — реальные ответы из 0.4 | — | — |

## Процессы compose

| Процесс | Что запускает | Доступ |
| --- | --- | --- |
| `analyst-db` | PostgreSQL 16, своя база analyst | наружу не открыт |
| `migrate` | `migrate.ts`, затем завершается; остальные ждут его успеха | analyst |
| `collector` | `src/ingest` и `src/sources` по расписанию из `jobs` | analyst, Velora на чтение, интернет |
| `engine` | `src/analytics` и `src/insight` | analyst, Flowscope на чтение, Claude API |
| `api` | `src/product`: Product API и формирование алертов и дайджестов | analyst |
| `bot` | `src/bot`: long polling grammY и задачи отправки из `jobs` | api по внутренней сети, Telegram |
| `caddy` | HTTPS, статика Mini App, прокси `/api` на `api` | порты 80/443, см. вопрос 4 |

Лимиты памяти задаются переменными в `.env` на каждый процесс, потому что сервер общий. Каждый процесс перезапускается отдельно, а общее состояние живёт только в базе.

## Потоки данных по сценариям

**Релиз.**
1. collector кладёт расписание в `releases`.
2. Примерно за 30 минут до релиза задача `release.reminder` переходит в api и выдаёт напоминание.
3. В `scheduled_at` collector начинает `release.poll`: опрос BLS или BEA раз в 15 с. Пришедшее значение записывается в `facts` с `revision 0`, а релизу ставится `status = released`.
4. Затем engine считает сюрприз и `price_reactions` на 5, 15 и 60 минут. Если движение выше порога, запускается сценарий «Резкое движение».

**Резкое движение.**
1. engine раз в минуту читает свечи Flowscope и ищет движение; найденное записывает в `moves`.
2. Карточка ждёт, пока новости Velora покроют окно атрибуции.
3. Затем идут атрибуция, пакет фактов, вызов модели, валидатор и рендер; результат записывается в `insights`.
4. api ставит задачи `tg.send`, бот их отправляет.
5. Через 1 ч и 24 ч запускается `insight.outcome`.

**Новости.**
1. collector раз в минуту копирует из Velora `api.news_items` по курсору; раз в 2 минуты опрашивает RSS ФРС и SEC. Всё попадает в `news_items`.
2. engine склеивает новости в `news_clusters`, делает пересказ и считает `price_reactions`.

**Утро.** В 08:00 по Праге задача `digest.morning` в api собирает дайджест из готовых карточек, релизов и кластеров. Затем рассылка `tg.send` пользователям и в канал.

Бот и Mini App ничего не считают: только Product API.

## Контракты с внешними базами

**Velora (прочитал код, коммит 47305c3).**
- **Таблица** `public.news_items`:
  - поля `id`, `url`, `title`, `title_key`, `summary`, `source`, `published_at`, `tags`, `important`, `fetched_at`;
  - `id` — первые 24 hex-символа sha1 от url;
  - даты хранятся как TEXT в формате ISO;
  - новостям больше 14 дней Velora удаляет.
- **`summary`** — описание из RSS без HTML, обрезанное до 280 символов. Пересказом ИИ оно не является. Для задачи 1.7 подходит.
- **Ленты:** восемь штук (CNBC Economy, Finance и Earnings, MarketWatch, Yahoo Finance, FXStreet, CoinDesk, Cointelegraph), опрос раз в 5 минут.
- **Повторы:** новость из второго издания с тем же нормализованным заголовком за последние 2 дня Velora не сохраняет. Поэтому `sources_count` по медиа будет занижен.
- **Свежесть:** состояние лент Velora держит в памяти, а в базе остаётся только `fetched_at`. Свежесть Velora определяем по возрасту последней записи.
- **Курсор копирования** — пара `(fetched_at, id)`, потому что один `fetched_at` не уникален.
- **Где база:** в варианте deploy/ubuntu Postgres слушает только localhost, и `bootstrap.sh` этого требует.

**Flowscope.** Схемы ещё нет, поэтому `flowscope/views.sql` в задаче 0.3 пишется только после неё.

## Зависимости

Из плана: `grammy`, `@grammyjs/auto-retry`, `fastify`, `zod`, `pino`, `vitest`, `@anthropic-ai/sdk`, `typescript`, `vite`, `lightweight-charts`; Telegram Web App SDK — официальный скрипт telegram-web-app.js, без npm-пакета.

В плане не названы, нужно «ок» до задачи 0.2:

| Пакет | Для чего | Альтернатива |
| --- | --- | --- |
| `pg` | драйвер Postgres, как у Velora | `postgres` (postgres.js) |
| `tsx` (dev) | запуск скриптов и dev-режим; в контейнерах — сборка `tsc` и `node` | только `tsc` |
| `eslint`, `typescript-eslint` (dev) | линтер перед коммитом | `biome` |

Время без библиотеки: показ в Праге через `Intl`, перевод «время ET → UTC» — своя функция, которую проверяют тесты 0.6. Альтернатива — `luxon`.

Позже, на своих этапах:
- `fast-xml-parser` — RSS ФРС и SEC, этап 1;
- `yauzl` — zip Binance Data Vision, этап 1;
- `@fastify/rate-limit` — этап 3.

## Решения, которые приму сам, если не возразишь

- **`facts`:** `unique nulls not distinct (fact_key, ref_period, revision)`. `ref_period` бывает пустым, и иначе дубли проходят.
- **`jobs`:** добавить `dedupe_key text unique` (например, чтобы два опроса одного релиза не встали дважды) и индекс по ожидающим задачам. Захват задачи — `FOR UPDATE SKIP LOCKED`, повтор — с растущей паузой.
- **`ingest_cursors`:** таблица `(source_id, cursor jsonb, updated_at)` для курсора Velora и условного GET у ФРС и SEC.
- **Роль `analyst_ro`:**
  - пароль в SQL-файле не хранится, а задаётся при применении через `psql -v`;
  - роли выдаются `grant connect` и `alter default privileges`, чтобы новые представления в `api` были доступны сразу.
- **Отправка в Telegram:** api ставит задачи `tg.send`, бот их выполняет. Лимитер Telegram живёт в одном процессе.
- **Образы:** `node:22-slim`, `postgres:16`, `caddy:2`.

## Открытые вопросы

| № | Вопрос | Блокирует |
| --- | --- | --- |
| 1 | Зависимости из таблицы выше — ок? | 0.2 |
| 2 | Flowscope: репозиторий или `pg_dump --schema-only`; где база, тот ли это кластер, что у Velora | 0.3 |
| 3 | Какая Velora живая: deploy/ubuntu (Postgres на localhost) или Render + Supabase? От этого зависит сеть: для варианта Ubuntu предлагаю `network_mode: host` у collector и engine и `analyst-db` на `127.0.0.1:5433` | 0.3 |
| 4 | Если Velora на том же сервере, её nginx занимает 80/443, и Caddy туда не встанет. Варианты: поддомен через nginx Velora (правка вне репозитория), Caddy на другом порту с сертификатом через DNS или отдельный IP | 3.8, в 0.2 порты Caddy задаются через `.env` |
| 5 | Флажок «один источник» при повторах, которые Velora выбрасывает: принимаем смысл «один источник среди наших лент» или разрешаешь правку в Velora? | 1.6 |
| 6 | Ключ BLS, UserID BEA, контакт для User-Agent SEC; проверку 0.4 запускаем с сервера | 0.4 |
