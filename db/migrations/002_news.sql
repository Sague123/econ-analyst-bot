-- 002_news: новости, кластеры дублей, реакции цены, архив свечей вокруг релизов.

create table news_clusters (
  id            bigserial primary key,
  first_seen_at timestamptz not null,
  primary_url   text not null,
  sources_count int not null default 1 check (sources_count >= 1),
  assets        text[] not null default '{}',
  importance    numeric,
  summary       jsonb,                       -- ответ модели по схеме
  quality       data_quality not null default 'single_source'
);
create index news_clusters_first_seen_idx on news_clusters (first_seen_at desc);

create table news_items (
  id           bigserial primary key,
  source_id    text not null references sources (id),
  outlet       text not null,                -- CNBC, CoinDesk, ФРС…
  url          text not null unique,
  title        text not null,
  description  text,                         -- из RSS, без полного текста статьи
  published_at timestamptz not null,
  fetched_at   timestamptz not null default now(),
  cluster_id   bigint references news_clusters (id) on delete set null
);
create index news_items_published_idx on news_items (published_at desc);
create index news_items_cluster_idx on news_items (cluster_id);

create table price_reactions (
  subject_type text not null check (subject_type in ('release', 'news')),
  subject_id   bigint not null,
  asset        text not null,                -- 'BTCUSDT', 'ETHUSDT'
  t0           timestamptz not null,
  r5m          numeric,
  r15m         numeric,
  r60m         numeric,
  r1d          numeric,
  primary key (subject_type, subject_id, asset)
);

-- Только окна ±1 день вокруг прошлых релизов, из архива Binance Data Vision.
create table history_klines (
  asset  text not null,
  ts     timestamptz not null,
  open   numeric,
  high   numeric,
  low    numeric,
  close  numeric,
  volume numeric,
  primary key (asset, ts)
);
