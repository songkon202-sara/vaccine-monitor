import { admin as sb } from '../_shared/supabase.ts';

// จัดการสมาชิก (เรียกจากแดชบอร์ดโดยผู้ดูแลระบบเท่านั้น)
// POST { action: 'list' | 'create' | 'set_role' | 'set_password' | 'disable' | 'enable', ... }
// ยืนยันตัวตนด้วย access token ของผู้ใช้ที่ล็อกอิน และต้องมี role = 'admin' ในตาราง staff_roles

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['staff', 'admin'];
const MIN_PASSWORD = 8;
const BAN_FOREVER = '876000h'; // ~100 ปี

interface Body {
  action?: string;
  user_id?: string;
  email?: string;
  password?: string;
  role?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'method not allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: who, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !who?.user) return reply({ error: 'กรุณาเข้าสู่ระบบใหม่' }, 401);
  const me = who.user;

  const { data: myRole, error: roleErr } = await sb.from('staff_roles').select('role').eq('user_id', me.id).maybeSingle();
  if (roleErr) return reply({ error: 'server error' }, 500);
  if (myRole?.role !== 'admin') return reply({ error: 'ต้องเป็นผู้ดูแลระบบ' }, 403);

  let b: Body;
  try {
    b = await req.json();
  } catch {
    return reply({ error: 'invalid json' }, 400);
  }

  try {
    switch (b.action) {
      case 'list': {
        const { data, error } = await sb.auth.admin.listUsers({ perPage: 1000 });
        if (error) throw error;
        const { data: roles, error: e2 } = await sb.from('staff_roles').select('user_id, role');
        if (e2) throw e2;
        const roleOf = new Map((roles ?? []).map((r) => [r.user_id as string, r.role as string]));
        const users = data.users
          .map((u) => ({
            id: u.id,
            email: u.email ?? '',
            role: roleOf.get(u.id) ?? 'staff',
            disabled: !!u.banned_until && Date.parse(u.banned_until) > Date.now(),
            created_at: u.created_at,
            last_sign_in_at: u.last_sign_in_at ?? null,
          }))
          .sort((x, y) => x.email.localeCompare(y.email));
        return reply({ users, me: me.id });
      }

      case 'create': {
        const email = String(b.email ?? '').trim().toLowerCase();
        const password = String(b.password ?? '');
        const role = String(b.role ?? 'staff');
        if (!EMAIL_RE.test(email)) return reply({ error: 'อีเมลไม่ถูกต้อง' }, 400);
        if (password.length < MIN_PASSWORD) return reply({ error: `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัว` }, 400);
        if (!ROLES.includes(role)) return reply({ error: 'สิทธิ์ไม่ถูกต้อง' }, 400);
        const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
        if (error) {
          const dup = /already|registered|exists/i.test(error.message);
          return reply({ error: dup ? 'อีเมลนี้มีบัญชีอยู่แล้ว' : error.message }, 400);
        }
        await setRole(data.user.id, role, me.email ?? '');
        return reply({ ok: true });
      }

      case 'set_role': {
        const id = String(b.user_id ?? '');
        const role = String(b.role ?? '');
        if (!ROLES.includes(role)) return reply({ error: 'สิทธิ์ไม่ถูกต้อง' }, 400);
        // กันผู้ดูแลลดสิทธิ์ตัวเอง (ระบบจะมีผู้ดูแลเหลืออย่างน้อย 1 คนเสมอ)
        if (id === me.id) return reply({ error: 'เปลี่ยนสิทธิ์ของตัวเองไม่ได้' }, 400);
        await setRole(id, role, me.email ?? '');
        return reply({ ok: true });
      }

      case 'set_password': {
        const id = String(b.user_id ?? '');
        const password = String(b.password ?? '');
        if (password.length < MIN_PASSWORD) return reply({ error: `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัว` }, 400);
        const { error } = await sb.auth.admin.updateUserById(id, { password });
        if (error) throw error;
        return reply({ ok: true });
      }

      case 'disable':
      case 'enable': {
        const id = String(b.user_id ?? '');
        if (id === me.id) return reply({ error: 'ระงับบัญชีของตัวเองไม่ได้' }, 400);
        const { error } = await sb.auth.admin.updateUserById(id, {
          ban_duration: b.action === 'disable' ? BAN_FOREVER : 'none',
        });
        if (error) throw error;
        return reply({ ok: true });
      }

      default:
        return reply({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    console.error('manage-staff', b.action, e);
    return reply({ error: e instanceof Error ? e.message : 'server error' }, 500);
  }
});

async function setRole(userId: string, role: string, by: string) {
  const { error } = await sb
    .from('staff_roles')
    .upsert({ user_id: userId, role, updated_at: new Date().toISOString(), updated_by: by });
  if (error) throw error;
}
