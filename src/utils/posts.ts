import { getCollection, type CollectionEntry } from 'astro:content';
import { OG_SLUGS } from '../data/og-manifest';

export type Post = CollectionEntry<'posts'>;

/**
 * 文章的最后修订时间 —— 全站唯一口径。
 *
 * `updated` 是可选字段，目前有三处消费方：文章页的「更新于」、JSON-LD 的
 * `dateModified`、RSS 的 `lastBuildDate`。它们都必须走这个函数，不要各自写
 * `updated ?? date`：一旦有人填了早于 `date` 的 `updated`，各自回退就会出现
 * 「更新于」早于发布日、`dateModified < datePublished` 这类无效数据。
 * 这里统一保证返回值永不早于 `date`。
 */
export function lastModified(post: Post): Date {
  const updated = post.data.updated;
  return updated && updated > post.data.date ? updated : post.data.date;
}

const ogSlugs = new Set(OG_SLUGS);

/**
 * 文章分享卡片（og:image）的站内路径。
 *
 * 分享图由 `npm run og` 预生成到 `public/og/<slug>.png` 并提交进仓库，
 * 不走构建期生成——这样 CI 既不需要 sharp，也不需要中文字体
 * （GitHub Actions 的 ubuntu runner 默认没有 CJK 字体，中文会渲染成方框）。
 *
 * 清单缺失该 slug 时回退到全站默认图，避免 meta 指向一张 404 的图片。
 * 新增文章后忘了跑 `npm run og` 只会退化成通用卡片，不会坏。
 */
export function ogImagePath(post: Post): string {
  return ogSlugs.has(post.id) ? `/og/${post.id}.png` : '/og.png';
}

const TZ = 'Asia/Shanghai';

/**
 * 全站统一的「已发布文章」列表，替换散落在各页面里的 getCollection + sort。
 *
 * - 生产环境：排除 draft，也排除未来日期（date 大于构建时刻的文章不上线）
 * - 开发环境：只看 draft，未来日期的文章照常显示，方便本地预览定时发布
 * - 排序：日期倒序；同日按 id（即文件名）兜底，保证不同机器上构建出的顺序一致
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
      a.id.localeCompare(b.id),
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
    .filter((post) => post.id !== current.id)
    .map((post) => {
      const shared = post.data.tags.filter((tag) => tags.has(tag)).length;
      return { post, score: shared + (post.data.featured ? 0.5 : 0) };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.post.data.date.valueOf() - a.post.data.date.valueOf() ||
        a.post.id.localeCompare(b.post.id),
    )
    .slice(0, limit)
    .map((entry) => entry.post);
}

/** 取某篇文章在列表里的前后邻居（列表是倒序的，所以 newer 在 older 前面） */
export function getNeighbors(
  posts: Post[],
  slug: string,
): { newer: Post | null; older: Post | null } {
  const i = posts.findIndex((post) => post.id === slug);
  if (i < 0) return { newer: null, older: null };
  return {
    newer: i > 0 ? posts[i - 1] : null,
    older: i < posts.length - 1 ? posts[i + 1] : null,
  };
}

export { TZ };
