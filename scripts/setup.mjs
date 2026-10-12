#!/usr/bin/env node
// ตัวช่วยติดตั้งฝั่งเซิร์ฟเวอร์ (รันบนเครื่องของคุณ: node scripts/setup.mjs)
//   - ถามค่าที่จำเป็น (โทเคน LINE จะไม่แสดงตอนพิมพ์ และไม่ถูกส่งไปที่ใดนอกจาก Supabase ของคุณ)
//   - สร้าง supabase/.env พร้อมรหัสสุ่ม (CRON_SECRET, SETUP_PASSCODE)
//   - login / link / ตั้ง secrets / deploy Edge Functions ด้วย Supabase CLI
//   - สร้างไฟล์ supabase/setup.generated.sql ที่กรอกค่าครบแล้ว นำไปวางใน SQL Editor ครั้งเดียว
// ใช้ --dry-run เพื่อดูว่าจะทำอะไรโดยไม่เรียก Supabase CLI

import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrompter } from './_prompt.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, 'supabase', '.env');
const SQL_OUT = join(ROOT, 'supabase', 'setup.generated.sql');
const DRY = process.argv.includes('--dry-run');
const FUNCTIONS = ['ingest', 'check-alerts', 'line-webhook'];
const IS_WIN = process.platform === 'win32';

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function run(args, { quiet = false } = {}) {
  const line = `npx supabase ${args.join(' ')}`;
  console.log(`\n$ ${line}`);
  if (DRY) {
    console.log('  [dry-run] ข้ามการรันจริง');
    return 0;
  }
  const r = spawnSync('npx', ['--yes', 'supabase', ...args], {
    cwd: ROOT,
    stdio: quiet ? 'ignore' : 'inherit',
    shell: IS_WIN,
  });
  return r.status ?? 1;
}

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function randomCode(len) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

function buildSql(ref, cronSecret) {
  const read = (p) => readFileSync(join(ROOT, 'supabase', p), 'utf8');
  // ตัดคอมเมนต์หัวไฟล์ออก (กล่าวถึงตัวแทนค่าที่จะถูกแทนที่) แล้วแทนค่าจริงเฉพาะคำสั่ง SQL
  const cronRaw = read('cron.sql');
  const cron = cronRaw
    .slice(cronRaw.indexOf('select cron.schedule'))
    .replaceAll('PROJECT_REF', ref)
    .replaceAll('CRON_SECRET_HERE', cronSecret);
  return [
    '-- สร้างอัตโนมัติโดย scripts/setup.mjs (มีรหัสลับ ห้ามนำขึ้น GitHub)',
    '-- วางทั้งไฟล์ใน Supabase SQL Editor แล้วกด Run "ครั้งเดียว"',
    '',
    '-- ===== 001_schema.sql =====',
    read('migrations/001_schema.sql'),
    '',
    '-- ===== 002_settings.sql =====',
    read('migrations/002_settings.sql'),
    '',
    '-- ===== cron.sql =====',
    cron,
  ].join('\n');
}

