# ระบบแจ้งเตือนตู้เย็นวัคซีน (ไฟดับ / อุณหภูมิผิดปกติ / ใกล้หมดอายุ)

เซนเซอร์ ESP32 + DS18B20 ส่งอุณหภูมิขึ้น Supabase ทุก 5 นาที ระบบตรวจสอบทุกนาทีและแจ้งเข้ากลุ่ม LINE
ไม่ต้องให้เจ้าหน้าที่กรอกอุณหภูมิเอง ใช้บริการฟรีทั้งหมด (Supabase + GitHub Pages + LINE OA)

```
ESP32 ──HTTPS──▶ Edge Function: ingest ──▶ Postgres (devices, readings, alerts, vaccine_lots)
                                              ▲
pg_cron ทุก 1 นาที ──▶ Edge Function: check-alerts ──▶ LINE push (กลุ่ม รพ.สต.)
LINE กลุ่ม ◀──▶ Edge Function: line-webhook   (พิมพ์ "รับทราบ", "สถานะ")
GitHub Pages: docs/index.html  (แดชบอร์ด ล็อกอินด้วยอีเมล)
```

## กติกาแจ้งเตือน

| เหตุการณ์ | เงื่อนไข (ปรับได้ในตาราง `devices`) | การแจ้ง |
|---|---|---|
| ขาดสัญญาณ / ไฟดับ | ไม่ได้รับข้อมูลเกิน `offline_after_min` (15 นาที) | แจ้งกลุ่ม LINE |
| อุณหภูมิสูง/ต่ำ | ค่าที่วัดได้ใน `temp_alert_after_min` (10 นาที) นอกช่วง 2–8°C ทุกค่า อย่างน้อย 2 ค่า | แจ้งกลุ่ม LINE |
| ไม่มีคนรับทราบ | ผ่านไป 20 นาทีหลังแจ้ง (`ESCALATE_AFTER_MIN`) | แจ้งซ้ำไปยัง `ESCALATION_USER_IDS` (ถ้าไม่ตั้ง แจ้งซ้ำเข้ากลุ่ม) |
| กลับสู่ปกติ | กลับมาส่งสัญญาณและอุณหภูมิอยู่ในช่วง | แจ้งพร้อมระยะเวลา และปิดแจ้งเตือนที่ค้างให้อัตโนมัติ |
| วัคซีนใกล้หมดอายุ | เหลือ 90 / 60 / 30 / 14 / 7 วัน และวันหมดอายุ (แจ้ง 08:00–16:00 น.) | แจ้งสรุปเข้ากลุ่ม ครั้งเดียวต่อเกณฑ์ |

หมายเหตุ: เพราะไม่มี UPS ไฟดับแล้วเซนเซอร์และเราเตอร์ดับด้วย ระบบจึงตรวจจาก "สัญญาณเงียบ" ฝั่งเซิร์ฟเวอร์
ระหว่างไฟดับจะ **ไม่มีข้อมูลอุณหภูมิ** รู้แค่เวลาที่ไฟดับและกลับมา

## ทางลัด: ใช้สคริปต์ติดตั้ง (แนะนำ)

ต้องมี Node.js 18 ขึ้นไป และทำขั้นตอนที่ต้องใช้บัญชีของคุณเองก่อน ได้แก่ สร้างโปรเจกต์ Supabase (ข้อ 1.1)
และเปิด Messaging API ของ LINE OA (ข้อ 2) จากนั้น:

```bash
node scripts/setup.mjs        # ถาม Project ref + โทเคน LINE (ไม่แสดงตอนพิมพ์) แล้วตั้ง secrets และ deploy ให้
```
สคริปต์จะสร้าง `supabase/.env` พร้อมรหัสสุ่ม, ล็อกอิน/เชื่อมโปรเจกต์/ตั้ง secrets/deploy ทั้ง 3 ฟังก์ชัน
และสร้าง `supabase/setup.generated.sql` (ตาราง + ตั้งเวลาตรวจทุกนาที กรอกค่าครบแล้ว) ให้คัดลอกไปวางใน SQL Editor ครั้งเดียว
ท้ายสคริปต์จะพิมพ์ขั้นตอนที่เหลือซึ่งต้องทำเอง (ปิดการสมัครสมาชิก, ใส่ Webhook URL, ตั้งกลุ่ม LINE)
ใช้ `--dry-run` เพื่อดูว่าจะทำอะไรโดยไม่เรียก Supabase จริง รันซ้ำได้ (ใช้ `.env` เดิม)

