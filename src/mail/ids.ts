export function encodeMessageId(uidValidity: string, uid: number): string {
  return `${uidValidity}-${uid}`;
}

export function decodeMessageId(id: string): { uidValidity: string; uid: number } | null {
  const match = /^(\d{1,20})-(\d{1,10})$/.exec(id);
  if (!match) return null;
  const uid = Number(match[2]);
  return uid > 0 ? { uidValidity: match[1]!, uid } : null;
}
