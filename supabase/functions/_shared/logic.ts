// ตรรกะล้วน ๆ (ไม่แตะฐานข้อมูล/เครือข่าย) เพื่อให้ทดสอบได้ง่าย

export type Status = 'unknown' | 'ok' | 'offline' | 'temp_high' | 'temp_low';
export type AlertKind = 'offline' | 'temp_high' | 'temp_low' | 'recovery';

export interface DeviceRow {
  id: string;
  name: string;
  min_temp: number;
  max_temp: number;
  offline_after_min: number;
  temp_alert_after_min: number;
  last_seen: string | null;
  last_temp: number | null;
  status: Status;
  status_since: string;
  board_id?: string | null; // โพรบที่อยู่บอร์ดเดียวกันใช้ board_id เดียวกัน (รวมแจ้งเตือนเป็นข้อความเดียว)
  critical_high?: number | null; // เกินค่านี้ = วิกฤต แจ้งทันทีด้วยค่าเดียว
  critical_low?: number | null; // ต่ำกว่าค่านี้ = วิกฤต แจ้งทันทีด้วยค่าเดียว
  twin_of?: string | null; // id ของโพรบที่วัดช่องเดียวกัน (ใช้เทียบหาโพรบเพี้ยน)
}

export const STATUS_LABEL: Record<Status, string> = {
  unknown: 'ยังไม่มีข้อมูล',
  ok: 'ปกติ',
  offline: 'ขาดสัญญาณ (อาจไฟดับ)',
  temp_high: 'อุณหภูมิสูงเกิน',
  temp_low: 'อุณหภูมิต่ำเกิน',
};

export const EXPIRY_THRESHOLDS = [90, 60, 30, 14, 7, 0];

/**
 * ตัดสินสถานะของตู้
 * - ไม่มีสัญญาณเกิน offline_after_min => offline
 * - ค่าที่วัดได้ในช่วง temp_alert_after_min ทุกค่าอยู่นอกช่วง (อย่างน้อย 2 ค่า) => temp_high / temp_low
 *   (ถ้าเพิ่งกลับมาจาก offline ใช้ 1 ค่าก็พอ เพื่อไม่ประกาศ "ปกติ" ทั้งที่ตู้ร้อนอยู่)
 * - ถ้าค่าในช่วงตรวจไม่พอตัดสิน (เช่น ข้อมูลหาย 1 รอบ) และตู้ผิดปกติอยู่/เพิ่งกลับจาก offline
 *   จะ "ไม่" ประกาศกลับสู่ปกติจนกว่าค่าล่าสุด (last_temp) จะอยู่ในช่วงจริง
 */
export function isCriticalHigh(d: DeviceRow, t: number): boolean {
  return d.critical_high !== null && d.critical_high !== undefined && Number.isFinite(t) && t > Number(d.critical_high);
}
export function isCriticalLow(d: DeviceRow, t: number): boolean {
  return d.critical_low !== null && d.critical_low !== undefined && Number.isFinite(t) && t < Number(d.critical_low);
}

export function decideStatus(d: DeviceRow, recentTemps: number[], nowMs: number): Status {
  if (!d.last_seen) return 'unknown';
  const silentMin = (nowMs - Date.parse(d.last_seen)) / 60000;
  if (silentMin > d.offline_after_min) return 'offline';
  // เกณฑ์วิกฤต: ค่าล่าสุดเกินเกณฑ์ แจ้งทันที ไม่ต้องรอหลายค่า
  const cur = d.last_temp === null || d.last_temp === undefined ? NaN : Number(d.last_temp);
  if (isCriticalHigh(d, cur)) return 'temp_high';
  if (isCriticalLow(d, cur)) return 'temp_low';
  const need = d.status === 'offline' ? 1 : 2;
  if (recentTemps.length >= need) {
    if (recentTemps.every((t) => t > d.max_temp)) return 'temp_high';
    if (recentTemps.every((t) => t < d.min_temp)) return 'temp_low';
  }
  // ตู้กำลังผิดปกติ (หรือเพิ่งกลับจาก offline): ต้องเห็นค่าล่าสุดอยู่ในช่วงก่อนจึงถือว่าปกติ
  if (d.status === 'temp_high' || d.status === 'temp_low' || d.status === 'offline') {
    const last = d.last_temp === null || d.last_temp === undefined ? NaN : Number(d.last_temp);
    if (last > d.max_temp) return 'temp_high';
    if (last < d.min_temp) return 'temp_low';
  }
  return 'ok';
}

