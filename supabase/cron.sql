-- ตั้งเวลาให้ระบบตรวจสอบทุกนาที
-- รันไฟล์นี้ "หลัง" deploy Edge Functions แล้ว และแก้ 2 ค่าด้านล่างก่อนรัน:
--   PROJECT_REF      = รหัสโปรเจกต์ Supabase (ส่วนหน้า .supabase.co ใน Project URL)
--   CRON_SECRET_HERE = ข้อความสุ่มยาว ๆ ที่ต้องตรงกับ secret CRON_SECRET ของ Edge Functions
-- หมายเหตุ: ค่า secret จะถูกเก็บในตาราง cron.job ซึ่งผู้ใช้ทั่วไปอ่านไม่ได้

select cron.schedule(
  'vaccine-check-alerts',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/check-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'CRON_SECRET_HERE'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);

-- ลบข้อมูลอุณหภูมิที่เก่ากว่า 400 วัน ทุกวัน 03:30 น. (เวลาไทย) เพื่อไม่ให้เกินโควตาฟรี
select cron.schedule(
  'vaccine-prune-readings',
  '30 20 * * *',
  $$ delete from public.readings where created_at < now() - interval '400 days'; $$
);

-- ตรวจสอบ:   select jobname, schedule, active from cron.job;
-- ดูผลรัน:    select * from cron.job_run_details order by start_time desc limit 10;
-- ยกเลิก:     select cron.unschedule('vaccine-check-alerts');
