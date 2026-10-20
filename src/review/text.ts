/** Invisible format characters (zero-width etc.) that could split words for the model. */
export const stripInvisible = (text: string) => text.replace(/\p{Cf}/gu, '');

/** Splits text into overlapping parts so nothing is lost at a boundary. */
export function chunks(text: string, size: number, overlapChars: number): string[] {
  if (text.length <= size) return [text];
  const overlap = Math.min(overlapChars, Math.floor(size / 2));
  const out: string[] = [];
  for (let start = 0; start < text.length; start += size - overlap) {
    out.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return out;
}
