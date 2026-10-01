import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { httpError } from './service.js';
import { validTz } from './slots.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const SESSION_DAYS = 30;

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, hash] = stored.split('$');
  const got = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

export function createAuth(db, { allowSignup = process.env.ALLOW_SIGNUP === '1' } = {}) {
  const q = (s) => db.prepare(s);
  const publicUser = (u) => ({ id: u.id, email: u.email, tz: u.tz, is_admin: !!u.is_admin });
  const fails = new Map(); // email|ip -> {n, until}

  const auth = {
    userCount: () => q('SELECT COUNT(*) AS n FROM users').get().n,

    createUser({ email, password, tz = 'UTC', isAdmin = false }) {
      email = String(email || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'valid email required');
      if (String(password || '').length < 8) throw httpError(400, 'password must be at least 8 characters');
      if (!validTz(tz)) tz = 'UTC';
      try {
        const r = q('INSERT INTO users(email,password_hash,tz,is_admin) VALUES (?,?,?,?)').run(email, hashPassword(password), tz, isAdmin ? 1 : 0);
        return publicUser(q('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid));
      } catch (e) {
        if (/UNIQUE/.test(e.message)) throw httpError(409, 'email already registered');
        throw e;
      }
    },

    signup(body) {
      const first = auth.userCount() === 0;
      if (!first && !allowSignup) throw httpError(403, 'signup is closed; ask the admin for an account');
      const u = auth.createUser({ ...body, isAdmin: first });
      if (first) { // adopt data from the single-user version
        q('UPDATE accounts SET user_id=? WHERE user_id IS NULL').run(u.id);
        q('UPDATE posts SET user_id=? WHERE user_id IS NULL').run(u.id);
      }
      return u;
    },

    login({ email, password }, ip = '') {
      const key = `${String(email).toLowerCase()}|${ip}`;
      const f = fails.get(key);
      if (f && f.n >= 5 && f.until > Date.now()) throw httpError(429, 'too many attempts, try again in a few minutes');
      const u = q('SELECT * FROM users WHERE email=?').get(String(email || ''));
      if (!u || !verifyPassword(String(password || ''), u.password_hash)) {
        fails.set(key, { n: (f?.n || 0) + 1, until: Date.now() + 10 * 60e3 });
        throw httpError(401, 'invalid email or password');
      }
      fails.delete(key);
      const token = randomBytes(32).toString('hex');
      q('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)')
        .run(sha(token), u.id, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString());
      return { token, user: publicUser(u), maxAge: SESSION_DAYS * 86400 };
    },

    userFromToken(token) {
      if (!token) return null;
      const u = q(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at > ?`)
        .get(sha(token), new Date().toISOString());
      return u ? publicUser(u) : null;
    },

    logout: (token) => q('DELETE FROM sessions WHERE token_hash=?').run(sha(token || '')),
    purgeExpired: () => q('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString()),

    listUsers: () => q('SELECT * FROM users ORDER BY id').all().map(publicUser),
    deleteUser(id) { q('DELETE FROM users WHERE id=? AND is_admin=0').run(id); },
    setTz(id, tz) {
      if (!validTz(tz)) throw httpError(400, 'invalid timezone');
      q('UPDATE users SET tz=? WHERE id=?').run(tz, id);
    },
    changePassword(id, oldPw, newPw) {
      const u = q('SELECT * FROM users WHERE id=?').get(id);
      if (!verifyPassword(String(oldPw || ''), u.password_hash)) throw httpError(403, 'current password is wrong');
      if (String(newPw || '').length < 8) throw httpError(400, 'password must be at least 8 characters');
      q('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(newPw), id);
      q('DELETE FROM sessions WHERE user_id=?').run(id);
    },
  };
  return auth;
}
