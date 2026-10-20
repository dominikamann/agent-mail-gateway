/** Deterministic checks for attachments that can run code or hide what they are. Pure; no I/O. */

/** Lower-case extension; trailing dots and spaces are dropped, as Windows does ("a.vbs."). */
const extension = (name: string) =>
  /\.([^./\\]+)$/.exec(name.toLowerCase().replace(/[.\s]+$/, ''))?.[1] ?? '';

const startsWith = (content: Buffer, ...bytes: number[]) =>
  content.length >= bytes.length && bytes.every((b, i) => content[i] === b);

/** Windows, Linux and macOS programs, and scripts with a #! line. */
function isProgram(content: Buffer): boolean {
  return (
    startsWith(content, 0x4d, 0x5a) || // MZ: Windows .exe/.dll
    startsWith(content, 0x7f, 0x45, 0x4c, 0x46) || // ELF
    startsWith(content, 0xcf, 0xfa, 0xed, 0xfe) || // Mach-O 64-bit
    startsWith(content, 0xce, 0xfa, 0xed, 0xfe) ||
    startsWith(content, 0xca, 0xfe, 0xba, 0xbe) || // Mach-O universal (also Java class)
    startsWith(content, 0x23, 0x21) // #!
  );
}

const isZip = (content: Buffer) => startsWith(content, 0x50, 0x4b, 0x03, 0x04);
/** Also an empty archive (only the end record). */
const zipLike = (c: Buffer) => isZip(c) || startsWith(c, 0x50, 0x4b, 0x05, 0x06);

/** The image type from the first bytes (PNG, JPEG, GIF, WebP, BMP, TIFF, HEIC/AVIF), or null. */
export function imageType(c: Buffer): string | null {
  const head = c.subarray(0, 12).toString('latin1');
  if (startsWith(c, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (startsWith(c, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (head.startsWith('GIF8')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.startsWith('BM')) return 'image/bmp';
  if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return 'image/tiff';
  if (head.slice(4, 8) === 'ftyp') return 'image/heic';
  return null;
}
const isImage = (c: Buffer) => imageType(c) !== null;

/** Compound file (OLE): old Office formats, and password-protected docx/xlsx/pptx. */
const isCfb = (c: Buffer) => startsWith(c, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const officeLike = (c: Buffer) => zipLike(c) || isCfb(c);

/**
 * What a file with this extension must contain; files that don't are disguised. Images only
 * need to be some image: a PNG named .jpg is common and harmless.
 */
const SIGNATURES: Record<string, (c: Buffer) => boolean> = {
  pdf: (c) => c.subarray(0, 1024).includes('%PDF'),
  png: isImage,
  jpg: isImage,
  jpeg: isImage,
  gif: isImage,
  webp: isImage,
  zip: zipLike,
  docx: officeLike,
  xlsx: officeLike,
  pptx: officeLike,
  odt: zipLike,
  ods: zipLike,
};

interface ZipEntry {
  name: string;
  encrypted: boolean;
}

/**
 * File names and encryption flags from a ZIP's central directory, found via the end record
 * (no decompression). Null if the directory cannot be read (damaged, or Zip64).
 */
function zipEntries(content: Buffer): ZipEntry[] | null {
  // The end record is in the last 22 bytes plus a comment of up to 64 KiB.
  const end = content.lastIndexOf('PK\x05\x06', content.length, 'latin1');
  if (end < 0 || end < content.length - 22 - 0xffff || end + 22 > content.length) return null;
  const count = content.readUInt16LE(end + 10);
  const offset = content.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) return null; // Zip64
  const out: ZipEntry[] = [];
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > content.length || content.readUInt32LE(at) !== 0x02014b50) return null;
    const flags = content.readUInt16LE(at + 8);
    const nameLength = content.readUInt16LE(at + 28);
    const extraLength = content.readUInt16LE(at + 30);
    const commentLength = content.readUInt16LE(at + 32);
    if (at + 46 + nameLength > content.length) return null;
    out.push({
      name: content.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      encrypted: (flags & 1) === 1,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/**
 * Why this attachment is dangerous, or null. Looks at the name, the first bytes and, for ZIP
 * based files (zip, docx, xlsx, ...), the names of the files inside.
 */
export function dangerousAttachment(
  filename: string,
  content: Buffer,
  blockedExtensions: readonly string[],
): string | null {
  const blocked = new Set(blockedExtensions);
  const ext = extension(filename);
  if (blocked.has(ext)) return `${filename}: .${ext} files can run code`;
  if (isProgram(content)) return `${filename}: the file is a program or script`;
  const expected = SIGNATURES[ext];
  if (expected && !expected(content)) {
    return `${filename}: the content is not a .${ext} file (disguised file type)`;
  }
  if (isZip(content)) {
    const entries = zipEntries(content);
    if (!entries) return `${filename}: damaged or Zip64 archive; its content cannot be checked`;
    if (entries.some((e) => e.encrypted)) {
      return `${filename}: password-protected archive; its content cannot be checked`;
    }
    if (entries.some((e) => /(^|\/)vbaProject\.bin$/i.test(e.name))) {
      return `${filename}: the document contains macros`;
    }
    const inner = entries.find((e) => blocked.has(extension(e.name)));
    if (inner) return `${filename}: contains ${inner.name}, which can run code`;
  }
  return null;
}
