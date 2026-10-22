-- ส่วนเสริมที่ต้องรันหลัง 005_staff.sql
-- 1) รวมแจ้งเตือนตามบอร์ด  2) เตือนซ้ำจนกว่าจะกลับปกติ  3) เกณฑ์วิกฤต  4) เทียบโพรบ 2 ตัวในช่องเดียวกัน
-- รันซ้ำได้ปลอดภัย (add column if not exists)

alter table public.devices
  add column if not exists board_id text,                      -- โพรบบนบอร์ด ESP32 เดียวกันใช้ค่าเดียวกัน
  add column if not exists critical_high numeric,              -- เกินค่านี้ = วิกฤต แจ้งทันทีด้วยค่าเดียว
  add column if not exists critical_low numeric,               -- ต่ำกว่าค่านี้ = วิกฤต แจ้งทันทีด้วยค่าเดียว
  add column if not exists twin_of text references public.devices(id) on delete set null;
                                                               -- id ของโพรบที่วัดช่องเดียวกัน (ตั้งเมื่อย้ายโพรบมาช่องเดียวกันแล้วเท่านั้น)

alter table public.alerts
  add column if not exists reminded_at timestamptz,
  add column if not exists reminder_count int not null default 0;

-- ตั้งค่าเริ่มต้นของ 2 ตู้ (4 โพรบ)
update public.devices set board_id = 'board-1' where id in ('fridge-1', 'fridge-1-freezer');
update public.devices set board_id = 'board-2' where id in ('fridge-2', 'fridge-2-freezer');
update public.devices set critical_high = 15, critical_low = 0
  where id in ('fridge-1', 'fridge-1-freezer', 'fridge-2', 'fridge-2-freezer');

-- เจ้าหน้าที่ที่ล็อกอินอ่านคอลัมน์ใหม่ได้ (ไม่รวม api_key)
grant select (board_id, critical_high, critical_low, twin_of) on public.devices to authenticated;

-- ===== ทำหลังย้ายโพรบมาไว้ช่องเย็นเดียวกันจริงแล้วเท่านั้น (เปิดการเทียบโพรบ 2 ตัว) =====
-- update public.devices set twin_of = 'fridge-1' where id = 'fridge-1-freezer';
-- update public.devices set twin_of = 'fridge-2' where id = 'fridge-2-freezer';
