/**
 * 把文章 slug 转成合法的 View Transition 名称（列表标题与文章标题共用）。
 * 中文等非 ASCII slug 清洗后会重复，因此统一追加短哈希保证唯一。
 */
export function vtName(slug: string): string {
  const safe = slug
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return `post-${safe || 'x'}-${hash.toString(36)}`;
}
