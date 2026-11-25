-- 004_users: пользователи, правила алертов, журнал отправленного.
-- В MVP о пользователе хранится только Telegram ID, настройки и алерты; /delete удаляет всё каскадом.

create table users (
  tg_user_id bigint primary key,
  lang       text not null default 'ru',
  tz         text not null default 'Europe/Prague',  -- только для показа
  settings   jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table alert_rules (
  id         bigserial primary key,
  tg_user_id bigint not null references users (tg_user_id) on delete cascade,
  kind       text not null check (kind in ('insight', 'release', 'news')),
  params     jsonb not null default '{}',
  enabled    boolean not null default true
);
create index alert_rules_user_idx on alert_rules (tg_user_id);

create table alerts_sent (
  dedupe_key text primary key,               -- получатель + объект
  tg_user_id bigint references users (tg_user_id) on delete cascade,  -- null: пост в канал
  sent_at    timestamptz not null default now()
);
create index alerts_sent_user_idx on alerts_sent (tg_user_id);
