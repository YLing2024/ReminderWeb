/**
 * 极简 ZIP 读写（仅用 `node:zlib` 与 `node:buffer`，后端零第三方依赖）。
 *
 * 与安卓版 / 前端 fflate 生成的普通 zip 互操作：支持 STORE(0) 与 DEFLATE(8) 两种方式；
 * 不支持 ZIP64（备份包远小于 4GiB）。写入时使用固定 DOS 时间，保证同一输入产出稳定。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** 标准 CRC-32（IEEE 802.3）。 */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 固定 DOS 日期 2020-01-01 00:00:00，避免写入时间进入 zip 头。 */
const DOS_TIME = 0;
const DOS_DATE = (((2020 - 1980) << 9) | (1 << 5) | 1) & 0xffff;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** 打包为 zip；`files` 的键为条目名（目录用 `/` 结尾）。 */
export function zipCreate(files: Record<string, Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, data] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const deflated = new Uint8Array(deflateRawSync(data));
    const useStore = deflated.length >= data.length;
    const payload = useStore ? data : deflated;
    const method = useStore ? 0 : 8;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 文件名
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, payload);

    const header = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    header.set(nameBytes, 46);
    central.push(header);

    offset += local.length + payload.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = chunks.reduce((sum, part) => sum + part.length, 0) + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let position = 0;
  for (const part of chunks) {
    out.set(part, position);
    position += part.length;
  }
  for (const part of central) {
    out.set(part, position);
    position += part.length;
  }
  out.set(eocd, position);
  return out;
}

/** 解压 zip，返回条目名 → 字节。非法结构抛 `Error`。 */
export function zipExtract(data: Uint8Array): Record<string, Uint8Array> {
  if (data.length < 22) throw new Error('不是有效的 zip：内容过短');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const minEocd = 22;
  let eocd = -1;
  const lowest = Math.max(0, data.length - (0xffff + minEocd));
  for (let i = data.length - minEocd; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录');

  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const out: Record<string, Uint8Array> = {};
  let ptr = centralOffset;

  for (let i = 0; i < count; i += 1) {
    if (ptr + 46 > data.length || view.getUint32(ptr, true) !== CENTRAL_SIG) {
      throw new Error('不是有效的 zip：中央目录条目损坏');
    }
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const nameLength = view.getUint16(ptr + 28, true);
    const extraLength = view.getUint16(ptr + 30, true);
    const commentLength = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = decoder.decode(data.subarray(ptr + 46, ptr + 46 + nameLength));

    if (localOffset + 30 > data.length || view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`不是有效的 zip：条目「${name}」的本地头损坏`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = data.subarray(start, start + compressedSize);
    if (method === 0) {
      out[name] = raw.slice();
    } else if (method === 8) {
      out[name] = new Uint8Array(inflateRawSync(raw));
    } else {
      throw new Error(`不支持的 zip 压缩方式：${method}`);
    }
    ptr += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
