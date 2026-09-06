import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'>;

const TZ = 'Asia/Shanghai';

/**
 * 全站统一的「已发布文章」列表，替换散落在各页面里的 getCollection + sort。
 *
 * - 生产环境：排除 draft，也排除未来日期（date 大于构建时刻的文章不上线）
 * - 开发环境：只看 draft，未来日期的文章照常显示，方便本地预览定时发布
 * - 排序：日期倒序；同日按 slug 兜底，保证不同机器上构建出的顺序一致
 */
export async function getPublishedPosts(): Promise<Post[]> {
  const prod = import.meta.env.PROD;
  const now = new Date();

  const posts = await getCollection('posts', ({ data }) => {
    if (prod && data.draft) return false;
    if (prod && data.date > now) return false;
    return true;
  });

  return posts.sort(
    (a, b) =>
      b.data.date.valueOf() - a.data.date.valueOf() ||
      a.slug.localeCompare(b.slug),
  );
}

/** 首页「精选文章」：frontmatter 里 featured: true 的文章，按日期倒序 */
export function getFeaturedPosts(posts: Post[], limit = 3): Post[] {
  return posts.filter((post) => post.data.featured).slice(0, limit);
}

/**
 * 相关文章：按「共同标签数」打分，同分用日期倒序，featured 给一点额外权重。
 * 只是简单加权，不引入任何推荐系统或 AI 依赖。
 */
export function getRelatedPosts(
  posts: Post[],
  current: Post,
  limit = 3,
): Post[] {
  const tags = new Set(current.data.tags);
  // 没有标签就无从计算相关性，直接返回空（页面会整块隐藏，不留空标题）
  if (tags.size === 0) return [];

  return posts
    .filter((post) => post.slug !== current.slug)
    .map((post) => {
      const shared = post.data.tags.filter((tag) => tags.has(tag)).length;
      return { post, score: shared + (post.data.featured ? 0.5 : 0) };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.post.data.date.valueOf() - a.post.data.date.valueOf() ||
        a.post.slug.localeCompare(b.post.slug),
    )
    .slice(0, limit)
    .map((entry) => entry.post);
}

/** 取某篇文章在列表里的前后邻居（列表是倒序的，所以 newer 在 older 前面） */
export function getNeighbors(
  posts: Post[],
  slug: string,
): { newer: Post | null; older: Post | null } {
  const i = posts.findIndex((post) => post.slug === slug);
  if (i < 0) return { newer: null, older: null };
  return {
    newer: i > 0 ? posts[i - 1] : null,
    older: i < posts.length - 1 ? posts[i + 1] : null,
  };
}

export { TZ };
