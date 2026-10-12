-- ส่วนเสริมที่ต้องรันหลัง 004_quality.sql
-- สิทธิ์ผู้ใช้: staff (เจ้าหน้าที่) / admin (ผู้ดูแลระบบ จัดการสมาชิกได้ผ่านหน้า "สมาชิก" ในแดชบอร์ด)
-- การเพิ่ม/ระงับบัญชีทำผ่าน Edge Function manage-staff (ใช้ service role ฝั่งเซิร์ฟเวอร์เท่านั้น)

create table if not exists public.staff_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('staff', 'admin')),
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.staff_roles enable row level security;
revoke all on public.staff_roles from anon, authenticated;
-- ผู้ใช้ดูได้เฉพาะสิทธิ์ของตัวเอง (หน้าเว็บใช้ตัดสินว่าจะแสดงเมนู "สมาชิก" หรือไม่)
grant select on public.staff_roles to authenticated;
drop policy if exists staff_roles_self on public.staff_roles;
create policy staff_roles_self on public.staff_roles for select to authenticated using (user_id = auth.uid());

-- ผู้ดูแลระบบคนแรก = บัญชีที่สร้างก่อนสุด
insert into public.staff_roles (user_id, role, updated_by)
select id, 'admin', 'setup' from auth.users order by created_at limit 1
on conflict (user_id) do update set role = 'admin';

-- ตรวจผล: select u.email, r.role from public.staff_roles r join auth.users u on u.id = r.user_id;
