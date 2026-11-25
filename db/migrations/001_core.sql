-- 001_core: факты, релизы, источники, очередь задач.
-- Ядро — таблица фактов с типом и версией: релизы, карточки и ответы модели ссылаются на факты по ID.

create type fact_kind as enum ('level', 'change', 'rate', 'count', 'event');
create type data_quality as enum ('verified', 'preliminary', 'partial', 'single_source', 'delayed', 'stale', 'missing');

create table sources (
  id         text primary key,
  name       text not null,
  terms_note text
);

create table facts (
  id           bigserial primary key,
  fact_key     text not null,                -- 'US.CPI.YOY', 'BTCUSDT.OI.CHG_4H'
  metric       text not null,
  kind         fact_kind not null,           -- уровень или изменение: подпись ставит рендер
  unit         text not null,                -- '%', 'USD', 'pp', 'count'
  period       text,                         -- '4h', 'm/m', 'y/y'
  ref_period   date,                         -- за какой период значение
  value        numeric,
  value_text   text,
  source_id    text not null references sources (id),
  source_ref   text,                         -- id ряда или url
  published_at timestamptz not null,         -- когда опубликовал источник
  received_at  timestamptz not null default now(),
  revision     int not null default 0 check (revision >= 0),  -- 0 = первая публикация
  quality      data_quality not null default 'verified',
  -- nulls not distinct: у рыночных фактов ref_period пустой, и без этого дубли проходят
  constraint facts_key_period_revision_key unique nulls not distinct (fact_key, ref_period, revision)
);
create index facts_key_published_idx on facts (fact_key, published_at desc);

create table releases (
  id               bigserial primary key,
  event_code       text not null,            -- 'US_CPI', 'US_NFP', 'FOMC_DECISION'
  scheduled_at     timestamptz not null,
  status           text not null default 'scheduled' check (status in ('scheduled', 'released', 'missing')),
  actual_fact_id   bigint references facts (id),
  previous_fact_id bigint references facts (id),
  consensus        numeric,                  -- null, пока нет лицензированного источника
  consensus_source text,
  surprise_z       numeric,                  -- к консенсусу или к прошлому, в σ истории
  surprise_basis   text check (surprise_basis in ('consensus', 'previous')),
  unique (event_code, scheduled_at)
);
create index releases_scheduled_idx on releases (scheduled_at);

create table source_health (
  source_id     text primary key references sources (id),
  last_ok_at    timestamptz,
  last_error_at timestamptz,
  last_error    text,
  stale_after   interval not null
);

-- Очередь задач: захват через FOR UPDATE SKIP LOCKED, без Redis.
create table jobs (
  id         bigserial primary key,
  kind       text not null,
  payload    jsonb not null default '{}',
  dedupe_key text unique,                    -- одна задача на объект: 'release.poll:US_CPI:2026-12-10T13:30Z'
  run_at     timestamptz not null default now(),
  locked_at  timestamptz,
  done_at    timestamptz,
  attempts   int not null default 0,
  error      text
);
create index jobs_pending_idx on jobs (run_at) where done_at is null;

-- Курсоры сборщиков: позиция чтения Velora, ETag и Last-Modified для условного GET.
create table ingest_cursors (
  source_id  text primary key references sources (id),
  cursor     jsonb not null,
  updated_at timestamptz not null default now()
);
