-- Berk Kara Randevu — veritabanı şeması (Neon Postgres)
create extension if not exists btree_gist;

create table if not exists randevular (
  id          uuid primary key default gen_random_uuid(),
  kod         text unique not null,
  tarih       date not null,
  bas         int  not null,          -- dakika (600 = 10:00)
  bit         int  not null,
  hizmet      text not null,
  fiyat       int  not null,
  ad          text not null,
  telefon     text,
  durum       text not null default 'Onaylandı',
  hatirlatma  text,
  olusturma   timestamptz not null default now(),
  constraint saat_cakismasi exclude using gist (
    tarih with =, int4range(bas, bit) with &&
  ) where (durum not in ('İptal', 'Reddedildi'))
);
create index if not exists randevular_tarih on randevular (tarih);

create table if not exists kapali_saatler (
  tarih date not null,
  bas   int  not null,
  primary key (tarih, bas)
);

create table if not exists bildirim_aboneleri (
  endpoint  text primary key,
  abonelik  jsonb not null,
  rol       text not null,
  kodlar    text[] not null default '{}',
  olusturma timestamptz not null default now()
);

create table if not exists ayarlar (
  anahtar text primary key,
  deger   text not null
);
