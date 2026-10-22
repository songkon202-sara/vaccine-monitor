// ใส่ค่าจริงในไฟล์ secrets.h (คัดลอกจากไฟล์นี้) ห้ามนำ secrets.h ขึ้น GitHub
#pragma once

#define WIFI_SSID   "ชื่อ Wi-Fi ของ รพ.สต."
#define WIFI_PASS   "รหัสผ่าน Wi-Fi"

// Project URL ของ Supabase + /functions/v1/ingest
#define INGEST_URL  "https://PROJECT_REF.supabase.co/functions/v1/ingest"

// ค่าจากตาราง devices (select id, api_key from public.devices;)
// บอร์ดตู้ 1: fridge-1 (ช่องเย็น) และ fridge-1-freezer (ช่องแช่แข็ง)
// บอร์ดตู้ 2: fridge-2 และ fridge-2-freezer พร้อม api_key ของแต่ละรายการ
#define DEVICE_ID   "fridge-1"
#define API_KEY     "คัดลอก api_key ของ fridge-1 มาใส่"
#define DEVICE_ID_2 "fridge-1-freezer"
#define API_KEY_2   "คัดลอก api_key ของ fridge-1-freezer มาใส่"