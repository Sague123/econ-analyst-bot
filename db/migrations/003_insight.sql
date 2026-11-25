-- 003_insight: движения, карточки Market Insight, журнал вызовов модели.

create table moves (
  id          bigserial primary key,
  asset       text not null,
  start_at    timestamptz not null,
  end_at      timestamptz not null,
  ret         numeric not null,
  z           numeric not null,
  detected_at timestamptz not null default now(),
  check (end_at > start_at)
);
create index moves_asset_start_idx on moves (asset, start_at desc);

create table insights (
  id          bigserial primary key,
  move_id     bigint references moves (id),
  release_id  bigint references releases (id),
  created_at  timestamptz not null default now(),
  fact_ids    bigint[] not null,
  candidates  jsonb not null,                -- ранжированные кандидаты с признаками
  ai_output   jsonb,                         -- null, если ответ не прошёл проверку
  ai_meta     jsonb,                         -- модель, токены, попытки
  rendered    jsonb not null,                -- карточка, собранная приложением
  outcome_1h  numeric,
  outcome_24h numeric,
  check (num_nonnulls(move_id, release_id) >= 1)
);
create index insights_created_idx on insights (created_at desc);
create index insights_move_idx on insights (move_id);

create table ai_log (
  id         bigserial primary key,
  purpose    text not null check (purpose in ('news_summary', 'insight')),
  model      text not null,
  input      jsonb not null,
  output     jsonb,
  valid      boolean not null,
  errors     text[],
  tokens_in  int,
  tokens_out int,
  created_at timestamptz not null default now()
);
create index ai_log_created_idx on ai_log (created_at desc);
