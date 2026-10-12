-- ระบบเฝ้าระวังตู้เย็นวัคซีน: โครงสร้างฐานข้อมูล
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ตู้เย็น / อุปกรณ์เซนเซอร์
create table public.devices (
  id text primary key,                         -- เช่น 'fridge-1'
  name text not null,
  location text,
  api_key text not null default replace(gen_random_uuid()::text, '-', ''),
  min_temp numeric not null default 2,
  max_temp numeric not null default 8,
  offline_after_min int not null default 15,   -- ไม่มีสัญญาณเกินกี่นาที = แจ้งเตือน
  temp_alert_after_min int not null default 10,-- อุณหภูมิผิดช่วงต่อเนื่องกี่นาที = แจ้งเตือน
  active boolean not null default true,
  last_seen timestamptz,
  last_temp numeric,
  status text not null default 'unknown',      -- unknown | ok | offline | temp_high | temp_low
  status_since timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ค่าอุณหภูมิที่วัดได้
create table public.readings (
  id bigint generated always as identity primary key,
  device_id text not null references public.devices(id) on delete cascade,
  temp numeric not null,
  humidity numeric,
  created_at timestamptz not null default now()
);
create index readings_device_time_idx on public.readings (device_id, created_at desc);

-- ประวัติการแจ้งเตือน
create table public.alerts (
  id bigint generated always as identity primary key,
  device_id text references public.devices(id) on delete set null,
  kind text not null,                          -- offline | temp_high | temp_low | recovery
  message text not null,
  created_at timestamptz not null default now(),
  acked_at timestamptz,
  acked_by text,
  escalated_at timestamptz
);
create index alerts_open_idx on public.alerts (created_at) where acked_at is null;

-- ทะเบียนล็อตวัคซีน
create table public.vaccine_lots (
  id uuid primary key default gen_random_uuid(),
  vaccine_name text not null,
  lot_no text not null,
  qty int not null default 0,
  expiry_date date not null,
  device_id text references public.devices(id) on delete set null,
  received_date date default current_date,
  note text,
  active boolean not null default true,
  notified_days int[] not null default '{}',   -- เกณฑ์ที่แจ้งไปแล้ว กันแจ้งซ้ำ
  created_at timestamptz not null default now()
);

-- ===== สิทธิ์และ RLS =====
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

alter table public.devices enable row level security;
alter table public.readings enable row level security;
alter table public.alerts enable row level security;
alter table public.vaccine_lots enable row level security;

-- เจ้าหน้าที่ที่ล็อกอินแล้วอ่านได้ (ไม่รวมคอลัมน์ api_key)
grant select (id, name, location, min_temp, max_temp, last_seen, last_temp, status, status_since, active)
  on public.devices to authenticated;
create policy devices_read on public.devices for select to authenticated using (true);

grant select on public.readings to authenticated;
create policy readings_read on public.readings for select to authenticated using (true);

grant select on public.alerts to authenticated;
grant update (acked_at, acked_by) on public.alerts to authenticated;
create policy alerts_read on public.alerts for select to authenticated using (true);
create policy alerts_ack on public.alerts for update to authenticated using (true) with check (true);

grant select, insert, update, delete on public.vaccine_lots to authenticated;
create policy lots_all on public.vaccine_lots for all to authenticated using (true) with check (true);

-- ===== ข้อมูลตั้งต้น: 2 ตู้เย็น (แก้ชื่อ/สถานที่ได้) =====
insert into public.devices (id, name, location) values
  ('fridge-1', 'ตู้เย็นวัคซีน 1', 'รพ.สต. (แก้ไขชื่อ)'),
  ('fridge-2', 'ตู้เย็นวัคซีน 2', 'รพ.สต. (แก้ไขชื่อ)');

-- ดู api_key ของแต่ละตู้เพื่อนำไปใส่ในโค้ด ESP32:
--   select id, api_key from public.devices;
