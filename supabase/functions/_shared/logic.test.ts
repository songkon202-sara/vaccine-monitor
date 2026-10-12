// ทดสอบตรรกะ: deno run logic.test.ts   หรือ   npx tsx logic.test.ts
import assert from 'node:assert/strict';
import {
  buildExpiryMessage,
  buildTransition,
  daysUntil,
  decideStatus,
  dueThresholds,
  type DeviceRow,
} from './logic.ts';

const NOW = Date.parse('2026-10-12T07:30:00Z'); // 14:30 เวลาไทย
const min = (m: number) => new Date(NOW - m * 60000).toISOString();

const dev = (over: Partial<DeviceRow> = {}): DeviceRow => ({
  id: 'fridge-1',
  name: 'ตู้เย็นวัคซีน 1',
  min_temp: 2,
  max_temp: 8,
  offline_after_min: 15,
  temp_alert_after_min: 10,
  last_seen: min(1),
  last_temp: 5,
  status: 'ok',
  status_since: min(120),
  ...over,
});

// ---- decideStatus ----
assert.equal(decideStatus(dev({ last_seen: null, status: 'unknown' }), [], NOW), 'unknown');
assert.equal(decideStatus(dev(), [4.5, 5, 5.2], NOW), 'ok');
assert.equal(decideStatus(dev({ last_seen: min(14) }), [], NOW), 'ok', 'ยังไม่เกินเกณฑ์ขาดสัญญาณ');
assert.equal(decideStatus(dev({ last_seen: min(16) }), [], NOW), 'offline');
assert.equal(decideStatus(dev(), [9, 9.5], NOW), 'temp_high');
assert.equal(decideStatus(dev(), [1.2, 0.8], NOW), 'temp_low');
assert.equal(decideStatus(dev(), [9], NOW), 'ok', 'ค่าเดียวนอกช่วงยังไม่แจ้ง (กันเปิดตู้ชั่วคราว)');
assert.equal(decideStatus(dev(), [9, 5], NOW), 'ok', 'มีค่าปกติปนอยู่ ถือว่ากลับมาแล้ว');
assert.equal(decideStatus(dev({ status: 'temp_high' }), [9, 5], NOW), 'ok');
assert.equal(decideStatus(dev({ status: 'offline' }), [9.5], NOW), 'temp_high', 'เพิ่งกลับจาก offline ใช้ 1 ค่าพอ');
assert.equal(decideStatus(dev({ status: 'offline' }), [5], NOW), 'ok');
assert.equal(decideStatus(dev({ status: 'offline' }), [], NOW), 'ok', 'สัญญาณกลับมาแต่ยังไม่มีค่าในหน้าต่าง');
assert.equal(decideStatus(dev(), [8], NOW), 'ok', 'ขอบ 8.0 ยังอยู่ในช่วง');
assert.equal(decideStatus(dev(), [2, 2], NOW), 'ok', 'ขอบ 2.0 ยังอยู่ในช่วง');

// ---- buildTransition ----
assert.equal(buildTransition('unknown', 'ok', dev(), NOW), null);
assert.equal(buildTransition('ok', 'ok', dev(), NOW), null);
assert.equal(buildTransition('ok', 'unknown', dev(), NOW), null);

const off = buildTransition('ok', 'offline', dev({ last_seen: min(20), last_temp: 4.6 }), NOW)!;
assert.equal(off.kind, 'offline');
assert.ok(off.message.includes('ตู้เย็นวัคซีน 1'));
assert.ok(off.message.includes('4.6°C'));
assert.ok(off.message.includes('รับทราบ'));

const hi = buildTransition('ok', 'temp_high', dev({ last_temp: 9.4 }), NOW)!;
assert.equal(hi.kind, 'temp_high');
assert.ok(hi.message.includes('สูง') && hi.message.includes('9.4°C'));

const lo = buildTransition('ok', 'temp_low', dev({ last_temp: 0.5 }), NOW)!;
assert.equal(lo.kind, 'temp_low');
assert.ok(lo.message.includes('แข็งตัว'));

const hiAfterOff = buildTransition('offline', 'temp_high', dev({ last_temp: 12 }), NOW)!;
assert.equal(hiAfterOff.kind, 'temp_high');
assert.ok(hiAfterOff.message.includes('กลับมาส่งสัญญาณ'));

const rec = buildTransition('offline', 'ok', dev({ status: 'offline', status_since: min(95), last_temp: 6 }), NOW)!;
assert.equal(rec.kind, 'recovery');
assert.ok(rec.message.includes('1 ชม. 35 นาที'), rec.message);
assert.ok(rec.message.includes('ไม่มีข้อมูลอุณหภูมิ'));

const rec2 = buildTransition('temp_high', 'ok', dev({ status: 'temp_high', status_since: min(30) }), NOW)!;
assert.equal(rec2.kind, 'recovery');
assert.ok(rec2.message.includes('2–8°C'));

// ---- วันหมดอายุ ----
assert.equal(daysUntil('2026-10-12', NOW), 0);
assert.equal(daysUntil('2026-11-11', NOW), 30);
assert.equal(daysUntil('2026-10-01', NOW), -11);
// 23:30 เวลาไทย = 16:30 UTC ยังเป็นวันเดียวกันในไทย
assert.equal(daysUntil('2026-10-13', Date.parse('2026-10-12T16:30:00Z')), 1);
// 00:30 เวลาไทยของวันถัดไป = 17:30 UTC วันก่อนหน้า
assert.equal(daysUntil('2026-10-13', Date.parse('2026-10-12T17:30:00Z')), 0);

assert.deepEqual(dueThresholds(100, []), []);
assert.deepEqual(dueThresholds(85, []), [90]);
assert.deepEqual(dueThresholds(20, []), [90, 60, 30]);
assert.deepEqual(dueThresholds(20, [90, 60, 30]), []);
assert.deepEqual(dueThresholds(59, [90]), [60]);
assert.deepEqual(dueThresholds(-3, [90, 60, 30, 14, 7]), [0]);

const msg = buildExpiryMessage([
  { vaccine_name: 'MMR', lot_no: 'A1', qty: 10, expiry_date: '2026-11-11', days: 30 },
  { vaccine_name: 'BCG', lot_no: 'B2', qty: 5, expiry_date: '2026-10-05', days: -7 },
]);
assert.ok(msg.indexOf('BCG') < msg.indexOf('MMR'), 'เรียงตามที่ใกล้หมดอายุก่อน');
assert.ok(msg.includes('หมดอายุแล้ว 7 วัน') && msg.includes('อีก 30 วัน'));
assert.ok(msg.includes('2569'), 'แสดงปี พ.ศ.');

console.log('logic tests passed');