ทดสอบหลังติดตั้ง: `node scripts/smoke-test.mjs` (รายละเอียดในหัวข้อ "ทดสอบก่อนใช้งานจริง")

ไฟล์ที่สคริปต์สร้างมีรหัสลับ (`supabase/.env`, `supabase/*.generated.sql`) อยู่ใน `.gitignore` แล้ว ห้ามนำขึ้น GitHub

## ขั้นตอนติดตั้ง (ทำเองทีละข้อ)

### 1) สร้างโปรเจกต์ Supabase
1. สมัคร supabase.com สร้าง Project (เลือก Region ใกล้ไทย เช่น Singapore)
2. เมนู SQL Editor: เปิดไฟล์ `supabase/migrations/001_schema.sql` คัดลอกไปรัน แล้วทำเช่นเดียวกันกับ `002_settings.sql`
3. รัน `select id, api_key from public.devices;` เพื่อดู api_key ของ `fridge-1` และ `fridge-2` (จะใช้ในขั้นตอนที่ 6)
   และแก้ชื่อ/สถานที่ของตู้: `update public.devices set name='...', location='...' where id='fridge-1';`
4. **สำคัญ:** เมนู Authentication ปิดตัวเลือก "Allow new users to sign up" (ชื่อเมนูอาจต่างเล็กน้อยตามเวอร์ชัน)
   แล้วสร้างบัญชีเจ้าหน้าที่ด้วยตัวเองที่ Authentication → Users → Add user (ติ๊ก Auto Confirm User)
   ถ้าไม่ปิด ใครก็สมัครแล้วดู/แก้ข้อมูลได้
5. Project Settings → API: จดค่า Project URL และ anon (publishable) key

### 2) ตั้งค่า LINE Official Account
1. LINE Official Account Manager → Settings → Messaging API → Enable (เลือก Provider)
2. Response settings: เปิด Webhook, ปิดข้อความตอบกลับอัตโนมัติ/ข้อความต้อนรับ, เปิด "Allow bot to join group chats"
3. LINE Developers Console → เลือก Channel นี้: คัดลอก **Channel secret** (แท็บ Basic settings)
   และกด Issue **Channel access token (long-lived)** (แท็บ Messaging API)
4. ยังไม่ต้องใส่ Webhook URL ตอนนี้ (ทำในข้อ 4)

### 3) Deploy Edge Functions
ติดตั้ง Node.js แล้วรันในโฟลเดอร์โปรเจกต์นี้:
```bash
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
cp supabase/.env.example supabase/.env      # แล้วกรอกค่าในไฟล์ .env
npx supabase secrets set --env-file supabase/.env
npx supabase functions deploy ingest --no-verify-jwt
npx supabase functions deploy check-alerts --no-verify-jwt
npx supabase functions deploy line-webhook --no-verify-jwt
```
ค่าใน `.env`: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `CRON_SECRET` (ข้อความสุ่มยาว ๆ), `SETUP_PASSCODE` (รหัสตั้งกลุ่ม)
ถ้า CLI แจ้งปัญหาเรื่อง config.toml ให้รัน `npx supabase init` แล้วเพิ่มบล็อก `[functions.*] verify_jwt = false` ตามไฟล์เดิม

ทางเลือก: ตั้ง GitHub Secrets `SUPABASE_ACCESS_TOKEN` และ `SUPABASE_PROJECT_ID` แล้วเมื่อ push โค้ดใน `supabase/functions` ขึ้น main
`.github/workflows/deploy-functions.yml` จะ deploy ให้อัตโนมัติ (ส่วน secrets ของ LINE ยังต้องตั้งด้วยคำสั่ง `secrets set` ข้างบนครั้งเดียว)

