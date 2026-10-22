// ทดสอบช่องทางสำรอง Telegram: deno run -A line_telegram.test.ts
import assert from 'node:assert/strict';
Deno.env.set('SUPABASE_URL', 'http://localhost');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'x');
Deno.env.set('LINE_CHANNEL_ACCESS_TOKEN', 'lt');
const calls: string[] = [];
let lineOk = false, tgOk = true;
globalThis.fetch = ((url: string) => {
  const u = String(url);
  calls.push(u.includes('line.me') ? 'line' : u.includes('telegram') ? 'telegram' : u);
  if (u.includes('line.me')) return Promise.resolve(lineOk ? new Response('{}') : new Response('{"message":"quota"}', { status: 429 }));
  return Promise.resolve(tgOk ? new Response('{"ok":true}') : new Response('bad', { status: 400 }));
}) as typeof fetch;
const m = await import('./line.ts');

// ยังไม่ตั้ง Telegram: LINE ล้ม = ล้ม (พฤติกรรมเดิม)
assert.equal(await m.pushTo('G', 'hi'), false);
assert.ok(m.getLastLineError().includes('429'));
assert.equal(m.telegramEnabled(), false);

Deno.env.set('TELEGRAM_BOT_TOKEN', 'tt');
Deno.env.set('TELEGRAM_CHAT_ID', '-100123');
assert.equal(m.telegramEnabled(), true);
calls.length = 0;
assert.equal(await m.pushTo('G', 'hi'), true, 'LINE ล้มแต่ Telegram สำเร็จ = สำเร็จ');
assert.deepEqual(calls.sort(), ['line', 'telegram']);
assert.equal(await m.multicast(['U1', 'U2'], 'hi'), true);
assert.equal(await m.multicast([], 'hi'), false, 'ไม่มีผู้รับ LINE = ไม่ส่ง (พฤติกรรมเดิม)');

tgOk = false;
assert.equal(await m.pushTo('G', 'hi'), false, 'ทั้งสองล้ม = ล้ม');
assert.ok(m.getLastTelegramError().includes('400'));
lineOk = true;
assert.equal(await m.pushTo('G', 'hi'), true, 'LINE ได้ Telegram ล้ม = สำเร็จ');
assert.equal(m.getLastLineError(), '', 'LINE สำเร็จ ล้างสาเหตุเดิม');
assert.ok(!m.getLastTelegramError().includes('tt'), 'ข้อความ error ไม่มี token');
console.log('telegram fallback tests passed');
