import { admin as sb, json } from '../_shared/supabase.ts';
import { getGroupId, multicast, pushTo } from '../_shared/line.ts';
import {
  bangkokHour,
  buildExpiryMessage,
  buildTransition,
  type DeviceRow,
  daysUntil,
  decideStatus,
  dueThresholds,
  type ExpiryItem,
  type Status,
} from '../_shared/logic.ts';

// ถูกเรียกทุกนาทีโดย pg_cron (ดู supabase/cron.sql)
//  1) ตรวจสถานะตู้ -> สร้างแจ้งเตือนเมื่อสถานะเปลี่ยน
//  2) ส่งแจ้งเตือนที่ค้างส่งเข้า LINE (ลองใหม่เองถ้าส่งไม่สำเร็จ)
//  3) แจ้งซ้ำไปยังผู้รับผิดชอบเมื่อไม่มีใครรับทราบ
//  4) แจ้งเตือนวัคซีนใกล้หมดอายุ (ช่วง 08:00–16:00 เวลาไทย)
//  5) ส่ง heartbeat ไปยัง HEARTBEAT_URL (เช่น healthchecks.io) ถ้าระบบหยุดหรือส่ง LINE ไม่ได้
//     บริการภายนอกจะเตือนทางอีเมล — เป็น "ตัวเฝ้าตัวเฝ้า" กรณีระบบเงียบไปเอง

const COOLDOWN_MIN = Number(Deno.env.get('ALERT_COOLDOWN_MIN') ?? '30');
const ESCALATE_AFTER_MIN = Number(Deno.env.get('ESCALATE_AFTER_MIN') ?? '20');

