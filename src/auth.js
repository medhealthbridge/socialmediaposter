import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { httpError } from './errors.js';
import { validTz } from './tz.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const SESSION_DAYS = 30;

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, hash] = stored.split('$');
  return timingSafeEqual(scryptSync(pw, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'));
}

export function createAuth(db, { allowSignup = process.env.ALLOW_SIGNUP === '1' } = {}) {
  const publicUser = (u) => ({ id: u.id, email: u.email, tz: u.tz, is_admin: !!u.is_admin });
  const fails = new Map(); // email|ip -> {n, until}  (per instance; good enough against casual guessing)

  const auth = {
    userCount: async () => (await db.get('SELECT COUNT(*) AS n FROM users')).n,

    async createUser({ email, password, tz = 'UTC', isAdmin = false }) {
      email = String(email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'valid email required');
      if (String(password || '').length < 8) throw httpError(400, 'password must be at least 8 characters');
      if (!validTz(tz)) tz = 'UTC';
      if (await db.get('SELECT 1 FROM users WHERE email=?', email)) throw httpError(409, 'email already registered');
      const id = await db.insert('INSERT INTO users(email,password_hash,tz,is_admin) VALUES (?,?,?,?)', email, hashPassword(password), tz, isAdmin ? 1 : 0);
      return publicUser(await db.get('SELECT * FROM users WHERE id=?', id));
    },

    async signup(body) {
      const first = (await auth.userCount()) === 0;
      if (!first && !allowSignup) throw httpError(403, 'signup is closed; ask the admin for an account');
      const u = await auth.createUser({ ...body, isAdmin: first });
      if (first) { // adopt data from the single-user version
        await db.run('UPDATE accounts SET user_id=? WHERE user_id IS NULL', u.id);
        await db.run('UPDATE posts SET user_id=? WHERE user_id IS NULL', u.id);
      }
      return u;
    },

    async login({ email, password }, ip = '') {
      email = String(email || '').trim().toLowerCase();
      const key = `${email}|${ip}`;
      const f = fails.get(key);
      if (f && f.n >= 5 && f.until > Date.now()) throw httpError(429, 'too many attempts, try again in a few minutes');
      const u = await db.get('SELECT * FROM users WHERE email=?', email);
      if (!u || !verifyPassword(String(password || ''), u.password_hash)) {
        fails.set(key, { n: (f?.n || 0) + 1, until: Date.now() + 10 * 60e3 });
        throw httpError(401, 'invalid email or password');
      }
      fails.delete(key);
      const token = randomBytes(32).toString('hex');
      await db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)', sha(token), u.id, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString());
      return { token, user: publicUser(u), maxAge: SESSION_DAYS * 86400 };
    },

    async userFromToken(token) {
      if (!token) return null;
      const u = await db.get('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at > ?', sha(token), new Date().toISOString());
      return u ? publicUser(u) : null;
    },

    logout: (token) => db.run('DELETE FROM sessions WHERE token_hash=?', sha(token || '')),
    purgeExpired: () => db.run('DELETE FROM sessions WHERE expires_at <= ?', new Date().toISOString()),
    listUsers: async () => (await db.all('SELECT * FROM users ORDER BY id')).map(publicUser),
    deleteUser: (id) => db.run('DELETE FROM users WHERE id=? AND is_admin=0', id),
    async setTz(id, tz) {
      if (!validTz(tz)) throw httpError(400, 'invalid timezone');
      await db.run('UPDATE users SET tz=? WHERE id=?', tz, id);
    },
    async changePassword(id, oldPw, newPw) {
      const u = await db.get('SELECT * FROM users WHERE id=?', id);
      if (!verifyPassword(String(oldPw || ''), u.password_hash)) throw httpError(403, 'current password is wrong');
      if (String(newPw || '').length < 8) throw httpError(400, 'password must be at least 8 characters');
      await db.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(newPw), id);
      await db.run('DELETE FROM sessions WHERE user_id=?', id);
    },
  };
  return auth;
}
