# Бот-аналитик · план разработки MVP для Claude Code

Nov 25, 2026 · @Bob

План для Claude Code: четыре этапа MVP, задачи с критериями готовности, схема данных и проверенные источники. Экспортируй в Markdown и положи в репозиторий как docs/PLAN-MVP.md.

## Правила для Claude Code

Цель — MVP «почему двигается рынок» по документу docs/MVP.md. Документ-видение — справка, не задачи; в репозитории его нет.

- Работай по этапам 0 → 3. Перед этапом покажи план задач и вопросы; код — после «ок».
- Задача закрыта, когда её проверка из плана прошла и тесты зелёные. Не прошла — пиши как есть, без «почти готово».
- Velora и Flowscope — только чтение: в каждой базе одна миграция с представлениями и ролью на чтение, отдельным коммитом после согласования. Остальной код Velora не трогать, её календарь не брать: это экспорт ForexFactory.
- Бот не ходит в API Binance: IP общий с Velora и Flowscope. Живые рыночные данные — из базы Flowscope, история — из архива файлов Binance Data Vision.
- Модель не пишет чисел: только ссылки на факты по ID, числа с подписями ставит рендер.
- Модуль ТА, /signals и бэктесты в MVP не пишем: это V2. Прототипа нет, код пишется с нуля.
- Каждый внешний источник — свой клиент с лимитером, повторами и записью в source\_health.
- Время в базе и коде — UTC; Прага только при показе.
- Секреты только в .env, в репозиторий — .env.example.
- Коммит на задачу, перед коммитом — тесты и линтер.
- Отчёт после задачи: что сделано, чем проверено, что не проверено, какие решения принял сам.

## Стек и структура репозитория

Стек повторяет Flowscope, чтобы не держать два набора привычек.

- Node.js 20+, TypeScript, npm.
- Бот — grammY; Product API — Fastify.
- PostgreSQL 16: своя база analyst в отдельном контейнере. TimescaleDB здесь не нужен: тяжёлые ряды живут во Flowscope, из архива берём только окна вокруг релизов. Миграции — SQL-файлы и migrate.ts, как во Flowscope.
- Очередь задач — таблица jobs в Postgres с FOR UPDATE SKIP LOCKED, без Redis.
- zod — схемы, pino — логи, vitest — тесты.
- @anthropic-ai/sdk: модель вызывается через tool use с JSON-схемой ответа. Модели задаются в .env: LLM\_MODEL\_FAST для пересказов, LLM\_MODEL\_INSIGHT для карточек.
- Mini App — Vite + TypeScript и Telegram Web App SDK; графики — lightweight-charts.
- Caddy — HTTPS и раздача Mini App; Docker Compose с лимитами памяти через env: сервер общий с Velora и Flowscope.

```text
econ-analyst-bot/
  docker-compose.yml      # analyst-db, migrate, collector, engine, api, bot, caddy
  .env.example
  db/migrations/          # 001_core.sql, 002_news.sql, 003_insight.sql, 004_users.sql
  flowscope/views.sql     # контракт: представления и роль на чтение для Flowscope
  velora/views.sql        # контракт: новости Velora на чтение
  src/
    common/               # db, logger, limiter, http, health, time (UTC и Прага)
    sources/              # клиент на источник: bls, bea, fed-rss, sec-rss, velora-news, release-calendar, consensus
    ingest/               # расписание сборщиков, запись фактов с версиями
    flowscope/            # чтение представлений Flowscope
    analytics/            # детектор движений, сюрпризы, реакции, позиционирование
    insight/              # атрибуция, пакет фактов, вызов модели, валидатор, рендер
    product/              # Product API, алерты, дайджест, канал
    bot/                  # команды grammY, только интерфейс
  miniapp/                # Vite + TS
  scripts/                # check-sources.ts, backfill-klines.ts
  test/fixtures/          # реальные ответы источников
  docs/                   # MVP.md, PLAN-MVP.md, REPO-MAP.md, SOURCES-CHECK.md
```

Процессы compose: collector — сборщики; engine — аналитика и Insight; api — Product API; bot — Telegram. Каждый процесс можно перезапустить отдельно.

## Источники этапов 0–1