interface AlertRow {
  id: number;
  device_id: string | null;
  kind: string;
  message: string;
}
interface Stats {
  devices: number;
  transitions: number;
  sent: number;
  escalated: number;
  expiry: number;
  errors: string[];
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'unauthorized' }, 401);

  const stats: Stats = { devices: 0, transitions: 0, sent: 0, escalated: 0, expiry: 0, errors: [] };
  const steps: [string, () => Promise<void>][] = [
    ['devices', () => checkDevices(stats)],
    ['flush', () => flushUnsent(stats)],
    ['escalate', () => escalate(stats)],
    ['expiry', () => checkExpiry(stats)],
  ];
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (e) {
      console.error(name, e);
      stats.errors.push(`${name}: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
    }
  }
  await heartbeat(stats);
  return json(stats);
});

// รายงานผลไปยังบริการเฝ้าระบบภายนอก: มี error (รวมส่ง LINE ไม่สำเร็จ) -> /fail
async function heartbeat(stats: Stats) {
  const url = Deno.env.get('HEARTBEAT_URL');
  if (!url) return;
  try {
    await fetch(stats.errors.length ? `${url.replace(/\/$/, '')}/fail` : url, {
      method: 'POST',
      body: JSON.stringify(stats),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('heartbeat failed', e);
  }
}

async function checkDevices(stats: Stats) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const { data: devices, error } = await sb.from('devices').select('*').eq('active', true);
  if (error) throw error;

  for (const d of (devices ?? []) as DeviceRow[]) {
    stats.devices++;

    let temps: number[] = [];
    if (d.last_seen && (now - Date.parse(d.last_seen)) / 60000 <= d.offline_after_min) {
      const since = new Date(now - d.temp_alert_after_min * 60000).toISOString();
      const { data: rs, error: e2 } = await sb
        .from('readings')
        .select('temp')
        .eq('device_id', d.id)
        .gte('created_at', since);
      if (e2) throw e2;
      temps = (rs ?? []).map((r) => Number(r.temp));
    }

    const next = decideStatus(d, temps, now);
    if (next === d.status) continue;

    // ถ้าขาดสัญญาณ ให้ถือว่าเริ่มตั้งแต่ครั้งสุดท้ายที่เห็นตู้
    const statusSince = next === 'offline' && d.last_seen ? d.last_seen : nowIso;

    // อัปเดตแบบมีเงื่อนไข (status เดิม) กันสองรอบทับกัน
    const { data: upd, error: e3 } = await sb
      .from('devices')
      .update({ status: next, status_since: statusSince })
      .eq('id', d.id)
      .eq('status', d.status)
      .select('id');
    if (e3) throw e3;
    if (!upd || upd.length === 0) continue;
    stats.transitions++;

    const draft = buildTransition(d.status, next, d, now);
    if (!draft) continue;

    if (draft.kind === 'recovery') {
      // กลับสู่ปกติแล้ว ไม่ต้องแจ้งซ้ำเรื่องเก่าที่ยังไม่มีคนรับทราบ
      const { error: e4 } = await sb
        .from('alerts')
        .update({ acked_at: nowIso, acked_by: 'ระบบ (กลับสู่ปกติ)' })
        .eq('device_id', d.id)
        .is('acked_at', null)
        .neq('kind', 'recovery');
      if (e4) throw e4;
    }

    const { error: e5 } = await sb.from('alerts').insert({
      device_id: d.id,
      kind: draft.kind,
      message: draft.message,
      ...(draft.kind === 'recovery' ? { acked_at: nowIso, acked_by: 'ระบบ' } : {}),
    });
    if (e5) throw e5;
  }
}

async function trySend(a: AlertRow, currentStatus: Status): Promise<'sent' | 'wait' | 'obsolete' | 'failed'> {
  const stillRelevant = a.kind === 'recovery' ? currentStatus === 'ok' : currentStatus === a.kind;
  if (!stillRelevant) {
    await sb.from('alerts').update({ push_status: 'obsolete' }).eq('id', a.id);
    return 'obsolete';
  }

  if (a.kind === 'recovery') {
    // "กลับสู่ปกติ" ส่งทันที (ไม่ติด cooldown) แต่เฉพาะเมื่อกลุ่มเคยได้รับแจ้งเรื่องผิดปกติ
    // ที่ยังไม่ได้บอกว่าจบ เพื่อไม่ส่งข้อความกลับสู่ปกติลอย ๆ ของเรื่องที่ไม่เคยถูกแจ้ง
    const { data: lastRec, error: e1 } = await sb
      .from('alerts')
      .select('sent_at')
      .eq('device_id', a.device_id!)
      .eq('kind', 'recovery')
      .eq('push_status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(1);
    if (e1) throw e1;
    let q = sb
      .from('alerts')
      .select('id', { count: 'exact', head: true })
      .eq('device_id', a.device_id!)
      .neq('kind', 'recovery')
      .eq('push_status', 'sent');
    if (lastRec?.[0]?.sent_at) q = q.gt('sent_at', lastRec[0].sent_at);
    const { count, error: e2 } = await q;
    if (e2) throw e2;
    if (!count) {
      await sb.from('alerts').update({ push_status: 'obsolete' }).eq('id', a.id);
      return 'obsolete';
    }
  } else {
    // กันข้อความรัว (เช่น ไฟกระพริบ): แจ้งเตือนชนิดเดียวกันของตู้เดียวกัน ส่งได้ทุก COOLDOWN_MIN นาที
    const since = new Date(Date.now() - COOLDOWN_MIN * 60000).toISOString();
    const { count, error } = await sb
      .from('alerts')
      .select('id', { count: 'exact', head: true })
      .eq('device_id', a.device_id!)
      .eq('kind', a.kind)
      .eq('push_status', 'sent')
      .gte('sent_at', since)
      .neq('id', a.id);
    if (error) throw error;
    if ((count ?? 0) > 0) return 'wait';
  }

  const groupId = await getGroupId();
  if (!groupId) return 'failed';
  const ok = await pushTo(groupId, a.message);
  if (!ok) return 'failed';

  await sb.from('alerts').update({ push_status: 'sent', sent_at: new Date().toISOString() }).eq('id', a.id);
  return 'sent';
}

async function flushUnsent(stats: Stats) {
  const since = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const { data: pending, error } = await sb
    .from('alerts')
    .select('id, device_id, kind, message')
    .is('push_status', null)
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  if (error) throw error;
  if (!pending || pending.length === 0) return;

  const { data: devs, error: e2 } = await sb.from('devices').select('id, status');
  if (e2) throw e2;
  const statusOf = new Map((devs ?? []).map((x) => [x.id as string, x.status as Status]));

  for (const a of pending as AlertRow[]) {
    if (!a.device_id) {
      await sb.from('alerts').update({ push_status: 'obsolete' }).eq('id', a.id);
      continue;
    }
    const r = await trySend(a, statusOf.get(a.device_id) ?? 'unknown');
    if (r === 'sent') stats.sent++;
    if (r === 'failed') stats.errors.push(`flush: ส่ง LINE ไม่สำเร็จ (alert ${a.id})`);
  }
}

async function escalate(stats: Stats) {
  const before = new Date(Date.now() - ESCALATE_AFTER_MIN * 60000).toISOString();
  const { data, error } = await sb
    .from('alerts')
    .select('id, message')
    .is('acked_at', null)
    .is('escalated_at', null)
    .eq('push_status', 'sent')
    .neq('kind', 'recovery')
    .lte('sent_at', before);
  if (error) throw error;
  if (!data || data.length === 0) return;

  const userIds = (Deno.env.get('ESCALATION_USER_IDS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const groupId = await getGroupId();

  for (const a of data) {
    const text = `⚠️ ยังไม่มีผู้รับทราบเรื่องนี้ (เกิน ${ESCALATE_AFTER_MIN} นาที)\n\n${a.message}`;
    // ถ้าตั้งผู้รับผิดชอบรายบุคคลไว้ ส่งเฉพาะคนเหล่านั้น (ประหยัดโควตา) ไม่เช่นนั้นส่งซ้ำเข้ากลุ่ม
    const ok = userIds.length > 0 ? await multicast(userIds, text) : groupId ? await pushTo(groupId, text) : false;
    if (ok) {
      await sb.from('alerts').update({ escalated_at: new Date().toISOString() }).eq('id', a.id);
      stats.escalated++;
    } else {
      stats.errors.push(`escalate: ส่ง LINE ไม่สำเร็จ (alert ${a.id})`);
    }
  }
}

async function checkExpiry(stats: Stats) {
  const now = Date.now();
  const h = bangkokHour(now);
  if (h < 8 || h >= 16) return;

  const { data: lots, error } = await sb
    .from('vaccine_lots')
    .select('id, vaccine_name, lot_no, qty, expiry_date, notified_days')
    .eq('active', true)
    .gt('qty', 0);
  if (error) throw error;

  const due: { id: string; item: ExpiryItem; notified: number[]; add: number[] }[] = [];
  for (const l of lots ?? []) {
    const days = daysUntil(l.expiry_date as string, now);
    const notified = (l.notified_days ?? []) as number[];
    const add = dueThresholds(days, notified);
    if (add.length === 0) continue;
    due.push({
      id: l.id as string,
      item: {
        vaccine_name: l.vaccine_name as string,
        lot_no: l.lot_no as string,
        qty: Number(l.qty),
        expiry_date: l.expiry_date as string,
        days,
      },
      notified,
      add,
    });
  }
  if (due.length === 0) return;

  const groupId = await getGroupId();
  if (!groupId || !(await pushTo(groupId, buildExpiryMessage(due.map((x) => x.item))))) {
    stats.errors.push('expiry: ส่ง LINE ไม่สำเร็จ');
    return;
  }

  for (const x of due) {
    await sb
      .from('vaccine_lots')
      .update({ notified_days: [...new Set([...x.notified, ...x.add])] })
      .eq('id', x.id);
  }
  stats.expiry = due.length;
}