### 4) เชื่อม LINE กับระบบ
1. LINE Developers Console → Messaging API → Webhook URL ใส่
   `https://<PROJECT_REF>.supabase.co/functions/v1/line-webhook` กด Verify (ควรได้ Success) แล้วเปิด Use webhook
2. สร้างกลุ่ม LINE สำหรับผู้รับแจ้งเตือน (แนะนำกลุ่มเล็ก ดูหมายเหตุโควตาด้านล่าง) เชิญบัญชี OA เข้ากลุ่ม
3. พิมพ์ในกลุ่ม: `ตั้งกลุ่มนี้ <SETUP_PASSCODE>` บอทจะตอบว่าตั้งค่าแล้ว (แนะนำให้ลบข้อความที่มีรหัสออก)
4. (ไม่บังคับ) ให้ผู้รับผิดชอบหลักแต่ละคนแอดบอทเป็นเพื่อนแล้วพิมพ์ `/myid` ในแชตส่วนตัว นำ userId มาใส่ `ESCALATION_USER_IDS`
   (คั่นด้วยจุลภาค) แล้วรัน `secrets set` อีกครั้ง

### 5) ตั้งเวลาตรวจทุกนาที
เปิด `supabase/cron.sql` แก้ `PROJECT_REF` และ `CRON_SECRET_HERE` (ต้องตรงกับ `CRON_SECRET`) แล้วคัดลอกไปรันใน SQL Editor
ตรวจว่าทำงาน: `select * from cron.job_run_details order by start_time desc limit 5;`

### 6) อุปกรณ์ ESP32 (ทำ 2 ชุด)
1. ต่อสายตามคอมเมนต์ในไฟล์ `firmware/esp32_fridge_sensor/esp32_fridge_sensor.ino`
2. คัดลอก `secrets.example.h` เป็น `secrets.h` ใส่ Wi-Fi, URL, DEVICE_ID, API_KEY ของแต่ละตู้
3. ติดตั้งไลบรารี OneWire และ DallasTemperature แล้วอัปโหลดผ่าน Arduino IDE
4. ดู Serial Monitor (115200) ควรเห็น `POST -> HTTP 200`
5. วางหัวโพรบในขวดน้ำ/กลีเซอรอลปิดฝา ข้างวัคซีน ร้อยสายผ่านขอบยางประตู ตั้งกล่องบอร์ดไว้นอกตู้

### 7) แดชบอร์ดบน GitHub Pages
1. แก้ `docs/config.js` ใส่ Project URL และ anon key
2. สร้าง GitHub repo (ใช้ repo สาธารณะเพื่อให้ Pages ฟรี ในโปรเจกต์นี้ไม่มี secret ใน repo) push โค้ดทั้งหมดขึ้น
3. Settings → Pages → Deploy from a branch → `main` โฟลเดอร์ `/docs`
4. เปิดลิงก์ที่ได้ ล็อกอินด้วยบัญชีจากข้อ 1.4 แล้วเพิ่มล็อตวัคซีนในแท็บ "ทะเบียนวัคซีน"

## ทดสอบก่อนใช้งานจริง

**1) ตรวจว่าเซิร์ฟเวอร์ตอบถูกต้อง** (ไม่ส่งข้อความเข้า LINE ถ้าทุกอย่างปกติ)
```bash
node scripts/smoke-test.mjs
```
ถามเฉพาะ Project ref, Device ID และ api_key (ดูได้จาก `select id, api_key from public.devices;`) แล้วตรวจ
การปฏิเสธ api_key/secret/ลายเซ็นที่ผิด, การรับค่าปกติ และการทำงานของ `check-alerts` โดยไม่มี error