async function main() {
  console.log('== ติดตั้งฝั่งเซิร์ฟเวอร์: ระบบเฝ้าระวังตู้เย็นวัคซีน ==');
  if (DRY) console.log('(โหมด --dry-run: จะไม่เรียก Supabase CLI)');
  if (Number(process.versions.node.split('.')[0]) < 18) fail('ต้องใช้ Node.js 18 ขึ้นไป');

  const p = createPrompter();
  try {
    // 1) Project ref
    let ref = '';
    for (let i = 0; i < 3 && !ref; i++) {
      const v = await p.ask('Project ref ของ Supabase (ส่วนหน้า .supabase.co ใน Project URL): ');
      const m = v.match(/^(?:https?:\/\/)?([a-z0-9]{20})(?:\.supabase\.co)?\/?$/i);
      if (m) ref = m[1].toLowerCase();
      else console.log('  รูปแบบไม่ถูกต้อง ควรเป็นตัวอักษร/ตัวเลข 20 ตัว เช่น abcdefghijklmnopqrst');
    }
    if (!ref) fail('ไม่ได้รับ Project ref');

    // 2) .env
    const env = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, 'utf8')) : {};
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
      env.LINE_CHANNEL_ACCESS_TOKEN = await p.need('LINE Channel access token (พิมพ์แล้วจะไม่แสดง): ', { hidden: true });
    }
    if (!env.LINE_CHANNEL_SECRET) {
      env.LINE_CHANNEL_SECRET = await p.need('LINE Channel secret (พิมพ์แล้วจะไม่แสดง): ', { hidden: true });
    }
    if (!env.CRON_SECRET) env.CRON_SECRET = randomBytes(24).toString('hex');
    if (!env.SETUP_PASSCODE) env.SETUP_PASSCODE = randomCode(8);

    const lines = [
      '# สร้างโดย scripts/setup.mjs (ห้ามนำขึ้น GitHub)',
      ...Object.entries(env)
        .filter(([, v]) => v !== '')
        .map(([k, v]) => `${k}=${v}`),
    ];
    writeFileSync(ENV_PATH, lines.join('\n') + '\n', { mode: 0o600 });
    console.log(`\n✅ บันทึก ${ENV_PATH}`);

    // 3) Supabase CLI
    if (!DRY) {
      const loggedIn = run(['projects', 'list'], { quiet: true }) === 0;
      if (!loggedIn) {
        console.log('\nยังไม่ได้ล็อกอิน Supabase CLI จะเปิดเบราว์เซอร์ให้ล็อกอิน');
        if (run(['login']) !== 0) fail('ล็อกอินไม่สำเร็จ');
      }
    } else {
      run(['login']);
    }
    if (run(['link', '--project-ref', ref]) !== 0) {
      fail('link โปรเจกต์ไม่สำเร็จ (ถ้าถามรหัสผ่านฐานข้อมูล กด Enter ข้ามได้)');
    }
    if (run(['secrets', 'set', '--env-file', 'supabase/.env', '--project-ref', ref]) !== 0) fail('ตั้งค่า secrets ไม่สำเร็จ');
    for (const fn of FUNCTIONS) {
      if (run(['functions', 'deploy', fn, '--no-verify-jwt', '--project-ref', ref]) !== 0) fail(`deploy ${fn} ไม่สำเร็จ`);
    }

    // 4) SQL พร้อมวาง
    writeFileSync(SQL_OUT, buildSql(ref, env.CRON_SECRET), { mode: 0o600 });
    console.log(`\n✅ สร้าง ${SQL_OUT}`);

    console.log(`
================ เหลือที่ต้องทำเอง (ใช้บัญชีของคุณ) ================
1) Supabase → SQL Editor: เปิดไฟล์ supabase/setup.generated.sql คัดลอกทั้งหมดไปวาง กด Run (ครั้งเดียว)
   ถ้า create extension ล้มเหลว ให้เปิด pg_cron และ pg_net ที่ Database → Extensions แล้วรันใหม่
2) Supabase → Authentication: ปิด "Allow new users to sign up" แล้วสร้างบัญชีเจ้าหน้าที่ (Add user, ติ๊ก Auto Confirm)
3) LINE Developers Console → Messaging API: ใส่ Webhook URL
     https://${ref}.supabase.co/functions/v1/line-webhook
   กด Verify แล้วเปิด Use webhook
4) เชิญ LINE OA เข้ากลุ่ม แล้วพิมพ์ในกลุ่ม:  ตั้งกลุ่มนี้ ${env.SETUP_PASSCODE}
   (แล้วลบข้อความที่มีรหัสออกจากกลุ่ม)
5) ทดสอบระบบ:  node scripts/smoke-test.mjs
=====================================================================`);
  } finally {
    p.close();
  }
}

main().catch((e) => fail(e.message));
