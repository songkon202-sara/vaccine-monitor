// ทดสอบตรรกะ: deno run logic.test.ts   หรือ   npx tsx logic.test.ts
import assert from 'node:assert/strict';
import {
  buildExpiryMessage,
  buildTransition,
  daysUntil,
  decideStatus,
  dueThresholds,
  buildProbeDiffMessage,
  buildReminder,
  probesDisagree,
  reminderDue,
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
// ข้อมูลในช่วงตรวจไม่พอ (เช่น หายไป 1 รอบ) ต้องไม่ประกาศกลับสู่ปกติทั้งที่ค่าล่าสุดยังผิดช่วง
assert.equal(decideStatus(dev({ status: 'temp_high', last_temp: 9.6 }), [], NOW), 'temp_high', 'ไม่มีค่าในหน้าต่าง + ค่าล่าสุดยังสูง');
assert.equal(decideStatus(dev({ status: 'temp_high', last_temp: 9.6 }), [9.6], NOW), 'temp_high', 'ค่าเดียวในหน้าต่างและยังสูง');
assert.equal(decideStatus(dev({ status: 'temp_low', last_temp: 1.1 }), [], NOW), 'temp_low');
assert.equal(decideStatus(dev({ status: 'temp_high', last_temp: 5.0 }), [5.0], NOW), 'ok', 'ค่าล่าสุดกลับเข้าช่วงแล้ว');
assert.equal(decideStatus(dev({ status: 'temp_high', last_temp: 9.4 }), [5.0, 9.4], NOW), 'temp_high', 'ค่าปนกันแต่ล่าสุดยังสูง ไม่ประกาศปกติ');
assert.equal(decideStatus(dev({ status: 'offline', last_temp: 9.9 }), [], NOW), 'temp_high', 'กลับจาก offline ค่าล่าสุดสูง');
assert.equal(decideStatus(dev({ status: 'ok', last_temp: 9.6 }), [9.6], NOW), 'ok', 'ตู้ปกติ ค่าเดียวสูงยังไม่แจ้ง (เปิดตู้ชั่วคราว)');
// ช่องแช่แข็ง -25 ถึง -15
const fz = (over: Partial<DeviceRow> = {}) => dev({ min_temp: -25, max_temp: -15, temp_alert_after_min: 30, ...over });
assert.equal(decideStatus(fz(), [-20, -19, -21], NOW), 'ok');
assert.equal(decideStatus(fz(), [-12, -11], NOW), 'temp_high');
assert.equal(decideStatus(fz({ status: 'temp_high', last_temp: -13 }), [], NOW), 'temp_high');

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

// ---- เกณฑ์วิกฤต (ค่าเดียวก็แจ้ง) ----
const crit = { critical_high: 15, critical_low: 0 };
assert.equal(decideStatus(dev({ ...crit, last_temp: 16 }), [16], NOW), 'temp_high', 'เกินวิกฤตแจ้งทันทีด้วยค่าเดียว');
assert.equal(decideStatus(dev({ ...crit, last_temp: -0.5 }), [-0.5], NOW), 'temp_low');
assert.equal(decideStatus(dev({ ...crit, last_temp: 9 }), [9], NOW), 'ok', 'เกิน 8 แต่ไม่ถึงวิกฤต ยังรอ 2 ค่า');
assert.equal(decideStatus(dev({ last_temp: 40 }), [40], NOW), 'ok', 'ไม่ตั้งเกณฑ์วิกฤต = พฤติกรรมเดิม');
assert.equal(decideStatus(dev({ ...crit, last_temp: 16, last_seen: min(20) }), [], NOW), 'offline', 'ขาดสัญญาณมาก่อน');
const critMsg = buildTransition('ok', 'temp_high', dev({ ...crit, last_temp: 16 }), NOW);
assert.ok(critMsg?.message.includes('วิกฤต 15'), 'ข้อความระบุว่าเกินเกณฑ์วิกฤต');
const normMsg = buildTransition('ok', 'temp_high', dev({ ...crit, last_temp: 9 }), NOW);
assert.ok(!normMsg?.message.includes('วิกฤต'), 'เกิน 8 แต่ไม่วิกฤต ไม่ใส่คำว่าวิกฤต');
const offMsg = buildTransition('ok', 'offline', dev({ board_id: 'board-1', last_seen: min(20) }), NOW);
assert.ok(offMsg?.message.includes('โพรบอื่น'), 'ตู้ที่มีหลายโพรบมีหมายเหตุรวมข้อความ');

// ---- เตือนซ้ำ ----
const cfg = { unackedMin: 30, ackedMin: 120, max: 8 };
const st = (over = {}) => ({ acked_at: null, escalated_at: null, reminded_at: null, reminder_count: 0, ...over });
assert.equal(reminderDue(st(), NOW, cfg), null, 'ยังไม่แจ้งซ้ำครั้งแรก ยังไม่เตือนซ้ำ');
assert.equal(reminderDue(st({ escalated_at: min(29) }), NOW, cfg), null);
assert.equal(reminderDue(st({ escalated_at: min(31) }), NOW, cfg), 'unacked');
assert.equal(reminderDue(st({ escalated_at: min(90), reminded_at: min(10) }), NOW, cfg), null, 'นับจากครั้งล่าสุดที่เตือน');
assert.equal(reminderDue(st({ escalated_at: min(90), reminded_at: min(31) }), NOW, cfg), 'unacked');
assert.equal(reminderDue(st({ acked_at: min(60) }), NOW, cfg), null, 'รับทราบแล้ว รอ 2 ชม.');
assert.equal(reminderDue(st({ acked_at: min(121) }), NOW, cfg), 'acked');
assert.equal(reminderDue(st({ acked_at: min(300), reminded_at: min(30) }), NOW, cfg), null);
assert.equal(reminderDue(st({ escalated_at: min(500), reminder_count: 8 }), NOW, cfg), null, 'ครบจำนวนครั้งสูงสุดแล้ว');
const remMsg = buildReminder('unacked', dev({ status: 'offline', status_since: min(95), last_temp: 6.2 }), st({ reminder_count: 1 }), NOW);
assert.ok(remMsg.includes('ครั้งที่ 2') && remMsg.includes('ยังไม่มีผู้รับทราบ'));
const remMsg2 = buildReminder('acked', dev({ status: 'temp_high', status_since: min(200) }), st({ acked_by: 'สมชาย (LINE)' }), NOW);
assert.ok(remMsg2.includes('สมชาย') && remMsg2.includes('ติดตามผล'));

// ---- โพรบ 2 ตัวอ่านต่างกัน ----
assert.equal(probesDisagree([5, 5.1, 5, 5.2], [5.5, 5.4, 5.6, 5.5]).disagree, false, 'ต่างกันน้อยกว่า 2');
const pd = probesDisagree([5, 5.1, 5, 5.2], [8, 8.1, 8.2, 8], 2);
assert.equal(pd.disagree, true);
assert.ok(pd.diff < 0, 'A ต่ำกว่า B');
assert.equal(probesDisagree([5, 5], [9, 9]).disagree, false, 'ข้อมูลไม่พอ (น้อยกว่า 4 ค่า) ไม่ตัดสิน');
assert.ok(buildProbeDiffMessage('ตู้ 1 ช่องเย็น', 'ตู้ 1 ช่องเย็น (โพรบ 2)', 5, 8.4, 2).includes('8.4'));

console.log('logic tests passed');