**2) ทดสอบแจ้งเตือนเข้า LINE จริง ด้วย "ตู้ทดสอบ"**
ระบบถือว่าอุณหภูมิสูงเมื่อค่าที่วัดได้ในช่วงตรวจ *ทุกค่า* เกินเกณฑ์ ถ้าทดสอบกับตู้จริงที่มีค่าปกติส่งเข้ามาอยู่
จะไม่เกิดแจ้งเตือน และข้อมูลทดสอบจะปนกับข้อมูลจริง จึงให้สร้างตู้ทดสอบแยกต่างหาก (ใน SQL Editor):
```sql
insert into public.devices (id, name, location, temp_alert_after_min)
values ('test-fridge', 'ตู้ทดสอบ (ปิดหลังทดสอบ)', 'ทดสอบ', 1);
select api_key from public.devices where id = 'test-fridge';
```
แจ้งคนในกลุ่ม LINE ว่าจะมีข้อความทดสอบ แล้วรัน (ระบบจะรอประมาณ 1 นาทีให้ค่าปกติหลุดช่วงตรวจก่อนส่งค่าสูง):
```bash
DEVICE_ID=test-fridge node scripts/smoke-test.mjs --alert-test
```
ควรเห็นแจ้งเตือนอุณหภูมิสูงเข้ากลุ่ม และข้อความกลับสู่ปกติหลังกด Enter เสร็จแล้ว **ปิดตู้ทดสอบทันที**
ไม่เช่นนั้นอีกราว 15 นาทีจะมีแจ้งเตือนขาดสัญญาณของตู้ทดสอบ:
```sql
update public.devices set active = false where id = 'test-fridge';
```
ระบบกันส่งซ้ำชนิดเดียวกันของตู้เดียวกันภายใน 30 นาที การทดสอบซ้ำติดกันอาจไม่ส่ง (`sent: 0`) ให้รอหรือใช้ตู้ทดสอบ Device ID ใหม่

**3) ทดสอบไฟดับ**
`update public.devices set offline_after_min = 2 where id='fridge-1';` ถอดปลั๊ก ESP32 รอ 3–4 นาที ควรมีแจ้งเตือนขาดสัญญาณ
เสียบปลั๊กคืนควรมีข้อความกลับสู่ปกติ แล้วคืนค่า `set offline_after_min = 15`

**4) ทดสอบคำสั่งในกลุ่ม** พิมพ์ `สถานะ` และ `รับทราบ`

**5) ทดสอบหลังติดตั้งจริงบนตู้เย็นอย่างน้อย 1–2 วัน** ก่อนเชื่อถือระบบ

## ส่วนเสริม (หลังติดตั้งครั้งแรก)

### ค่าชดเชยเซนเซอร์ (สอบเทียบ)
รัน `supabase/migrations/003_offset_heartbeat.sql` ใน SQL Editor **ก่อน** deploy ฟังก์ชัน `ingest` รุ่นใหม่
วางเซนเซอร์คู่กับเทอร์โมมิเตอร์มาตรฐาน ถ้ามาตรฐานอ่านได้ 5.0°C แต่เซนเซอร์อ่านได้ 5.4°C:
`update public.devices set temp_offset = -0.4 where id = 'fridge-1';`
ค่าดิบเก็บใน `readings.raw_temp` ค่าที่ใช้แจ้งเตือน/รายงานคือ `readings.temp` (ค่าดิบ + ชดเชย)

