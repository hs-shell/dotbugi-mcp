// dotbugi src/lib/generateKey.ts makeVodKey·makeItemKey 와 같은 키
export const vodKey = (courseId: string, vod: { title: string; week: number }) =>
  `${courseId}-${vod.title}-${vod.week}`;
export const itemKey = (courseId: string, item: { title: string; dueDate: string | null }) =>
  `${courseId}-${item.title}-${item.dueDate ?? ''}`;

// dotbugi src/lib/deduplicateInto.ts 처럼 같은 키는 처음 것만 남긴다
export function uniqueBy<T>(list: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
