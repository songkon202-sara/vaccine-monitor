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
 */
export function decideStatus(d: DeviceRow, recentTemps: number[], nowMs: number): Status {
  if (!d.last_seen) return 'unknown';
  const silentMin = (nowMs - Date.parse(d.last_seen)) / 60000;
  if (silentMin > d.offline_after_min) return 'offline';
  const need = d.status === 'offline' ? 1 : 2;
  if (recentTemps.length >= need) {
    if (recentTemps.every((t) => t > d.max_temp)) return 'temp_high';
    if (recentTemps.every((t) => t < d.min_temp)) return 'temp_low';
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
      '👉 ตรวจที่หน้างานทันที ถ้าไฟดับให้ปฏิบัติตามขั้นตอนของหน่วยงาน (เช่น ไม่เปิดตู้โดยไม่จำเป็น เตรียมกระติกวัคซีน)',
      'พิมพ์ "รับทราบ" ในกลุ่มนี้เพื่อยืนยันว่ากำลังดำเนินการ',
    ];
    return { kind: 'offline', message: lines.join('\n') };
  }

  const high = next === 'temp_high';
  const lines = [
    ...(prev === 'offline' ? ['ตู้กลับมาส่งสัญญาณหลังขาดช่วง (ไฟอาจดับ) และพบว่า'] : []),
    `🌡️ ${d.name} อุณหภูมิ${high ? 'สูง' : 'ต่ำ'}เกินช่วง ${d.min_temp}–${d.max_temp}°C`,
    `ล่าสุด ${tempText(d.last_temp)} (วัดได้นอกช่วงติดต่อกันหลายครั้ง)`,
    high
      ? '👉 ตรวจตู้เย็น/ประตูตู้ และปฏิบัติตามขั้นตอนของหน่วยงานทันที'
      : '👉 เสี่ยงวัคซีนบางชนิดเสียหายจากการแข็งตัว ตรวจตู้และปฏิบัติตามขั้นตอนของหน่วยงานทันที',
    'พิมพ์ "รับทราบ" ในกลุ่มนี้เพื่อยืนยันว่ากำลังดำเนินการ',
  ];
  return { kind: high ? 'temp_high' : 'temp_low', message: lines.join('\n') };
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
