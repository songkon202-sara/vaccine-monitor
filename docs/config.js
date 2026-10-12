// ตั้งค่าการเชื่อมต่อ Supabase (Project Settings -> API)
// ค่า anon/publishable key เปิดเผยในหน้าเว็บได้ เพราะข้อมูลถูกป้องกันด้วย RLS + การล็อกอิน
// ห้ามใส่ service_role key ในไฟล์นี้เด็ดขาด
window.APP_CONFIG = {
  SUPABASE_URL: 'https://gucztyazlfejzpgkrcrl.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1Y3p0eWF6bGZlanpwZ2tyY3JsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3OTA0MDEsImV4cCI6MjEwNzM2NjQwMX0.LevndiqlOiWtSZKEVA1m0p155DW7evZqDNlj5Z_tIxc',
};
