// ตั้งค่าการเชื่อมต่อ Supabase (Project Settings -> API)
// ค่า anon/publishable key เปิดเผยในหน้าเว็บได้ เพราะข้อมูลถูกป้องกันด้วย RLS + การล็อกอิน
// ห้ามใส่ service_role key ในไฟล์นี้เด็ดขาด
window.APP_CONFIG = {
  SUPABASE_URL: 'https://PROJECT_REF.supabase.co',
  SUPABASE_ANON_KEY: 'PUT_ANON_OR_PUBLISHABLE_KEY_HERE',
};