export function fmtTime(v: string | number | Date): string {
  return new Date(v).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function fmtDuration(min: number): string {
  if (min < 60) return `${min} นาที`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
}

const tempText = (t: number | null) => (t === null || t === undefined ? '-' : `${Number(t).toFixed(1)}°C`);

export interface AlertDraft {
  kind: AlertKind;
  message: string;
}

/** สร้างข้อความแจ้งเตือนเมื่อสถานะเปลี่ยน (คืน null ถ้าไม่ต้องแจ้ง) */
export function buildTransition(prev: Status, next: Status, d: DeviceRow, nowMs: number): AlertDraft | null {
  if (prev === next || next === 'unknown') return null;
  if (prev === 'unknown' && next === 'ok') return null;

  if (next === 'ok') {
    const dur = fmtDuration(Math.max(0, Math.round((nowMs - Date.parse(d.status_since)) / 60000)));
    const why = prev === 'offline' ? 'ขาดสัญญาณ' : 'อุณหภูมิผิดปกติ';
    const lines = [
      `✅ ${d.name} กลับสู่ปกติแล้ว (${tempText(d.last_temp)})`,
      `${why}ตั้งแต่ ${fmtTime(d.status_since)} รวมประมาณ ${dur}`,
      prev === 'offline'
        ? '⚠️ ช่วงขาดสัญญาณไม่มีข้อมูลอุณหภูมิ ควรตรวจสอบสภาพวัคซีนตามแนวปฏิบัติของหน่วยงานก่อนใช้ต่อ'
        : `⚠️ อุณหภูมิเคยอยู่นอกช่วง ${d.min_temp}–${d.max_temp}°C ควรตรวจสอบสภาพวัคซีนตามแนวปฏิบัติของหน่วยงานก่อนใช้ต่อ`,
    ];
    return { kind: 'recovery', message: lines.join('\n') };
  }

  if (next === 'offline') {
    const lines = [
      `🔴 ${d.name} ขาดสัญญาณ (อาจไฟดับหรืออินเทอร์เน็ตหลุด)`,
      `ไม่ได้รับข้อมูลตั้งแต่ ${d.last_seen ? fmtTime(d.last_seen) : '-'} (เกิน ${d.offline_after_min} นาที)`,
      `อุณหภูมิล่าสุดที่วัดได้: ${tempText(d.last_temp)}`,
      ...(d.board_id ? ['(โพรบอื่นของตู้เดียวกันมักขาดสัญญาณพร้อมกัน จึงแจ้งข้อความเดียว)'] : []),
      '👉 ตรวจที่หน้างานทันที ถ้าไฟดับให้ปฏิบัติตามขั้นตอนของหน่วยงาน (เช่น ไม่เปิดตู้โดยไม่จำเป็น เตรียมกระติกวัคซีน)',
      'พิมพ์ "รับทราบ" ในกลุ่มนี้เพื่อยืนยันว่ากำลังดำเนินการ',
    ];
    return { kind: 'offline', message: lines.join('\n') };
  }

  const high = next === 'temp_high';
  const lines = [
    ...(prev === 'offline' ? ['ตู้กลับมาส่งสัญญาณหลังขาดช่วง (ไฟอาจดับ) และพบว่า'] : []),
    `🌡️ ${d.name} อุณหภูมิ${high ? 'สูง' : 'ต่ำ'}เกินช่วง ${d.min_temp}–${d.max_temp}°C`,
    `ล่าสุด ${tempText(d.last_temp)} (${
      (high ? isCriticalHigh(d, Number(d.last_temp)) : isCriticalLow(d, Number(d.last_temp)))
        ? `🚨 เกินเกณฑ์วิกฤต ${high ? d.critical_high : d.critical_low}°C`
        : 'วัดได้นอกช่วงติดต่อกันหลายครั้ง'
    })`,
    high
      ? '👉 ตรวจตู้เย็น/ประตูตู้ และปฏิบัติตามขั้นตอนของหน่วยงานทันที'
      : '👉 เสี่ยงวัคซีนบางชนิดเสียหายจากการแข็งตัว ตรวจตู้และปฏิบัติตามขั้นตอนของหน่วยงานทันที',
    'พิมพ์ "รับทราบ" ในกลุ่มนี้เพื่อยืนยันว่ากำลังดำเนินการ',
  ];
  return { kind: high ? 'temp_high' : 'temp_low', message: lines.join('\n') };
}

// ---------- เตือนซ้ำจนกว่าจะกลับปกติ ----------

export interface ReminderState {
  acked_at: string | null;
  acked_by?: string | null;
  escalated_at: string | null;
  reminded_at: string | null;
  reminder_count: number;
}
export interface ReminderConfig {
  unackedMin: number; // ยังไม่มีผู้รับทราบ: เตือนซ้ำทุกกี่นาที (นับต่อจากแจ้งซ้ำครั้งแรก)
  ackedMin: number; // รับทราบแล้วแต่ยังไม่กลับปกติ: ติดตามผลทุกกี่นาที
  max: number; // เตือนซ้ำได้ไม่เกินกี่ครั้งต่อเรื่อง (กันโควตา LINE หมด)
}

/** ถึงเวลาเตือนซ้ำหรือยัง: 'unacked' | 'acked' | null */
export function reminderDue(a: ReminderState, nowMs: number, cfg: ReminderConfig): 'unacked' | 'acked' | null {
  if (a.reminder_count >= cfg.max) return null;
  const since = (iso: string) => (nowMs - Date.parse(iso)) / 60000;
  if (!a.acked_at) {
    if (!a.escalated_at) return null; // ยังไม่ถึงรอบแจ้งซ้ำครั้งแรก
    return since(a.reminded_at ?? a.escalated_at) >= cfg.unackedMin ? 'unacked' : null;
  }
  return since(a.reminded_at ?? a.acked_at) >= cfg.ackedMin ? 'acked' : null;
}

export function buildReminder(mode: 'unacked' | 'acked', d: DeviceRow, a: ReminderState, nowMs: number): string {
  const dur = fmtDuration(Math.max(0, Math.round((nowMs - Date.parse(d.status_since)) / 60000)));
  const n = a.reminder_count + 1;
  const head = `🔔 ${mode === 'unacked' ? 'เตือนซ้ำ' : 'ติดตามผล'} (ครั้งที่ ${n}) ${d.name} ยัง${STATUS_LABEL[d.status]} มาแล้วประมาณ ${dur}`;
  const lines = [head, `ล่าสุด ${tempText(d.last_temp)} (ตั้งแต่ ${fmtTime(d.status_since)})`];
  if (mode === 'unacked') {
    lines.push('ยังไม่มีผู้รับทราบ ตรวจที่หน้างานและพิมพ์ "รับทราบ" ในกลุ่ม');
  } else {
    lines.push(`รับทราบแล้วโดย ${a.acked_by ?? '-'} แต่ตู้ยังไม่กลับสู่ปกติ ถ้าแก้ไขแล้วระบบจะแจ้งเมื่อกลับสู่ปกติ`);
  }
  return lines.join('\n');
}

// ---------- โพรบ 2 ตัวในช่องเดียวกันอ่านต่างกัน ----------

export function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** ค่าเฉลี่ยของโพรบสองตัวต่างกันเกิน limit (°C) หรือไม่ ต้องมีข้อมูลอย่างน้อย minN ค่าต่อตัว */
export function probesDisagree(a: number[], b: number[], limit = 2, minN = 4): { disagree: boolean; diff: number } {
  if (a.length < minN || b.length < minN) return { disagree: false, diff: 0 };
  const diff = mean(a) - mean(b);
  return { disagree: Math.abs(diff) > limit, diff };
}

export function buildProbeDiffMessage(nameA: string, nameB: string, meanA: number, meanB: number, limit: number): string {
  return [
    `⚠️ โพรบในช่องเดียวกันอ่านค่าต่างกันเกิน ${limit}°C`,
    `${nameA}: ${meanA.toFixed(1)}°C เทียบกับ ${nameB}: ${meanB.toFixed(1)}°C (เฉลี่ย 30 นาทีล่าสุด)`,
    '👉 โพรบตัวใดตัวหนึ่งอาจเพี้ยน ตรวจตำแหน่งวางโพรบและเทียบกับเทอร์โมมิเตอร์มาตรฐาน',
  ].join('\n');
}

// ---------- วันหมดอายุวัคซีน ----------

export function bangkokHour(nowMs: number): number {
  return new Date(nowMs + 7 * 3600 * 1000).getUTCHours();
}

/** จำนวนวันจากวันนี้ (ตามเวลาไทย) ถึงวันหมดอายุ YYYY-MM-DD; ติดลบ = หมดอายุแล้ว */
export function daysUntil(expiryDate: string, nowMs: number): number {
  const today = new Date(nowMs + 7 * 3600 * 1000).toISOString().slice(0, 10);
  return Math.round((Date.parse(`${expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

/** เกณฑ์ที่ถึงแล้วแต่ยังไม่เคยแจ้ง */
export function dueThresholds(daysLeft: number, notified: number[]): number[] {
  return EXPIRY_THRESHOLDS.filter((t) => daysLeft <= t && !notified.includes(t));
}

export interface ExpiryItem {
  vaccine_name: string;
  lot_no: string;
  qty: number;
  expiry_date: string;
  days: number;
}

export function buildExpiryMessage(items: ExpiryItem[]): string {
  const sorted = [...items].sort((a, b) => a.days - b.days);
  const MAX = 15;
  const line = (i: ExpiryItem) => {
    const when = i.days < 0 ? `หมดอายุแล้ว ${-i.days} วัน` : i.days === 0 ? 'หมดอายุวันนี้' : `อีก ${i.days} วัน`;
    const date = new Date(`${i.expiry_date}T00:00:00Z`).toLocaleDateString('th-TH', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    return `• ${i.vaccine_name} Lot ${i.lot_no} (${i.qty} ขวด/โดส) หมดอายุ ${date} — ${when}`;
  };
  const shown = sorted.slice(0, MAX).map(line);
  if (sorted.length > MAX) shown.push(`…และอีก ${sorted.length - MAX} รายการ`);
  return ['📅 วัคซีนใกล้หมดอายุ/หมดอายุ', ...shown, 'ตรวจสอบในหน้าทะเบียนวัคซีนของแดชบอร์ด'].join('\n');
}
