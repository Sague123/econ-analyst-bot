-- 005_rate_events: события лимитеров с окнами длиннее жизни процесса.
-- Дневной лимит BLS (500 запросов) не должен обнуляться при перезапуске сборщика.
-- Окна в секунды и минуты считаются в памяти и сюда не пишутся. Старше 2 суток — удаляется.

create table rate_events (
  key text not null,                         -- '<source_id>:req' | '<source_id>:err'
  at  timestamptz not null
);
create index rate_events_key_at_idx on rate_events (key, at);
