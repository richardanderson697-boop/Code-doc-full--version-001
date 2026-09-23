// The entry count has to come from the archive's own directory record, before
// a ZIP library materializes entries. Each materialized entry costs ~8.7KB of
// heap against ~47 archive bytes, so a small body of nothing but directory
// records could exhaust memory while the old check waited its turn.
import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import { readZipHeader, hasUnsafeEntryName } from "../server/zip-guard";

function realZip(fileCount: number): Buffer {
  const zip = new AdmZip();
  for (let i = 0; i < fileCount; i++) {
    zip.addFile(`src/file${i}.ts`, Buffer.from(`export const v${i} = ${i};\n`));
  }
  return zip.toBuffer();
}

// A central directory with no local file data: the shape that amplifies
// ~47 archive bytes into kilobytes of heap per entry.
function directoryOnlyZip(declaredEntries: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(declaredEntries & 0xffff, 8);
  eocd.writeUInt16LE(declaredEntries & 0xffff, 10);
  eocd.writeUInt32LE(0, 12);
  eocd.writeUInt32LE(0, 16);
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

describe("hasUnsafeEntryName", () => {
  it("rejects traversal in either separator", () => {
    for (const name of ["../evil.txt", "..\\evil.txt", "a/../../up.txt", "src/../../x", "a/b/.."]) {
      expect(hasUnsafeEntryName(name)).toBe(true);
    }
  });

  it("rejects absolute, drive-relative, and UNC names", () => {
    for (const name of ["/etc/passwd", "\\windows\\win.ini", "C:/Windows/win.ini", "c:evil", "\\\\srv\\share\\x"]) {
      expect(hasUnsafeEntryName(name)).toBe(true);
    }
  });

  it("rejects empty, non-string, and NUL-bearing names", () => {
    expect(hasUnsafeEntryName("")).toBe(true);
    expect(hasUnsafeEntryName("ok.ts\0../../x")).toBe(true);
    expect(hasUnsafeEntryName(null as any)).toBe(true);
    expect(hasUnsafeEntryName(42 as any)).toBe(true);
  });

  it("accepts ordinary names, including dotfiles and double dots inside a segment", () => {
    for (const name of ["src/App.tsx", "a/b/c.ts", ".env.example", "x..y.ts", "..hidden", "a/..b/c.ts"]) {
      expect(hasUnsafeEntryName(name)).toBe(false);
    }
  });
});

describe("readZipHeader", () => {
  it("reads the entry count from a real archive", () => {
    expect(readZipHeader(realZip(0))?.entryCount).toBe(0);
    expect(readZipHeader(realZip(1))?.entryCount).toBe(1);
    expect(readZipHeader(realZip(25))?.entryCount).toBe(25);
  });

  it("reads a large declared count without materializing anything", () => {
    // 60,000 declared entries in 22 bytes. The point of the check: this is
    // answered from the header, not by allocating 60,000 entry objects.
    const buf = directoryOnlyZip(60000);
    expect(buf.length).toBe(22);
    const started = Date.now();
    const header = readZipHeader(buf);
    expect(header?.entryCount).toBe(60000);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("flags a ZIP64 escape value rather than reporting 65535", () => {
    const header = readZipHeader(directoryOnlyZip(0xffff));
    expect(header?.zip64).toBe(true);
  });

  // The two counts are independent fields. adm-zip sizes its entry array from
  // ENDSUB (+8); reading only ENDTOT (+10) let an archive declare ENDTOT=1 and
  // then allocate from the other field.
  it("takes the larger count when the two disagree", () => {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(5000, 8); // ENDSUB: what the allocator uses
    eocd.writeUInt16LE(1, 10); // ENDTOT: what the old guard read
    expect(readZipHeader(eocd)?.entryCount).toBe(5000);
  });

  it("follows a ZIP64 record even when the classic counts look small", () => {
    // classic EOCD says 1, a ZIP64 record below it declares 900,000.
    const eocd64 = Buffer.alloc(56);
    eocd64.writeUInt32LE(0x06064b50, 0);
    eocd64.writeBigUInt64LE(900000n, 24); // ZIP64SUB
    eocd64.writeBigUInt64LE(900000n, 32); // ZIP64TOT
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(0), 8); // eocd64 sits at offset 0
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    const buf = Buffer.concat([eocd64, locator, eocd]);
    const header = readZipHeader(buf);
    expect(header?.zip64).toBe(true);
    expect(header?.entryCount).toBe(900000);
  });

  it("refuses to vouch for a locator pointing at an unreadable record", () => {
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(999999n, 8); // points past the buffer
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    const header = readZipHeader(Buffer.concat([locator, eocd]));
    expect(header?.entryCount).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("returns null for input that is not a ZIP", () => {
    expect(readZipHeader(Buffer.from("this is not a zip file"))).toBeNull();
    expect(readZipHeader(Buffer.alloc(0))).toBeNull();
    expect(readZipHeader(Buffer.from("AAAA", "base64"))).toBeNull();
  });

  it("does not throw on truncated or corrupt input", () => {
    const real = realZip(3);
    for (const cut of [1, 10, 21, 40, real.length - 1]) {
      expect(() => readZipHeader(real.subarray(0, cut))).not.toThrow();
    }
    expect(() => readZipHeader(Buffer.alloc(200, 0xff))).not.toThrow();
  });

  it("finds the record even with a trailing archive comment", () => {
    const zip = new AdmZip();
    zip.addFile("a.ts", Buffer.from("export const a = 1;\n"));
    const base = zip.toBuffer();
    const comment = Buffer.from("x".repeat(500));
    const withComment = Buffer.concat([base, comment]);
    withComment.writeUInt16LE(comment.length, base.length - 2);
    expect(readZipHeader(withComment)?.entryCount).toBe(1);
  });
});
