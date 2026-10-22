import { admin as sb } from '../_shared/supabase.ts';
import { getGroupId, memberName, replyText, setGroupId, verifySignature } from '../_shared/line.ts';
import { fmtTime, STATUS_LABEL, type Status } from '../_shared/logic.ts';

// Webhook ของ LINE Official Account
// คำสั่งที่รองรับ (พิมพ์ในกลุ่ม):
//   ตั้งกลุ่มนี้ <รหัส>   ตั้งกลุ่มนี้เป็นกลุ่มรับแจ้งเตือน (ต้องใส่รหัส SETUP_PASSCODE)
//   รับทราบ               ยืนยันว่ากำลังจัดการแจ้งเตือนที่ค้างอยู่
//   สถานะ                 ดูสถานะตู้เย็นทั้งหมดตอนนี้
//   /myid                 ดู LINE userId ของตัวเอง (ใช้ตั้งผู้รับแจ้งซ้ำ ESCALATION_USER_IDS)
//   ช่วยเหลือ             แสดงคำสั่ง
// การตอบกลับใช้ reply message จึงไม่นับโควตาข้อความ

interface LineSource {
  type: string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}
interface LineEvent {
  type: string;
  replyToken?: string;
  source?: LineSource;
  message?: { type: string; text?: string };
}

const HELP = [
  'คำสั่งที่ใช้ได้',
  '• สถานะ — ดูสถานะตู้เย็นตอนนี้',
  '• รับทราบ — ยืนยันว่ากำลังจัดการแจ้งเตือนที่ค้างอยู่ (ทุกตู้)',
  '• รับทราบ ตู้ 1 — รับทราบเฉพาะตู้ 1 (ตู้ 2 ก็เช่นกัน)',
  '• /myid — ดู LINE userId ของคุณ',
  '• ตั้งกลุ่มนี้ <รหัส> — ตั้งกลุ่มนี้เป็นกลุ่มรับแจ้งเตือน (ผู้ดูแลระบบ)',
].join('\n');

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');

  const body = await req.text();
  const secret = Deno.env.get('LINE_CHANNEL_SECRET') ?? '';
  if (!(await verifySignature(body, req.headers.get('x-line-signature'), secret))) {
    return new Response('invalid signature', { status: 401 });
  }

  let payload: { events?: LineEvent[] };
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('bad request', { status: 400 });
  }

  for (const ev of payload.events ?? []) {
    try {
      await handle(ev);
    } catch (e) {
      console.error('event error', e);
    }
  }
  return new Response('ok');
});

