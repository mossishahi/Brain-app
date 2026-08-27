/**
 * A minimal ZIP writer for the run-trace export: the classic (non-zip64)
 * layout, one deflate-or-store entry per file, assembled in memory.
 *
 * Written here rather than pulled in as a dependency because the server
 * already READS zips (yauzl, for attachments) and needs exactly one writer
 * shape: named text entries, well under 4 GB total. The round-trip test opens
 * every archive with yauzl, so the writer is held to the same reader the rest
 * of the app trusts.
 *
 * Event-loop discipline: compression runs through zlib's ASYNC deflate (the
 * threadpool), and the checksum through zlib's native crc32 when the runtime
 * has it (every supported Node does; the table fallback exists for the type
 * system and as the test's independent check).
 */
import * as zlib from "node:zlib";
import { promisify } from "node:util";

const deflateRawAsync = promisify(zlib.deflateRaw);

export interface ZipEntry {
  /** Forward-slash relative path inside the archive. */
  readonly path: string;
  readonly data: Buffer | string;
}

/** Standard CRC-32 (IEEE 802.3), the checksum every ZIP entry must carry. */
const CRC_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

/** Exported for the round-trip test, which checks it against zlib's own. */
export function crc32Table(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Native (C-speed) crc32 where the runtime offers it; see the module note. */
const crc32: (data: Buffer) => number =
  typeof (zlib as { crc32?: unknown }).crc32 === "function"
    ? (data) => (zlib as unknown as { crc32(data: Buffer): number }).crc32(data) >>> 0
    : crc32Table;

/** Local-time DOS date/time pair, as ZIP headers store timestamps. */
function dosDateTime(at: Date): { readonly date: number; readonly time: number } {
  return {
    date:
      ((Math.max(0, at.getFullYear() - 1980) & 0x7f) << 9) |
      ((at.getMonth() + 1) << 5) |
      at.getDate(),
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
  };
}

export async function zipArchive(
  entries: readonly ZipEntry[],
  now = new Date(),
): Promise<Buffer> {
  const { date, time } = dosDateTime(now);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const raw =
      typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const checksum = crc32(raw);
    const deflated = await deflateRawAsync(raw);
    // Deflate unless it loses (tiny or incompressible payloads): a stored
    // entry is legal ZIP and the reader never knows the difference.
    const method = deflated.length < raw.length ? 8 : 0;
    const body = method === 8 ? deflated : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    parts.push(local, name, body);

    const dir = Buffer.alloc(46); // zero-filled: comment/disk/attribute fields
    dir.writeUInt32LE(0x02014b50, 0); // central directory header signature
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed to extract
    dir.writeUInt16LE(0x0800, 8); // flags: UTF-8 names
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(checksum, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42); // local header offset
    central.push(dir, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end-of-central-directory signature
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // entries total
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...parts, directory, end]);
}
