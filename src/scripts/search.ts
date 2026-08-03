/** 全站搜索共享逻辑：页头搜索框与 /search/ 页面共用 */

export interface PostIndex {
  slug: string;
  title: string;
  description: string;
  date: string;
  tags: string[];
  content: string;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把匹配到的关键词包进 <mark>，其余部分作为文本节点，避免 HTML 注入 */
export function highlight(node: HTMLElement, text: string, query: string): void {
  const re = new RegExp(`(${escapeRegExp(query)})`, 'ig');
  const frag = document.createDocumentFragment();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    }
    const mark = document.createElement('mark');
    mark.textContent = m[0];
    frag.appendChild(mark);
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    frag.appendChild(document.createTextNode(text.slice(last)));
  }
  node.replaceChildren(frag);
}

export function formatDateCn(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function snippet(content: string, query: string): string {
  const i = content.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return '';
  const start = Math.max(0, i - 40);
  const end = Math.min(content.length, i + query.length + 60);
  return (
    (start > 0 ? '…' : '') +
    content.slice(start, end).trim() +
    (end < content.length ? '…' : '')
  );
}

export function searchIndex(
  index: PostIndex[],
  query: string,
): { post: PostIndex; rank: number; contentHit: boolean }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { post: PostIndex; rank: number; contentHit: boolean }[] = [];
  for (const post of index) {
    const titleHit = post.title.toLowerCase().includes(q);
    const descHit = post.description.toLowerCase().includes(q);
    const tagHit = post.tags.join(' ').toLowerCase().includes(q);
    const contentHit = post.content.toLowerCase().includes(q);
    if (!titleHit && !descHit && !tagHit && !contentHit) continue;
    let rank = 1;
    if (titleHit) rank += 4;
    else if (descHit) rank += 3;
    else if (tagHit) rank += 2;
    scored.push({ post, rank, contentHit });
  }
  scored.sort(
    (a, b) => b.rank - a.rank || b.post.date.localeCompare(a.post.date),
  );
  return scored;
}

let cached: Promise<PostIndex[]> | null = null;

/** 拉取搜索索引（带缓存） */
export function buildIndex(): Promise<PostIndex[]> {
  if (!cached) {
    cached = fetch('/search.json')
      .then((res) => (res.ok ? res.json() : []))
      .catch(() => []);
  }
  return cached;
}
