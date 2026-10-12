#!/usr/bin/env node
// ทดสอบระบบหลัง deploy: node scripts/smoke-test.mjs [--alert-test]
//   ปกติ: ตรวจว่า Edge Functions ตอบถูกต้อง (ไม่ส่งข้อความเข้า LINE ถ้าทุกอย่างปกติ)
//   --alert-test: ส่งอุณหภูมิสูงปลอมเพื่อดูแจ้งเตือนจริงเข้ากลุ่ม LINE แล้วส่งค่าปกติเพื่อดูข้อความกลับสู่ปกติ
//                 (แจ้งคนในกลุ่มก่อนว่าเป็นการทดสอบ)
//                 ใช้ได้กับ "ตู้ทดสอบ" เท่านั้น (Device ID ขึ้นต้นด้วย test เช่น test-fridge)
//                 เพราะระบบถือว่าอุณหภูมิสูงเมื่อค่าที่วัดได้ในช่วงตรวจ "ทุกค่า" เกินเกณฑ์ ถ้าตู้จริงมีค่าปกติ
//                 ส่งเข้ามาในช่วงเดียวกันจะไม่แจ้งเตือน และข้อมูลทดสอบจะปนกับข้อมูลจริง
//                 ตู้ทดสอบสร้างตามขั้นตอนในคู่มือ (README) โดยตั้ง temp_alert_after_min = 1
// ตัวแปรเสริม: FUNCTIONS_URL (ทดสอบกับเซิร์ฟเวอร์จำลอง), PROJECT_REF, DEVICE_ID, API_KEY,
//              WINDOW_WAIT_MS (เวลารอให้ค่าปกติหลุดช่วงตรวจก่อนส่งค่าสูง ค่าเริ่มต้น 65000)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrompter } from './_prompt.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALERT_TEST = process.argv.includes('--alert-test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readCronSecret() {
  const p = join(ROOT, 'supabase', '.env');
  if (!existsSync(p)) return '';
  const m = readFileSync(p, 'utf8').match(/^CRON_SECRET=(.+)$/m);
  return m ? m[1].trim() : '';
}

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

