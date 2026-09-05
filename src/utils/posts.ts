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