Документация проверена 25.11.2026: ForexFactory и FRED для продукта не годятся по условиям, остальное ждёт живого теста в задаче 0.4. Статусы ведутся в [реестре источников](https://claude.ai/artifact/HZ1gAAcQs8F5gaGQH5BFor).

| Источник | Что берём | Доступ и лимиты | Условия | Решение |
| --- | --- | --- | --- | --- |
| Flowscope | свечи 1 мин, OI, funding, ликвидации | своя БД, роль только на чтение | свои данные | основной источник рынка |
| [BLS API](https://www.bls.gov/developers/api_faqs.htm) | CPI, NFP, безработица | v2: ключ; 500 запросов в день, 50 рядов на запрос; 50 запросов за 10 с; ключ продлевать раз в год | [общественное достояние](https://www.bls.gov/opub/copyright-information.htm), просят ссылку на BLS | факт по релизам труда и инфляции |
| [BEA API](https://apps.bea.gov/api/_pdf/bea_web_service_api_user_guide.pdf) | ВВП, PCE | UserID; 100 запросов, 100 МБ и 30 ошибок в минуту; при превышении 429 и Retry-After | [условия API](https://apps.bea.gov/API/_pdf/bea_api_tos.pdf) прочитать | факт по ВВП и PCE |
| [ФРС, RSS](https://federalreserve.gov/feeds) | решения FOMC, речи, выступления | press\_monetary.xml, press\_all.xml, speeches.xml, testimony.xml | публичные документы | новости ЦБ и время решений |
| [SEC](https://www.sec.gov/os/accessing-edgar-data) | пресс-релизы | до 10 запросов в секунду; User-Agent «компания email» | федеральные данные | новости по крипто-ETF |
| Velora, новости | заголовки и описания CNBC, MarketWatch, Yahoo Finance, FXStreet, CoinDesk, Cointelegraph | представление api.news\_items в базе Velora, роль только на чтение; Velora опрашивает фиды раз в 5 минут | заголовок, ссылка, свой пересказ | лента новостей |
| [Binance Data Vision](https://github.com/binance/binance-public-data/) | история свечей 1 мин | zip-файлы с CHECKSUM; дневные на следующий день | условия проверить | история реакций без API |
| [Telegram Bot API](https://core.telegram.org/bots/faq) | доставка | 1 сообщение в секунду в чат, 20 в минуту в группу, около 30 в секунду массово | — | очередь отправки с лимитером |
| [ForexFactory](https://www.forexfactory.com/notices) | консенсус | официального API нет; Velora берёт тот же экспорт раз в 30 минут | условия запрещают копировать и распространять календарь | не используем |
| [FRED / ALFRED](https://fred.stlouisfed.org/legal/#fred-terms) | версии рядов | [до 120 запросов в минуту](https://fred.stlouisfed.org/docs/api/fred/errors.html) | условия API запрещают хранить и кешировать данные; лицензия личная некоммерческая | в продукте не используем |
| [Finance Calendar API](https://www.financecalendar.com/?p=2921) | консенсус, расписание | ключ X-API-Key; только платные планы, от $4.99 в месяц | клиентские продукты с атрибуцией; откуда консенсус — не раскрыто | кандидат, решение за тобой |

### Что меняется в MVP

- Бесплатного легального консенсуса нет. MVP стартует со сдвигом «факт против прошлого значения» и реакцией цены. Интерфейс ConsensusProvider делаем сразу, по умолчанию — none.
- Дата и время релизов — из официальных календарей BLS, BEA и ФРС.
- Версии макро-данных копим сами с запуска: первое опубликованное значение и каждый пересмотр.
- История реакций считается по типу релиза, без размера сюрприза: прошлые даты релизов плюс архив свечей Binance Data Vision.

**Новости — из Velora.** Velora уже собирает RSS шести изданий раз в 5 минут; бот читает их из её базы и сам опрашивает только ФРС и SEC. Календарь Velora не берём: это экспорт ForexFactory, и он обновляется раз в 30 минут, а факт релиза нужен через секунды.

## Схема данных

Ядро — таблица фактов с типом и версией. Релизы, карточки и ответы модели ссылаются на факты по ID. Имена колонок — отправная точка, Claude Code может уточнить их в плане этапа 0.

```sql
-- 001_core.sql
create type fact_kind as enum ('level','change','rate','count','event');
create type data_quality as enum ('verified','preliminary','partial','single_source','delayed','stale','missing');

create table sources (id text primary key, name text not null, terms_note text);

create table facts (
  id bigserial primary key,
  fact_key text not null,            -- 'US.CPI.YOY', 'BTCUSDT.OI.CHG_4H'
  metric text not null,
  kind fact_kind not null,           -- уровень или изменение: подпись ставит рендер
  unit text not null,                -- '%', 'USD', 'pp', 'count'
  period text,                       -- '4h', 'm/m', 'y/y'
  ref_period date,                   -- за какой период значение
  value numeric,
  value_text text,
  source_id text not null references sources(id),
  source_ref text,                   -- id ряда или url
  published_at timestamptz not null, -- когда опубликовал источник
  received_at timestamptz not null default now(),
  revision int not null default 0,   -- 0 = первая публикация
  quality data_quality not null default 'verified',
  unique (fact_key, ref_period, revision)
);

create table releases (
  id bigserial primary key,
  event_code text not null,          -- 'US_CPI', 'US_NFP', 'FOMC_DECISION'
  scheduled_at timestamptz not null,
  status text not null default 'scheduled',  -- scheduled | released | missing
  actual_fact_id bigint references facts(id),
  previous_fact_id bigint references facts(id),
  consensus numeric,                 -- null, пока нет лицензированного источника
  consensus_source text,
  surprise_z numeric,                -- к консенсусу или к прошлому, в σ истории
  surprise_basis text,               -- 'consensus' | 'previous'
  unique (event_code, scheduled_at)
);

create table source_health (
  source_id text primary key references sources(id),
  last_ok_at timestamptz, last_error_at timestamptz, last_error text,
  stale_after interval not null
);

create table jobs (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null default '{}',
  run_at timestamptz not null default now(),
  locked_at timestamptz, done_at timestamptz,
  attempts int not null default 0,
  error text
);

-- 002_news.sql
create table news_items (
  id bigserial primary key,
  source_id text not null references sources(id),
  outlet text not null,              -- CNBC, CoinDesk, ФРС…
  url text not null unique,
  title text not null,
  description text,                  -- из RSS, без полного текста статьи
  published_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  cluster_id bigint
);

create table news_clusters (
  id bigserial primary key,
  first_seen_at timestamptz not null,
  primary_url text not null,
  sources_count int not null default 1,
  assets text[] not null default '{}',
  importance numeric,
  summary jsonb,                     -- ответ модели по схеме
  quality data_quality not null default 'single_source'
);

create table price_reactions (
  subject_type text not null,        -- 'release' | 'news'
  subject_id bigint not null,
  asset text not null,               -- 'BTCUSDT', 'ETHUSDT'
  t0 timestamptz not null,
  r5m numeric, r15m numeric, r60m numeric, r1d numeric,
  primary key (subject_type, subject_id, asset)
);

create table history_klines (       -- только окна ±1 день вокруг прошлых релизов
  asset text not null, ts timestamptz not null,
  open numeric, high numeric, low numeric, close numeric, volume numeric,
  primary key (asset, ts)
);

-- 003_insight.sql
create table moves (
  id bigserial primary key,
  asset text not null,
  start_at timestamptz not null, end_at timestamptz not null,
  ret numeric not null, z numeric not null,
  detected_at timestamptz not null default now()
);

create table insights (
  id bigserial primary key,
  move_id bigint references moves(id),
  release_id bigint references releases(id),
  created_at timestamptz not null default now(),
  fact_ids bigint[] not null,
  candidates jsonb not null,         -- ранжированные кандидаты с признаками
  ai_output jsonb,                   -- null, если ответ не прошёл проверку
  ai_meta jsonb,                     -- модель, токены, попытки
  rendered jsonb not null,           -- карточка, собранная приложением
  outcome_1h numeric, outcome_24h numeric
);

create table ai_log (
  id bigserial primary key,
  purpose text not null,             -- 'news_summary' | 'insight'
  model text not null,
  input jsonb not null, output jsonb,
  valid boolean not null, errors text[],
  tokens_in int, tokens_out int,
  created_at timestamptz not null default now()
);

-- 004_users.sql
create table users (
  tg_user_id bigint primary key,
  lang text not null default 'ru',
  tz text not null default 'Europe/Prague',
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table alert_rules (
  id bigserial primary key,
  tg_user_id bigint not null references users(tg_user_id) on delete cascade,
  kind text not null,                -- 'insight' | 'release' | 'news'
  params jsonb not null default '{}',
  enabled boolean not null default true
);

create table alerts_sent (
  dedupe_key text primary key,       -- пользователь + объект
  tg_user_id bigint not null,
  sent_at timestamptz not null default now()
);
```

Контракт с Flowscope — отдельный файл, который применяется в базе Flowscope только после согласования. Колонки сверить с реальной схемой Flowscope.

```sql
-- flowscope/views.sql
create schema if not exists api;
create view api.candles_1m    as select /* symbol, ts, open, high, low, close, volume */ ...;
create view api.open_interest as select /* exchange, symbol, ts, oi */ ...;
create view api.funding       as select /* exchange, symbol, ts, rate */ ...;
create view api.liquidations  as select /* exchange, symbol, ts, side, qty, price, completeness */ ...;
create view api.freshness     as select /* таблица, symbol, max(ts) */ ...;
create role analyst_ro login;
grant usage on schema api to analyst_ro;
grant select on all tables in schema api to analyst_ro;
```

## Этап 0 — фундамент

Результат: репозиторий в новой структуре, база поднимается одной командой, бот читает Flowscope, каждый источник проверен вживую. Условие перехода: Flowscope читается, свежесть видна.

- [x] **0.1 Карта репозитория.** Прототипа нет, пишем с нуля. Опиши в docs/REPO-MAP.md структуру, процессы, потоки данных, контракты с Flowscope и Velora, зависимости и открытые вопросы. Проверка: карта согласована со мной.
- [x] **0.2 Каркас и база.** Структура из раздела «Стек», docker-compose, миграции 001–004, migrate.ts, .env.example, конфиг на zod. Проверка: `docker compose up -d` на чистой машине поднимает базу и миграции; повторный запуск миграций ничего не ломает.
- [ ] **0.3 Контракты с Flowscope и Velora.** flowscope/views.sql по реальной схеме Flowscope; роль analyst\_ro только на SELECT в схеме api. Модуль src/flowscope читает свечи, OI, funding, ликвидации и свежесть. В Velora — velora/views.sql: представление api.news\_items (id, url, title, summary, source, published\_at, fetched\_at, tags, important; даты там TEXT — привести к timestamptz) и та же роль только на SELECT; других изменений в Velora нет. Проверка: тест на живой базе возвращает последние 60 минут свечей BTCUSDT и ETHUSDT; попытка записи под analyst\_ro падает с ошибкой прав в обеих базах.
- [ ] **0.4 Живая проверка источников.** scripts/check-sources.ts по каждой строке реестра: запрос, код ответа, задержка, пример ответа в test/fixtures. Проверка: отчёт docs/SOURCES-CHECK.md, статусы в реестре обновлены.
- [x] **0.5 Общие клиенты.** HTTP-клиент с таймаутом, повторами с растущей паузой, лимитером на источник и записью в source\_health. Лимиты — из таблицы источников выше. Проверка: юнит-тесты на 429 с Retry-After и на исчерпание дневного лимита BLS.
- [ ] **0.6 Время.** Всё хранится в UTC, показ — в Europe/Prague. Проверка: тесты на недели, когда США и Европа живут по разному времени: конец октября — начало ноября и март.

## Этап 1 — календарь и новости

Результат: релизы США с фактом, изменением и реакцией цены; лента новостей с проверкой источников и пересказом. Условие перехода: неделя без ошибок времени и пропусков факта.

- [ ] **1.1 Расписание.** Клиенты официальных календарей BLS, BEA и ФРС заполняют releases на 8 недель вперёд. События MVP: CPI, базовый CPI, NFP, безработица, PCE, ВВП, решение и протоколы FOMC. Проверка: расписание на месяц совпадает с сайтами ведомств, время верно в UTC и по Праге.
- [ ] **1.2 Факт.** После scheduled\_at опрашивать BLS или BEA раз в 15 с до появления значения, не дольше 15 минут и в пределах дневного лимита BLS. Первое значение — revision 0, каждый пересмотр — новая строка. Проверка: на фикстуре прошлого релиза факт и изменение к прошлому верны; пересмотр не затирает первое значение.
- [ ] **1.3 Консенсус.** Интерфейс ConsensusProvider с реализацией none. Проверка: при none карточка релиза пишет «консенсус не подключён», surprise\_basis = previous.
- [ ] **1.4 История реакций.** scripts/backfill-klines.ts грузит из Binance Data Vision окна ±1 день вокруг прошлых релизов (BTCUSDT, ETHUSDT, 1 мин) и сверяет CHECKSUM. Даты прошлых релизов — из архивов календарей ведомств. Проверка: для CPI за 3 года есть реакция через 5, 15, 60 минут и 1 день, n показан.
- [ ] **1.5 Новости.** Медиа — из Velora: джоб раз в минуту читает api.news\_items по курсору fetched\_at и копирует новое в news\_items. Сами опрашиваем только RSS ФРС (press\_monetary, press\_all, speeches, testimony) и SEC — их в Velora нет; раз в 2 минуты, условный GET, где сервер его поддерживает. Храним заголовок, описание, издание, ссылку и время. Проверка: за сутки все новости Velora есть у нас, ни одного дубля по url; если Velora стоит, source\_health показывает задержку.
- [ ] **1.6 Склейка дублей.** Кластеры по близости заголовков в окне 6 часов, sources\_count, флажок single\_source. Проверка: на ручной выборке из 50 новостей не больше 5 ошибок склейки.
- [ ] **1.7 Пересказ.** Модель получает заголовок и описание из RSS и отвечает по схеме {summary, assets, tone, importance}. Числа в пересказе — только те, что есть в тексте источника. Проверка: валидатор отклоняет ответ с числом, которого нет в источнике; все вызовы лежат в ai\_log.
- [ ] **1.8 Реакция цены.** Джоб считает r5m, r15m, r60m и r1d по свечам Flowscope от времени публикации. Проверка: совпадение с ручным расчётом на трёх примерах.

## Этап 2 — Market Insight

Результат: карточка «почему двинулось» через минуты после движения, без единого числа от модели. Условие перехода: 100 карточек без чисел ИИ вне ссылок.

- [ ] **2.1 Детектор движений.** Доходность BTC и ETH за 15, 30 и 60 минут в единицах обычной волатильности (EWMA минутных доходностей за 24 часа). Порог z ≥ 3, кулдаун 60 минут на актив, перекрывающиеся окна сливаются; параметры в .env. Проверка: на месяце истории находит движения, видные на графике, и не дублирует одно движение.
- [ ] **2.2 Позиционирование.** Изменение OI и funding и объём ликвидаций в окне движения против их истории. Ликвидации Binance — с флажком «неполно». Проверка: совпадение с ручным запросом к Flowscope.
- [ ] **2.3 Атрибуция.** Окно от −30 до +5 минут к началу движения. Кандидаты: релизы (вес по |surprise\_z|), кластеры новостей (вес по важности и числу источников), сдвиг позиционирования. Правила детерминированные, без модели. Карточка ждёт, пока новости из Velora покроют окно: Velora опрашивает фиды раз в 5 минут. Нет кандидатов — «причина не найдена». Проверка: на 10 размеченных вручную движениях верный кандидат в первой двойке хотя бы 7 раз; результат записан как есть.
- [ ] **2.4 Пакет фактов.** Только факты с ID, типом, единицей и периодом; новости — заголовок, описание, источник. Проверка: снапшот-тест пакета на фикстуре.
- [ ] **2.5 Вызов модели.** Tool use с JSON-схемой ответа из документа MVP, температура 0, одна перегенерация при провале, дневной бюджет токенов. Проверка: при недоступном API карточка выходит без текста ИИ, а не падает.
- [ ] **2.6 Валидатор.** Схема; все ID есть в пакете; цифры только внутри {F…}; у каждой гипотезы есть fact\_ids; у каждого сценария есть условие отмены. Проверка: 20 нарочно плохих ответов в тестах, все отклонены.
- [ ] **2.7 Рендер.** Приложение раскрывает {F…} в число с подписью из самого факта и ставит метки трёх слоёв. Проверка: golden-тесты карточек; уровень OI и изменение OI не путаются.
- [ ] **2.8 Исход и теневой журнал.** Через 1 ч и 24 ч дописать исход и отметить, сбылся ли сценарий. Проверка: отчёт журнала за неделю строится одной командой.

## Этап 3 — запуск

Результат: бот, Mini App и канал работают, безопасность закрыта. Условие запуска: две недели личного использования.

- [ ] **3.1 Product API.** GET /overview, /calendar, /news, /insights, /insights/:id, /me/settings; POST /me/alerts; DELETE /me. Ответы по схемам zod, общим для бота и Mini App. Проверка: контрактные тесты.
- [ ] **3.2 Вход в Mini App.** Сервер проверяет initData: строка проверки — все поля, кроме hash, по алфавиту в виде key=value через перевод строки; secret\_key — HMAC-SHA256 от токена бота с ключом «WebAppData»; hash — hex HMAC-SHA256 строки на secret\_key, сравнение за постоянное время; auth\_date не старше часа. Проверка: подделанная подпись и старый auth\_date отклоняются. [Документация](https://core.telegram.org/bots/webapps)
- [ ] **3.3 Изоляция.** user\_id только из проверенного initData; каждый запрос к /me фильтруется по нему. Проверка: подставленный чужой ID даёт 403.
- [ ] **3.4 Бот.** Команды /start, /overview, /calendar, /news, /insight, /alerts, /settings, /delete; кнопка открывает карточку в Mini App. Проверка: сквозной тест на тестовом боте.
- [ ] **3.5 Алерты.** Очередь отправки по лимитам Telegram: до 1 сообщения в секунду в чат и около 30 в секунду суммарно; 429 обрабатывает плагин auto-retry для grammY. Дедупликация по alerts\_sent, кулдаун, тихие часы. Проверка: рассылка на 200 получателей без ошибок 429. [Лимиты](https://core.telegram.org/bots/faq)
- [ ] **3.6 Дайджест и канал.** Утро в 08:00 по Праге, вечерний итог, автопостинг в канал с метками. В канал — с запасом по лимиту групп: не больше 20 сообщений в минуту. Проверка: неделя дайджестов вовремя и без дублей.
- [ ] **3.7 Mini App.** Пять вкладок: Обзор, Календарь, Новости, Insight, Настройки. Карточка Insight с метками и раскрытием «как получено». Проверка: работает на телефоне в Telegram по HTTPS, в светлой и тёмной теме.
- [ ] **3.8 Эксплуатация.** Caddy с HTTPS, ежедневный pg\_dump, монитор свежести с алертом админу, админка через Tailscale с отдельным входом. Проверка: дамп восстанавливается на чистой базе.

## Тесты и критерии готовности

Задача готова, когда прошла её проверка. Модуль готов, когда неделю подряд проходит критерии из документа MVP.

- **Юнит-тесты:** парсеры каждого источника на фикстурах из задачи 0.4, валидатор ответа модели, рендер фактов, лимитер.
- **Интеграционные:** миграции на чистой базе, чтение Flowscope под analyst\_ro, джобы через очередь.
- **Golden-тесты карточек:** фиксированный пакет фактов даёт ожидаемую карточку.
- **Время:** недели перехода на летнее и зимнее время в США и Европе.
- **Безопасность:** подделанный initData, чужой user\_id, превышение лимитов API.
- **Рассылка:** 200 получателей без ошибок 429.
- **Ежедневный отчёт качества:** доля карточек с найденной причиной, доля ответов модели, не прошедших проверку, свежесть источников.
- **Запрещено:** заменять живые проверки из 0.4 моками; подгонять пороги детектора и атрибуции после просмотра результатов — пороги фиксируются до проверки.

## Стартовый промпт для Claude Code

Перед первой сессией: экспортируй этот документ в Markdown как docs/PLAN-MVP.md, документ MVP — как docs/MVP.md. Правила из первого раздела перенеси в CLAUDE.md в корне репозитория: Claude Code читает его в начале каждой сессии.

```text
Работаем над econ-analyst-bot по плану docs/PLAN-MVP.md. Требования к продукту — docs/MVP.md. Правила — в CLAUDE.md, они важнее любой задачи.

Сейчас этап 0. Начни с задачи 0.1: изучи репозиторий и составь docs/REPO-MAP.md. Код не меняй, пока я не согласую карту.

Для каждой задачи:
1. План в 3–5 пунктах и список файлов, которые изменишь.
2. Реализация.
3. Проверка из задачи: запусти и покажи вывод.
4. Отметь задачу в docs/PLAN-MVP.md; один коммит на задачу, например «0.2: каркас и миграции».

Остановись и спроси, если:
- проверка не проходит после двух попыток;
- нужны схема Flowscope, доступ или ключ;
- нужен выбор, которого нет в плане: поставщик консенсуса, порог, новая зависимость;
- изменение задевает Velora, Flowscope или файлы вне репозитория.

Не заменяй живые проверки моками, не подгоняй пороги под результат.
В конце этапа — короткий отчёт: что сделано, что не прошло, что дальше.
```

Для следующих этапов меняется одна строка: «Сейчас этап N, начни с задачи N.1». Если сессия прервалась: «Продолжи с первой неотмеченной задачи в docs/PLAN-MVP.md».