### เฝ้าระบบจากภายนอก (heartbeat)
ถ้าระบบตรวจหยุดทำงาน (Supabase ล่ม/ถูกพัก, cron หยุด) หรือส่ง LINE ไม่ได้ (เช่น โควตาหมด) จะไม่มีแจ้งเตือนใดออกมาเลย
จึงให้ `check-alerts` ส่งสัญญาณไปยัง [healthchecks.io](https://healthchecks.io) (ฟรี) ทุกนาที:
1. สมัคร healthchecks.io สร้าง Check: Period 1 นาที, Grace 10 นาที, ตั้งอีเมลผู้รับ
2. คัดลอก Ping URL ใส่ `HEARTBEAT_URL=` ใน `supabase/.env` แล้ว `npx supabase secrets set --env-file supabase/.env --project-ref <REF>`
3. ถ้าไม่มีสัญญาณเกิน 10 นาที หรือรายงานว่าส่ง LINE ไม่สำเร็จ จะได้อีเมลเตือน

## ข้อควรรู้และข้อจำกัด
- **โควตาข้อความ LINE:** แผนฟรีมีโควตารายเดือนจำกัด และการ push เข้ากลุ่มนับตามจำนวนสมาชิกที่ได้รับ
  (ตามเอกสาร LINE ส่วน reply ไม่นับ) ระบบจึงแจ้งเฉพาะตอนสถานะเปลี่ยน และกันส่งซ้ำชนิดเดียวกันภายใน 30 นาที
  แนะนำกลุ่มเล็กเฉพาะผู้รับผิดชอบ ตรวจโควตาจริงใน OA Manager
- **ระบบพึ่งพาอินเทอร์เน็ตและบริการภายนอก** ถ้า Supabase/LINE ขัดข้องหรือ cron หยุด จะไม่มีแจ้งเตือน ควรเปิดแดชบอร์ดดูเป็นระยะ
  และมีขั้นตอนสำรอง (SOP) ของหน่วยงาน
- **ความแม่นยำ:** DS18B20 ที่ไม่ได้สอบเทียบมีความคลาดเคลื่อนประมาณ ±0.5°C ใช้เป็นระบบเตือนภัยเสริม
  ไม่ใช่ทดแทนเครื่องบันทึกอุณหภูมิ/เทอร์โมมิเตอร์ที่สอบเทียบตามเกณฑ์ที่หน่วยงานกำหนด
- **TLS ใน ESP32:** ตั้งค่าเริ่มต้นเป็นไม่ตรวจใบรับรอง (`TLS_INSECURE = true`) เพื่อให้ติดตั้งง่าย ข้อมูลที่ส่งมีแค่อุณหภูมิและ api_key
  ของตู้นั้น หากต้องการเข้มงวดดูคอมเมนต์ในโค้ด
- ถ้าอ่านเซนเซอร์ไม่ได้ (สายหลุด/เสีย) ตู้จะ "เงียบ" และได้แจ้งเตือนขาดสัญญาณ ไม่ใช่แจ้งอุณหภูมิ
- ถ้าต้องการให้รู้อุณหภูมิระหว่างไฟดับ ให้เพิ่มแบตสำรองให้ ESP32 และเราเตอร์ในภายหลัง
- ข้อมูลอุณหภูมิถูกลบอัตโนมัติเมื่อเก่ากว่า 400 วัน (ตั้งใน `cron.sql`)
- การติดตามผล/ใช้ข้อมูลของคนไข้: ระบบนี้ไม่เก็บข้อมูลผู้ป่วยเลย เก็บเฉพาะอุณหภูมิตู้และทะเบียนล็อตวัคซีน

## สถานะการทดสอบ
ทดสอบแล้ว: ตรรกะตัดสินสถานะ/ข้อความ/วันหมดอายุ (`node supabase/functions/_shared/logic.test.ts`),
สคีมาและสิทธิ์ (RLS) บน PostgreSQL จริง, สคริปต์ติดตั้ง (`--dry-run`), สคริปต์ทดสอบกับเซิร์ฟเวอร์จำลอง,
ตรวจ syntax ของ SQL, TypeScript และ JavaScript ของแดชบอร์ด
ยังไม่ได้ทดสอบกับ Supabase, LINE และ ESP32 จริง (ต้องใช้บัญชีและอุปกรณ์ของคุณ) ให้ทดสอบตามหัวข้อ "ทดสอบก่อนใช้งานจริง"

## โครงสร้างไฟล์
```
supabase/migrations/   001_schema.sql, 002_settings.sql
supabase/cron.sql      ตั้งเวลาตรวจทุกนาที (สคริปต์ติดตั้งนำไปรวมในไฟล์ .generated.sql ให้แล้ว)
supabase/functions/    ingest, check-alerts, line-webhook, _shared
scripts/               setup.mjs (ติดตั้ง), smoke-test.mjs (ทดสอบ)
docs/                  แดชบอร์ด (GitHub Pages)
firmware/              โค้ด ESP32
```
