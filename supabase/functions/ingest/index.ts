import { admin as sb, json, safeEqual } from '../_shared/supabase.ts';

// รับค่าอุณหภูมิจาก ESP32
// POST { device_id, api_key, temp, humidity? }
Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const deviceId = String(b.device_id ?? '');
  const apiKey = String(b.api_key ?? '');
  if (!deviceId || !apiKey) return json({ error: 'unauthorized' }, 401);

  const temp = Number(b.temp);
  // ค่านอกช่วงนี้ถือว่าเซนเซอร์เสีย (เช่น -127 หรือ 85) ไม่บันทึก
  // ผลคือตู้จะ "เงียบ" และระบบแจ้งเตือนว่าขาดสัญญาณ
  if (!Number.isFinite(temp) || temp < -40 || temp > 60) return json({ error: 'invalid temp' }, 400);

  const humRaw = b.humidity === undefined || b.humidity === null ? NaN : Number(b.humidity);
  const humidity = Number.isFinite(humRaw) && humRaw >= 0 && humRaw <= 100 ? humRaw : null;

  const { data: dev, error: e1 } = await sb
    .from('devices')
    .select('id, api_key, active')
    .eq('id', deviceId)
    .maybeSingle();
  if (e1) {
    console.error(e1);
    return json({ error: 'server error' }, 500);
  }
  if (!dev || !dev.active || !safeEqual(String(dev.api_key), apiKey)) return json({ error: 'unauthorized' }, 401);

  const now = new Date().toISOString();
  const rounded = Math.round(temp * 100) / 100;

  const { error: e2 } = await sb
    .from('readings')
    .insert({ device_id: deviceId, temp: rounded, humidity, created_at: now });
  if (e2) {
    console.error(e2);
    return json({ error: 'server error' }, 500);
  }

  const { error: e3 } = await sb.from('devices').update({ last_seen: now, last_temp: rounded }).eq('id', deviceId);
  if (e3) {
    console.error(e3);
    return json({ error: 'server error' }, 500);
  }

  return json({ ok: true, server_time: now });
});
