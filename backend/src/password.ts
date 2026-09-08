import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/** 生成密码哈希，格式：scrypt$<盐hex>:<哈希hex> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** 校验密码与存储哈希是否匹配（恒定时间比较，防时序攻击） */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, rest] = stored.split('$');
  if (scheme !== 'scrypt' || !rest) {
    return false;
  }
  const [saltHex, hashHex] = rest.split(':');
  if (!saltHex || !hashHex) {
    return false;
  }
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = (await scryptAsync(password, salt, expected.length)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}