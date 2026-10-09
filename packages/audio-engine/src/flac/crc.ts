/** CRC-8 (poly 0x07) and CRC-16 (poly 0x8005) of FLAC frame headers and frames, MSB first. */

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c8 = i;
  let c16 = i << 8;
  for (let b = 0; b < 8; b++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  CRC8[i] = c8;
  CRC16[i] = c16;
}

export function crc8(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) crc = CRC8[crc ^ (bytes[i] ?? 0)] ?? 0;
  return crc;
}

export function crc16(bytes: Uint8Array, start: number, end: number, crc = 0): number {
  for (let i = start; i < end; i++) crc = crc16Byte(crc, bytes[i] ?? 0);
  return crc;
}

export function crc16Byte(crc: number, byte: number): number {
  return ((crc << 8) & 0xffff) ^ (CRC16[(crc >>> 8) ^ byte] ?? 0);
}
