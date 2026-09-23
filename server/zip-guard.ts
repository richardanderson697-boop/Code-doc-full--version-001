// Cheap structural checks on a ZIP archive, run BEFORE handing the buffer to
// a ZIP library.
//
// The entry-count limit used to be enforced after adm-zip's getEntries(), which
// is the call that allocates. Each central-directory record costs ~47 archive
// bytes but roughly 8.7KB of heap once materialized, a ~195x amplification, so
// a small body of nothing but directory records could exhaust memory before
// any limit was consulted. Reading the count straight out of the end-of-
// central-directory record costs nothing and happens first.

export interface ZipHeaderInfo {
  entryCount: number;
  zip64: boolean;
}

/**
 * True when an archive entry name would escape the extraction directory.
 *
 * adm-zip sanitizes names it writes, so a traversal entry can only arrive in an
 * archive built by other tooling. The extractor has its own containment, but
 * this rejects the upload outright rather than silently rewriting paths, so the
 * user is told their archive is malformed instead of quietly getting different
 * files than the ones they packed.
 */
export function hasUnsafeEntryName(entryName: string): boolean {
  if (typeof entryName !== "string" || entryName.length === 0) return true;
  if (entryName.includes("\0")) return true;
  // Absolute, drive-relative, or UNC.
  if (/^([\\/]|[A-Za-z]:)/.test(entryName)) return true;
  return entryName.split(/[\\/]/).includes("..");
}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const EOCD_MIN_SIZE = 22;
// The EOCD sits at the end, followed only by an optional comment (max 65535).
const MAX_COMMENT = 0xffff;

/**
 * Read the declared entry count from the archive's end-of-central-directory
 * record. Returns null when the record cannot be found, which means the buffer
 * is not a usable ZIP and should be rejected rather than parsed.
 */
export function readZipHeader(buffer: Buffer): ZipHeaderInfo | null {
  if (buffer.length < EOCD_MIN_SIZE) return null;

  const searchStart = Math.max(0, buffer.length - (EOCD_MIN_SIZE + MAX_COMMENT));
  let eocd = -1;
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  // A ZIP has two entry counts: "entries on this disk" (ENDSUB, +8) and "total
  // entries" (ENDTOT, +10). They are independent fields and an attacker sets
  // both. adm-zip sizes its entry array from ENDSUB (via mainHeader.diskEntries
  // in readEntries), so reading only ENDTOT let an archive declaring ENDTOT=1
  // walk past this guard and then allocate a million entries from the other
  // field. Take the largest of every count the archive declares.
  const counts = [buffer.readUInt16LE(eocd + 8), buffer.readUInt16LE(eocd + 10)];
  let zip64 = false;

  // Follow the ZIP64 record whenever a locator is present, not only when a
  // count shows the 0xFFFF escape. adm-zip selects the ZIP64 branch on the
  // record signature, so a classic EOCD holding small counts alongside a valid
  // ZIP64 record is exactly the desync this has to catch.
  const locator = eocd - 20;
  if (locator >= 0 && buffer.readUInt32LE(locator) === EOCD64_LOCATOR_SIG) {
    zip64 = true;
    const eocd64Offset = Number(buffer.readBigUInt64LE(locator + 8));
    if (
      Number.isSafeInteger(eocd64Offset) &&
      eocd64Offset >= 0 &&
      eocd64Offset + 40 <= buffer.length &&
      buffer.readUInt32LE(eocd64Offset) === EOCD64_SIG
    ) {
      const clamp = (v: bigint) =>
        v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
      // ZIP64SUB (+24) and ZIP64TOT (+32), mirroring the classic pair.
      counts.push(clamp(buffer.readBigUInt64LE(eocd64Offset + 24)));
      counts.push(clamp(buffer.readBigUInt64LE(eocd64Offset + 32)));
    } else {
      // A locator pointing at a record we cannot read is not something to wave
      // through: report a count that fails any sane limit.
      counts.push(Number.MAX_SAFE_INTEGER);
    }
  } else if (counts.some((c) => c === 0xffff)) {
    // The escape value with no locator to resolve it. Same reasoning.
    zip64 = true;
    counts.push(Number.MAX_SAFE_INTEGER);
  }

  // Deliberately NOT derived from the central-directory size. Each record is
  // 46 bytes plus a filename, so size/46 overestimates by roughly a third and
  // would reject legitimate archives near the limit. adm-zip already refuses a
  // diskEntries count too large for the buffer, so the exact declared fields
  // above are what needs checking.
  return { entryCount: Math.max(...counts), zip64 };
}
