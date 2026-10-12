-- ส่วนเสริมที่ต้องรันหลัง 002_settings.sql

-- ค่าชดเชยเซนเซอร์ต่อช่อง (สอบเทียบกับเทอร์โมมิเตอร์มาตรฐาน)
--   ถ้าเทอร์โมมิเตอร์มาตรฐานอ่านได้ 5.0°C แต่เซนเซอร์อ่านได้ 5.4°C ให้ตั้ง temp_offset = -0.4
alter table public.devices
  add column if not exists temp_offset numeric not null default 0
  check (temp_offset between -5 and 5);

-- เก็บค่าดิบจากเซนเซอร์ไว้ตรวจสอบย้อนหลัง (temp = ค่าดิบ + temp_offset)
alter table public.readings add column if not exists raw_temp numeric;

-- เจ้าหน้าที่ดูค่าชดเชยได้ในแดชบอร์ด (แก้ได้เฉพาะผ่าน SQL Editor)
grant select (temp_offset) on public.devices to authenticated;
