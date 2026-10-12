-- ส่วนเสริมที่ต้องรันหลัง 003_offset_heartbeat.sql
-- คุณภาพการวัด: บันทึกการตรวจเทียบกับเทอร์โมมิเตอร์มาตรฐาน + สรุปความครบของข้อมูล

-- ===== การตรวจเทียบ =====
create table public.calibration_checks (
  id bigint generated always as identity primary key,
  device_id text not null references public.devices(id) on delete cascade,
  checked_at timestamptz not null,            -- เวลาที่อ่านเทอร์โมมิเตอร์มาตรฐาน
  ref_temp numeric not null,                  -- ค่าจากเทอร์โมมิเตอร์มาตรฐาน
  sensor_temp numeric,                        -- ค่าเซนเซอร์ (หลังชดเชย) ที่ใกล้เวลานั้นที่สุด
  raw_temp numeric,                           -- ค่าดิบของเซนเซอร์ (ก่อนชดเชย)
  reading_at timestamptz,                     -- เวลาของค่าเซนเซอร์ที่ใช้เทียบ
  diff numeric,                               -- ref_temp - sensor_temp
  tolerance numeric not null,                 -- เกณฑ์ผ่าน (±)
  passed boolean,
  note text,
  checked_by text default (auth.jwt() ->> 'email'),   -- ผู้ตรวจ (จากบัญชีที่ล็อกอิน แก้เองไม่ได้)
  created_at timestamptz not null default now()
);
create index calibration_checks_device_idx on public.calibration_checks (device_id, checked_at desc);

alter table public.calibration_checks enable row level security;
revoke all on public.calibration_checks from anon, authenticated;
-- เจ้าหน้าที่ดูและเพิ่มได้ แต่แก้/ลบไม่ได้ (เก็บเป็นหลักฐาน) ถ้ากรอกผิดให้เพิ่มรายการใหม่พร้อมหมายเหตุ
grant select on public.calibration_checks to authenticated;
grant insert (device_id, checked_at, ref_temp, sensor_temp, raw_temp, reading_at, diff, tolerance, passed, note)
  on public.calibration_checks to authenticated;
create policy cal_read on public.calibration_checks for select to authenticated using (true);
create policy cal_insert on public.calibration_checks for insert to authenticated with check (true);

-- ===== ความครบของข้อมูล: จำนวนค่าที่ได้รับต่อช่องต่อวัน (ตามวันเวลาไทย) =====
create or replace function public.reading_counts(p_from timestamptz, p_to timestamptz)
returns table (device_id text, day date, n bigint)
language sql stable security invoker set search_path = public
as $$
  select r.device_id, (r.created_at at time zone 'Asia/Bangkok')::date as day, count(*) as n
  from public.readings r
  where r.created_at >= p_from and r.created_at < p_to
  group by 1, 2
$$;
revoke all on function public.reading_counts(timestamptz, timestamptz) from public, anon;
grant execute on function public.reading_counts(timestamptz, timestamptz) to authenticated;
