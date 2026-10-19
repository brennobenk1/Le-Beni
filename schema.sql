-- Le&Beni — banco de dados (Cloudflare D1)
-- Rode uma vez: npx wrangler d1 execute le-beni --remote --file=schema.sql

create table if not exists folders (
  id          text primary key,
  name        text not null,
  created_at  integer not null
);

create table if not exists entries (
  id           text primary key,
  type         text not null,              -- 'place' ou 'route'
  folder_id    text,
  title        text not null,
  day          text,                       -- 'AAAA-MM-DD'
  note         text not null default '',
  lat          real,                       -- lugar
  lng          real,
  points       text,                       -- trajeto: JSON [[lat,lng,ts],...]
  started_at   integer,
  ended_at     integer,
  duration_ms  integer,
  distance_km  real,
  created_at   integer not null,
  created_by   text
);

create table if not exists photos (
  id          text primary key,
  entry_id    text not null,
  file_id     text not null,               -- id da foto grande no Drive
  thumb_id    text not null,               -- id da miniatura no Drive
  ord         integer not null default 0,
  created_at  integer not null,
  created_by  text
);

create table if not exists meta (
  k  text primary key,
  v  text
);

create index if not exists entries_day_idx    on entries(day desc);
create index if not exists entries_folder_idx on entries(folder_id);
create index if not exists photos_entry_idx   on photos(entry_id, ord);
