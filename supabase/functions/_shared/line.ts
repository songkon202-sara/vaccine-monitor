import { admin as sb, safeEqual } from './supabase.ts';

const API = 'https://api.line.me/v2/bot';
const clip = (s: string) => (s.length > 4900 ? s.slice(0, 4900) + '…' : s);

// สาเหตุล่าสุดที่ส่ง LINE ไม่สำเร็จ (เช่น "HTTP 429 ..." = โควตาหมด, "HTTP 401 ..." = โทเคนผิด/หมดอายุ)
// ใส่ในข้อความ heartbeat เพื่อให้เห็นสาเหตุทันที ไม่ต้องเปิดดู log
let lastLineError = '';
export const getLastLineError = () => lastLineError;

// ช่องทางสำรอง Telegram (ฟรี ไม่มีโควตาข้อความ): ตั้ง TELEGRAM_BOT_TOKEN และ TELEGRAM_CHAT_ID แล้วทุกแจ้งเตือนจะส่งทั้ง LINE และ Telegram
// ถ้าช่องทางใดช่องทางหนึ่งส่งสำเร็จ ถือว่าแจ้งเตือนถึงผู้รับแล้ว (กันโควตา LINE หมดแล้วไม่มีใครรู้)
let lastTelegramError = '';
export const getLastTelegramError = () => lastTelegramError;
export const telegramEnabled = () => !!(Deno.env.get('TELEGRAM_BOT_TOKEN') && Deno.env.get('TELEGRAM_CHAT_ID'));

async function telegramSend(text: string): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        // ถ้ากลุ่มเปิดโหมดหัวข้อ (Topics) ตั้ง TELEGRAM_THREAD_ID เพื่อส่งเข้าหัวข้อที่ต้องการ
        ...(Deno.env.get('TELEGRAM_THREAD_ID') ? { message_thread_id: Number(Deno.env.get('TELEGRAM_THREAD_ID')) } : {}),
        text: text.length > 4000 ? text.slice(0, 4000) + '…' : text,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      // ไม่ log URL (มี token) เฉพาะสถานะและข้อความจาก Telegram
      const detail = (await res.text()).slice(0, 160);
      console.error('Telegram API error', res.status, detail);
      lastTelegramError = `HTTP ${res.status} ${detail}`;
      return false;
    }
    lastTelegramError = '';
    return true;
  } catch (e) {
    console.error('Telegram fetch failed', e instanceof Error ? e.message : 'unknown');
    lastTelegramError = `เชื่อมต่อ Telegram ไม่ได้: ${e instanceof Error ? e.message : 'unknown'}`;
    return false;
  }
}

// ส่งทั้ง LINE และ Telegram พร้อมกัน สำเร็จอย่างใดอย่างหนึ่งก็ถือว่าสำเร็จ
async function notify(line: Promise<boolean>, text: string): Promise<boolean> {
  const [a, b] = await Promise.all([line, telegramSend(text)]);
  return a || b;
}

async function call(path: string, body: unknown): Promise<boolean> {
  const token = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') ?? '';
  if (!token) {
    console.error('LINE_CHANNEL_ACCESS_TOKEN is not set');
    lastLineError = 'ไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN';
    return false;
  }
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 160);
      console.error('LINE API error', path, res.status, detail);
      lastLineError = `HTTP ${res.status} ${detail}`;
      return false;
    }
    lastLineError = '';
    return true;
  } catch (e) {
    console.error('LINE API fetch failed', path, e);
    lastLineError = `เชื่อมต่อ LINE ไม่ได้: ${e instanceof Error ? e.message : String(e)}`;
    return false;
  }
}

// push ไปยังกลุ่ม: LINE นับโควตาตามจำนวนสมาชิกที่ได้รับ
export const pushTo = (to: string, text: string) =>
  notify(call('/message/push', { to, messages: [{ type: 'text', text: clip(text) }] }), text);

export const multicast = (to: string[], text: string) =>
  to.length
    ? notify(call('/message/multicast', { to, messages: [{ type: 'text', text: clip(text) }] }), text)
    : Promise.resolve(false);

// reply ไม่นับโควตาข้อความ
export const replyText = (replyToken: string, text: string) =>
  call('/message/reply', { replyToken, messages: [{ type: 'text', text: clip(text) }] });

export async function getGroupId(): Promise<string | null> {
  const { data } = await sb.from('settings').select('value').eq('key', 'line_group_id').maybeSingle();
  return data?.value ?? Deno.env.get('LINE_GROUP_ID') ?? null;
}

export async function setGroupId(id: string): Promise<void> {
  const { error } = await sb
    .from('settings')
    .upsert({ key: 'line_group_id', value: id, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function memberName(source: { type: string; groupId?: string; roomId?: string; userId?: string }): Promise<string> {
  const token = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') ?? '';
  if (!token || !source.userId) return 'ไม่ทราบชื่อ';
  const path =
    source.type === 'group' && source.groupId
      ? `/group/${source.groupId}/member/${source.userId}`
      : source.type === 'room' && source.roomId
      ? `/room/${source.roomId}/member/${source.userId}`
      : `/profile/${source.userId}`;
  try {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return 'ไม่ทราบชื่อ';
    const j = await res.json();
    return String(j.displayName ?? 'ไม่ทราบชื่อ');
  } catch {
    return 'ไม่ทราบชื่อ';
  }
}

// ตรวจลายเซ็น x-line-signature (HMAC-SHA256 ของ body ด้วย channel secret)
export async function verifySignature(body: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  let bin = '';
  for (const b of mac) bin += String.fromCharCode(b);
  return safeEqual(btoa(bin), signature);
}
