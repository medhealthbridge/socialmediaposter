// Encrypts account credentials at rest (AES-256-GCM). Legacy plaintext JSON is still readable.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadKey({ env = process.env.SECRET_KEY, file = 'data/secret.key' } = {}) {
  if (env) return createHash('sha256').update(env).digest();
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

export function createVault(key) {
  return {
    seal(obj) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
      return `enc1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
    },
    open(str) {
      if (!str.startsWith('enc1:')) return JSON.parse(str);
      const [, iv, tag, ct] = str.split(':');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'));
    },
  };
}
