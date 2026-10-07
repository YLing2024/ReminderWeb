/**
 * 备份包加密（对齐安卓 `util/BackupEncryptor.kt` 与前端 `src/lib/backup.ts`）。
 *
 * 算法：AES-256-CBC + PKCS7 填充；密钥 = SHA-256(seed)，seed[i] = obfuscated[i] XOR 90；
 * 密文布局 = [16 字节 IV][密文]（无分隔符、无 Base64）。
 *
 * 仅使用 `node:crypto`。密钥常量必须与前端 `src/lib/backup.ts` 的 `OBFUSCATED_KEY`
 * 逐字节一致，由 `server/test/backup-format.test.ts` 交叉断言，防止两边漂移。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** 上游 40 字节混淆常量（与前端逐字节相同）。 */
const OBFUSCATED_KEY: readonly number[] = [
  40, 63, 55, 51, 52, 62, 63, 40, 41, 63, 57, 47, 40, 63, 124, 59, 57, 49, 47, 34, 41, 63, 63, 62, 44, 59, 54, 47, 63, 37,
  104, 106, 104, 110, 37, 35, 56, 62, 61, 54,
];

const IV_LENGTH = 16;

/** 供交叉测试断言常量一致（只暴露字节，不暴露派生密钥）。 */
export function obfuscatedKey(): readonly number[] {
  return OBFUSCATED_KEY;
}

function deriveKey(): Buffer {
  const seed = Buffer.alloc(OBFUSCATED_KEY.length);
  for (let i = 0; i < OBFUSCATED_KEY.length; i += 1) seed[i] = (OBFUSCATED_KEY[i]! ^ 90) & 0xff;
  return createHash('sha256').update(seed).digest();
}

/** 整包加密：返回 [16 字节随机 IV][密文]。 */
export function encryptArchive(zipBytes: Uint8Array): Uint8Array {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-cbc', deriveKey(), iv);
  const body = Buffer.concat([cipher.update(zipBytes), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, body]));
}

/** 解密整包；失败返回 null（调用方据此回退到明文 zip）。 */
export function decryptArchive(data: Uint8Array): Uint8Array | null {
  if (data.length <= IV_LENGTH) return null;
  try {
    const iv = data.subarray(0, IV_LENGTH);
    const decipher = createDecipheriv('aes-256-cbc', deriveKey(), iv);
    const plain = Buffer.concat([decipher.update(data.subarray(IV_LENGTH)), decipher.final()]);
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

/** 是否为明文 zip（"PK\x03\x04"）。 */
export function isZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}
