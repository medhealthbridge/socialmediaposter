/**
 * Set a new password when you cannot get in.
 *
 * Passwords are stored as a one-way scrypt hash, so a forgotten one cannot be looked up —
 * not by you, not by anyone holding the database. The only way back in is to set a new one,
 * which is what this does, straight against the database the app itself uses.
 *
 *   npm run reset-password                      list the accounts
 *   npm run reset-password you@example.com      set a new random password and print it
 *   npm run reset-password you@example.com mine-new-password
 *
 * It reads DATABASE_URL / POSTGRES_URL / DB_PATH exactly like the app, so run it where the
 * app runs. For Vercel + Neon, copy the connection string from your database and pass it:
 *   DATABASE_URL='postgres://…' npm run reset-password you@example.com
 */
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const [email, given] = process.argv.slice(2);
const db = await openDb();

try {
  const users = await db.all('SELECT id, email, is_admin, created_at FROM users ORDER BY id');
  if (!users.length) {
    console.log('There are no accounts yet. Open the app and the first one you create is the admin.');
    process.exit(0);
  }

  if (!email) {
    console.log(`Accounts in this database (${db.kind}):\n`);
    for (const u of users) console.log(`  ${u.email}${u.is_admin ? '   (admin)' : ''}`);
    console.log(`\nTo set a new password:\n  npm run reset-password ${users[0].email}`);
    process.exit(0);
  }

  const wanted = String(email).trim().toLowerCase();
  const user = users.find((u) => u.email.toLowerCase() === wanted);
  if (!user) {
    console.error(`No account for “${email}”. The ones here are: ${users.map((u) => u.email).join(', ')}`);
    process.exit(1);
  }

  // A generated password is four random words' worth of entropy, easy enough to type once.
  const password = given || randomBytes(12).toString('base64url');
  if (password.length < 8) {
    console.error('A password must be at least 8 characters.');
    process.exit(1);
  }

  await db.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(password), user.id);
  // Anyone already signed in as them is signed out, so an old session cannot outlive this.
  const { changes } = await db.run('DELETE FROM sessions WHERE user_id=?', user.id);

  console.log(`\n  ${user.email} can now sign in with:\n\n      ${password}\n`);
  console.log(`  ${changes || 0} existing session${changes === 1 ? '' : 's'} signed out.`);
  console.log('  Change it to something you will remember under Settings → Password.\n');
} finally {
  await db.close();
}
