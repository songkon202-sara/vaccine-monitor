// ใส่ค่าจริงในไฟล์ secrets.h (คัดลอกจากไฟล์นี้) ห้ามนำ secrets.h ขึ้น GitHub
#pragma once

#define WIFI_SSID   "ชื่อ Wi-Fi ของ รพ.สต."
#define WIFI_PASS   "รหัสผ่าน Wi-Fi"

// Project URL ของ Supabase + /functions/v1/ingest
#define INGEST_URL  "https://PROJECT_REF.supabase.co/functions/v1/ingest"

// ค่าจากตาราง devices (select id, api_key from public.devices;)
// ตู้ที่ 1 ใช้ fridge-1 ตู้ที่ 2 ใช้ fridge-2 พร้อม api_key ของแต่ละตู้
#define DEVICE_ID   "fridge-1"
#define API_KEY     "คัดลอก api_key ของตู้นี้มาใส่"