async function main() {
  const p = createPrompter();
  let base = process.env.FUNCTIONS_URL;
  let deviceId = process.env.DEVICE_ID;
  let apiKey = process.env.API_KEY;
  let cronSecret = readCronSecret();
  try {
    if (!base) {
      const ref = process.env.PROJECT_REF || (await p.need('Project ref ของ Supabase: '));
      base = `https://${ref}.supabase.co/functions/v1`;
    }
    deviceId ||= (await p.ask('Device ID ที่จะทดสอบ [fridge-1]: ')) || 'fridge-1';
    apiKey ||= await p.need(`api_key ของ ${deviceId} (select id, api_key from public.devices; ไม่แสดงตอนพิมพ์): `, { hidden: true });
    if (!cronSecret) cronSecret = await p.need('CRON_SECRET (ไม่แสดงตอนพิมพ์): ', { hidden: true });

    const call = async (name, body, headers = {}, rawBody) => {
      try {
        const r = await fetch(`${base}/${name}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: rawBody ?? JSON.stringify(body ?? {}),
        });
        let json = null;
        try {
          json = await r.json();
        } catch {
          /* ไม่ใช่ JSON */
        }
        return { status: r.status, json };
      } catch (e) {
        return { status: 0, json: { error: String(e.message || e) } };
      }
    };
    const reading = (temp) => call('ingest', { device_id: deviceId, api_key: apiKey, temp });
    const runCheck = () => call('check-alerts', {}, { 'x-cron-secret': cronSecret });

    console.log(`\nทดสอบที่ ${base}\n`);

    // --- ingest ---
    let r = await call('ingest', { device_id: deviceId, api_key: 'wrong-key', temp: 5 });
    check('ingest: api_key ผิดต้องถูกปฏิเสธ (401)', r.status === 401, `ได้ ${r.status}`);

    r = await call('ingest', { device_id: deviceId, api_key: apiKey, temp: 'abc' });
    check('ingest: ค่าอุณหภูมิไม่ใช่ตัวเลขต้องถูกปฏิเสธ (400)', r.status === 400, `ได้ ${r.status}`);

    r = await call('ingest', { device_id: deviceId, api_key: apiKey, temp: -127 });
    check('ingest: ค่า -127 (เซนเซอร์เสีย) ต้องถูกปฏิเสธ (400)', r.status === 400, `ได้ ${r.status}`);

    r = await reading(5.2);
    check('ingest: ส่งค่าปกติ 5.2°C สำเร็จ (200)', r.status === 200 && r.json?.ok === true, `ได้ ${r.status} ${JSON.stringify(r.json)}`);

    // --- check-alerts ---
    r = await call('check-alerts', {}, { 'x-cron-secret': 'wrong-secret' });
    check('check-alerts: secret ผิดต้องถูกปฏิเสธ (401)', r.status === 401, `ได้ ${r.status}`);

    r = await runCheck();
    const okRun = r.status === 200 && r.json && Array.isArray(r.json.errors) && r.json.errors.length === 0;
    check('check-alerts: ทำงานได้โดยไม่มี error', okRun, okRun ? JSON.stringify(r.json) : `ได้ ${r.status} ${JSON.stringify(r.json)}`);

    // --- line-webhook ---
    r = await call('line-webhook', null, { 'x-line-signature': 'invalid' }, '{"events":[]}');
    check('line-webhook: ลายเซ็นไม่ถูกต้องต้องถูกปฏิเสธ (401)', r.status === 401, `ได้ ${r.status}`);

    // --- ทดสอบแจ้งเตือนจริง ---
    if (ALERT_TEST) {
      console.log('\n⚠️  --alert-test จะส่งข้อความจริงเข้ากลุ่ม LINE (อุณหภูมิสูงปลอม แล้วกลับสู่ปกติ)');
      const isTestDevice = deviceId.toLowerCase().startsWith('test');
      if (!isTestDevice) {
        console.log(`ข้ามการทดสอบแจ้งเตือน: "${deviceId}" ไม่ใช่ตู้ทดสอบ (ต้องขึ้นต้นด้วย test เช่น test-fridge)`);
        console.log('สร้างตู้ทดสอบตามหัวข้อ "ทดสอบก่อนใช้งานจริง" ใน README แล้วรันใหม่ด้วย DEVICE_ID นั้น');
        failed++;
      }
      const yes = isTestDevice ? (await p.ask('แจ้งคนในกลุ่มแล้วและต้องการทดสอบ? (y/N): ')).toLowerCase() : 'n';
      if (yes === 'y') {
        const waitMs = Number(process.env.WINDOW_WAIT_MS ?? 65000);
        console.log(`รอ ${Math.round(waitMs / 1000)} วินาทีให้ค่าปกติที่ส่งไปก่อนหน้าหลุดช่วงตรวจ...`);
        await sleep(waitMs);
        await reading(9.5);
        await sleep(2000);
        await reading(9.6);
        r = await runCheck();
        console.log(`  ผลตรวจรอบที่ 1: ${JSON.stringify(r.json)}`);
        check('แจ้งเตือนอุณหภูมิสูงถูกสร้างและส่ง', r.status === 200 && r.json?.transitions >= 1 && r.json?.sent >= 1,
          'ถ้า sent = 0 ให้ตรวจว่าตั้งกลุ่มแล้ว และไม่ได้ทดสอบซ้ำภายใน 30 นาที (ระบบกันส่งซ้ำ)');
        await p.ask('ดูในกลุ่ม LINE ว่ามีข้อความแจ้งเตือนอุณหภูมิสูง แล้วกด Enter เพื่อส่งค่าปกติ...');
        await reading(5.0);
        r = await runCheck();
        console.log(`  ผลตรวจรอบที่ 2: ${JSON.stringify(r.json)}`);
        check('ข้อความกลับสู่ปกติถูกสร้าง', r.status === 200 && r.json?.transitions >= 1);
        console.log('\nทดสอบเสร็จแล้ว ให้ปิดตู้ทดสอบทันที ไม่เช่นนั้นอีกประมาณ 15 นาทีจะมีแจ้งเตือน "ขาดสัญญาณ" ของตู้ทดสอบ:');
        console.log(`  update public.devices set active = false where id = '${deviceId}';`);
      } else {
        console.log('ข้ามการทดสอบแจ้งเตือน');
      }
    } else {
      console.log('\nทดสอบแจ้งเตือนเข้า LINE จริง: node scripts/smoke-test.mjs --alert-test');
    }

    console.log(failed ? `\n❌ ไม่ผ่าน ${failed} รายการ` : '\n✅ ผ่านทุกรายการ');
    process.exitCode = failed ? 1 : 0;
  } finally {
    p.close();
  }
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});