async function handle(ev: LineEvent) {
  const token = ev.replyToken;
  const src = ev.source;
  if (!token || !src) return;

  if (ev.type === 'join') {
    await replyText(token, 'สวัสดีค่ะ ระบบเฝ้าระวังตู้เย็นวัคซีน\nผู้ดูแลระบบพิมพ์ "ตั้งกลุ่มนี้ <รหัส>" เพื่อให้กลุ่มนี้รับแจ้งเตือน\nพิมพ์ "ช่วยเหลือ" เพื่อดูคำสั่งทั้งหมด');
    return;
  }
  if (ev.type !== 'message' || ev.message?.type !== 'text') return;

  const text = (ev.message.text ?? '').trim();
  const lower = text.toLowerCase();
  const inGroup = src.type === 'group' || src.type === 'room';
  const chatId = src.groupId ?? src.roomId ?? '';

  if (lower === '/myid' || text === 'ไอดีฉัน') {
    await replyText(token, src.userId ? `LINE userId ของคุณ:\n${src.userId}` : 'ไม่พบ userId (ต้องเป็นผู้ที่เพิ่มบอทเป็นเพื่อนแล้ว)');
    return;
  }

  if (lower === 'help' || text === 'ช่วยเหลือ') {
    await replyText(token, HELP);
    return;
  }

  if (text.startsWith('ตั้งกลุ่มนี้')) {
    if (!inGroup) {
      await replyText(token, 'คำสั่งนี้ใช้ในกลุ่มเท่านั้น');
      return;
    }
    const passcode = Deno.env.get('SETUP_PASSCODE') ?? '';
    const given = text.slice('ตั้งกลุ่มนี้'.length).trim();
    if (!passcode || given !== passcode) {
      await replyText(token, 'รหัสไม่ถูกต้อง');
      return;
    }
    await setGroupId(chatId);
    await replyText(token, '✅ ตั้งกลุ่มนี้เป็นกลุ่มรับแจ้งเตือนแล้ว\nแนะนำให้ลบข้อความที่มีรหัสออกจากกลุ่ม');
    return;
  }

  // คำสั่งที่เหลือใช้ได้เฉพาะในกลุ่มรับแจ้งเตือนที่ตั้งไว้
  const isText = (word: string) => text.startsWith(word) || lower === 'ack';
  const wantsAck = isText('รับทราบ');
  const wantsStatus = text.startsWith('สถานะ');
  if (!wantsAck && !wantsStatus) return;

  const groupId = await getGroupId();
  if (!inGroup || !groupId || chatId !== groupId) return;

  if (wantsStatus) {
    const { data, error } = await sb
      .from('devices')
      .select('name, status, last_temp, last_seen')
      .eq('active', true)
      .order('id');
    if (error) throw error;
    const lines = (data ?? []).map((d) => {
      const ok = d.status === 'ok';
      const t = d.last_temp === null ? '-' : `${Number(d.last_temp).toFixed(1)}°C`;
      const seen = d.last_seen ? fmtTime(d.last_seen) : '-';
      return `${ok ? '🟢' : d.status === 'unknown' ? '⚪' : '🔴'} ${d.name}: ${STATUS_LABEL[d.status as Status] ?? d.status} (${t}, ล่าสุด ${seen})`;
    });
    await replyText(token, lines.length ? lines.join('\n') : 'ยังไม่มีตู้เย็นในระบบ');
    return;
  }

  // "รับทราบ ตู้ 1" = เฉพาะตู้ 1 (device id คือ fridge-1 และ fridge-1-...) ถ้าไม่ระบุตู้ = ทุกตู้เหมือนเดิม
  const m = text.match(/ตู้\s*(\d+)/);
  let onlyIds: string[] | null = null;
  if (m) {
    const n = m[1];
    const { data: ds, error: e0 } = await sb.from('devices').select('id');
    if (e0) throw e0;
    onlyIds = (ds ?? []).map((x) => x.id as string).filter((id) => id === `fridge-${n}` || id.startsWith(`fridge-${n}-`));
    if (onlyIds.length === 0) {
      await replyText(token, `ไม่พบตู้ ${n} ในระบบ จึงยังไม่ได้บันทึกการรับทราบ (พิมพ์ "รับทราบ" เฉยๆ เพื่อรับทราบทุกตู้)`);
      return;
    }
  }

  const name = await memberName(src);
  let q = sb
    .from('alerts')
    .update({ acked_at: new Date().toISOString(), acked_by: `${name} (LINE)` })
    .is('acked_at', null)
    .neq('kind', 'recovery')
    // รับทราบเฉพาะเรื่องที่ส่งเข้ากลุ่มแล้ว เรื่องที่ยังรอคิวส่ง (กันส่งซ้ำ) จะยังถูกส่งและแจ้งซ้ำตามปกติ
    .eq('push_status', 'sent');
  if (onlyIds) q = q.in('device_id', onlyIds);
  const { data, error } = await q.select('id');
  if (error) throw error;
  const scope = m ? ` ของตู้ ${m[1]}` : '';
  await replyText(
    token,
    data && data.length > 0
      ? `✅ บันทึกการรับทราบ ${data.length} รายการ${scope} โดย ${name}`
      : `ไม่มีแจ้งเตือน${scope}ที่รอรับทราบ`,
  );
}
