-- ส่วนเสริมที่ต้องรันหลัง 001_schema.sql

-- ตั้งค่าระบบ (เก็บ LINE group id ฯลฯ) อ่าน/เขียนได้เฉพาะ service role (Edge Functions)
create table public.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;
revoke all on public.settings from anon, authenticated;

-- สถานะการส่ง LINE ของแต่ละแจ้งเตือน
--   push_status = null       -> ยังไม่ได้ส่ง (ระบบลองส่งใหม่ทุกนาที)
--   push_status = 'sent'     -> ส่งสำเร็จ
--   push_status = 'obsolete' -> สถานการณ์เปลี่ยนไปแล้วก่อนส่ง จึงไม่ส่ง
alter table public.alerts
  add column sent_at timestamptz,
  add column push_status text check (push_status in ('sent', 'obsolete'));

create index alerts_unsent_idx on public.alerts (created_at) where push_status is null;
create index alerts_escalate_idx on public.alerts (sent_at)
  where acked_at is null and escalated_at is null and push_status = 'sent';
