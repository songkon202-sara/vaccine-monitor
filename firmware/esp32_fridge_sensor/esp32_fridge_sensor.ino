/*
  ESP32 + DS18B20 ส่งอุณหภูมิตู้เย็นวัคซีนขึ้น Supabase ทุก 5 นาที

  การต่อสาย (DS18B20 แบบ 3 เส้น)
    แดง   (VCC)  -> 3V3
    ดำ    (GND)  -> GND
    เหลือง (DATA) -> GPIO 4  และต่อตัวต้านทาน 4.7 kΩ ระหว่าง DATA กับ 3V3
    (โมดูลที่มีตัวต้านทานบนบอร์ดแล้วไม่ต้องต่อเพิ่ม)

  ตู้ที่มี 2 ช่อง (เช่น ช่องเย็น 2–8°C + ช่องแช่แข็ง) ใช้ ESP32 ตัวเดียว ต่อหัววัดตัวที่ 2:
    แดง -> 3V3, ดำ -> GND, เหลือง -> GPIO 18 และต่อตัวต้านทาน 4.7 kΩ ระหว่าง GPIO 18 กับ 3V3
  แล้วใส่ DEVICE_ID_2 / API_KEY_2 ใน secrets.h (แต่ละช่องเป็น "ตู้" แยกกันในระบบ)

  ไลบรารีที่ต้องติดตั้งใน Arduino IDE (Library Manager)
    - OneWire (Paul Stoffregen)
    - DallasTemperature (Miles Burton)
  บอร์ด: ESP32 Dev Module (ติดตั้ง "esp32 by Espressif Systems" ใน Boards Manager)

  วิธีใช้: คัดลอก secrets.example.h เป็น secrets.h แล้วแก้ค่า จากนั้นอัปโหลด
  ตู้อื่นใช้โค้ดเดิม เปลี่ยนแค่ DEVICE_ID และ API_KEY ใน secrets.h

  ข้อควรระวัง
  - วางหัวโพรบในขวดเล็กที่ใส่น้ำ/สารละลายกลีเซอรอล ปิดฝา วางข้างวัคซีน
    ไม่ติดผนังหรือช่องแช่แข็ง เพื่อให้ค่าใกล้เคียงอุณหภูมิตัววัคซีนและไม่แกว่งเวลาเปิดตู้
  - ถ้าอ่านเซนเซอร์ไม่ได้ จะไม่ส่งค่า ฝั่งเซิร์ฟเวอร์จะเห็นว่าตู้ "เงียบ" และแจ้งเตือนขาดสัญญาณ
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include "secrets.h"

// ---------- ค่าที่ปรับได้ ----------
const int ONE_WIRE_PIN = 4;                          // ขา DATA ของ DS18B20 ตัวที่ 1
const int ONE_WIRE_PIN_2 = 18;                       // ขา DATA ของ DS18B20 ตัวที่ 2 (ใช้เมื่อตั้ง DEVICE_ID_2)
const unsigned long SEND_INTERVAL_MS = 5UL * 60UL * 1000UL;  // ส่งทุก 5 นาที
const unsigned long WIFI_GIVEUP_RESTART_MS = 10UL * 60UL * 1000UL;  // ต่อ Wi-Fi ไม่ได้นานเท่านี้ให้รีสตาร์ท
const unsigned long DAILY_RESTART_MS = 24UL * 60UL * 60UL * 1000UL; // รีสตาร์ทวันละครั้งกันบอร์ดค้าง
const int SEND_ATTEMPTS = 3;                         // พยายามส่งซ้ำกี่ครั้งต่อรอบ

// true  = ไม่ตรวจใบรับรอง TLS (ตั้งค่าง่าย แต่เสี่ยงถูกดักข้อมูลโดยผู้ไม่หวังดีที่อยู่ในเครือข่ายเดียวกัน)
// ข้อมูลที่ส่งคืออุณหภูมิและ api_key ของตู้นี้เท่านั้น (ใช้ได้แค่ส่งค่าอุณหภูมิ) ถ้าต้องการเข้มงวดขึ้น
// ให้เปลี่ยนเป็น false แล้วใส่ใบรับรอง root CA ผ่าน client.setCACert(...)
const bool TLS_INSECURE = true;

// หัววัดแต่ละตัวต่อคนละขา จึงรู้แน่นอนว่าค่าไหนเป็นของช่องไหน
OneWire wire1(ONE_WIRE_PIN);
DallasTemperature temp1(&wire1);
#ifdef DEVICE_ID_2
OneWire wire2(ONE_WIRE_PIN_2);
DallasTemperature temp2(&wire2);
#endif

struct Probe {
  DallasTemperature* sensors;
  const char* deviceId;
  const char* apiKey;
};

Probe probes[] = {
  {&temp1, DEVICE_ID, API_KEY},
#ifdef DEVICE_ID_2
  {&temp2, DEVICE_ID_2, API_KEY_2},
#endif
};
const int PROBE_COUNT = sizeof(probes) / sizeof(probes[0]);

unsigned long lastSend = 0;
unsigned long wifiLostSince = 0;

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " connected" : " failed");
}

void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiLostSince = 0;
    return;
  }
  if (wifiLostSince == 0) wifiLostSince = millis();
  if (millis() - wifiLostSince > WIFI_GIVEUP_RESTART_MS) {
    Serial.println("WiFi lost too long, restarting");
    ESP.restart();
  }
  WiFi.disconnect();
  connectWiFi();
}

// คืน NAN ถ้าอ่านค่าไม่ได้
float readTemperature(Probe& p) {
  for (int i = 0; i < 3; i++) {
    p.sensors->requestTemperatures();
    float t = p.sensors->getTempCByIndex(0);
    // -127 = ไม่พบเซนเซอร์, 85.0 = ค่าเริ่มต้นหลังเปิดเครื่อง (ยังไม่ได้วัดจริง)
    if (t != DEVICE_DISCONNECTED_C && t != 85.0 && t > -55.0 && t < 125.0) return t;
    delay(500);
  }
  return NAN;
}

bool sendReading(Probe& p, float t) {
  WiFiClientSecure client;
  if (TLS_INSECURE) client.setInsecure();

  HTTPClient http;
  http.setTimeout(15000);
  if (!http.begin(client, INGEST_URL)) return false;
  http.addHeader("Content-Type", "application/json");

  String body = String("{\"device_id\":\"") + p.deviceId + "\",\"api_key\":\"" + p.apiKey +
                "\",\"temp\":" + String(t, 2) + "}";
  int code = http.POST(body);
  Serial.printf("[%s] POST -> HTTP %d\n", p.deviceId, code);
  http.end();
  return code == 200;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  for (Probe& p : probes) {
    p.sensors->begin();
    p.sensors->setResolution(12);
  }
  Serial.printf("Probes: %d\n", PROBE_COUNT);
  connectWiFi();
  lastSend = millis() - SEND_INTERVAL_MS;  // ส่งทันทีหลังเปิดเครื่อง
}

void loop() {
  if (millis() > DAILY_RESTART_MS) ESP.restart();

  ensureWiFi();

  if (WiFi.status() == WL_CONNECTED && millis() - lastSend >= SEND_INTERVAL_MS) {
    lastSend = millis();
    for (Probe& p : probes) {
      float t = readTemperature(p);
      if (isnan(t)) {
        Serial.printf("[%s] Sensor read failed, skip\n", p.deviceId);
        continue;
      }
      Serial.printf("[%s] Temp = %.2f C\n", p.deviceId, t);
      for (int i = 0; i < SEND_ATTEMPTS; i++) {
        if (sendReading(p, t)) break;
        delay(5000);
      }
    }
  }
  delay(1000);
}
