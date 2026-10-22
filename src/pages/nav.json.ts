/**
 * 页头命令面板的静态目标表（构建期产出，客户端按需拉取）。
 *
 * 为什么要在服务端生成而不是写死在 Header.astro 里：标签与系列的名字、slug、
 * 篇数全部来自 src/data 与内容集合，写死就等于在客户端维护第二份真相。
 * 这份表只有二十几条、几 KB，比把 TAGS/SERIES/TOPICS 整个打包进 JS 便宜得多。
 *
 * 与 tags/index.astro 同一口径：只收录**有已发布文章**的标签与系列，
 * 否则面板里会出现点进去空空如也的入口。
 */
import type { APIRoute } from 'astro';
import { FEED_FULLTEXT_LIMIT } from '../consts';
import { TAGS, tagSlug } from '../data/tags';
import { SERIES, seriesSlug } from '../data/series';
import { url } from '../utils/url';
import { getPublishedPosts } from '../utils/posts';
import { getUsedSeries } from '../utils/series';
import { resolveTopics } from '../utils/topics';

interface NavTarget {
  label: string;
  href: string;
  hint: string;
}

export const GET: APIRoute = async () => {
  const posts = await getPublishedPosts();

  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const usedSeries = getUsedSeries(posts);
  const usedTopics = resolveTopics(posts).filter((topic) => topic.posts.length > 0);

  // 页面这一组是人工挑选的「值得一键跳过去」的固定入口。
  // 分页页（/page/2..N/）刻意不列：它们不是目的地，翻页有更自然的路径。
  const pages: NavTarget[] = [
    { label: '首页', href: url('/'), hint: '全部文章，按时间倒序' },
    { label: '归档', href: url('/archive/'), hint: `按年份排列的 ${posts.length} 篇文章` },
    { label: '标签', href: url('/tags/'), hint: '按主题浏览' },
    { label: '关于', href: url('/about/'), hint: '这个站点与作者' },
    { label: '订阅', href: url('/subscribe/'), hint: 'RSS / JSON Feed / 按标签订阅' },
    { label: '搜索', href: url('/search/'), hint: '在全部正文里找' },
    {
      label: 'RSS 源',
      href: url('/rss.xml'),
      hint: `全部 ${posts.length} 篇，最近 ${FEED_FULLTEXT_LIMIT} 篇全文`,
    },
    { label: 'JSON Feed', href: url('/feed.json'), hint: '同样的内容，JSON Feed 1.1' },
  ];

  const tags: NavTarget[] = TAGS.filter((tag) => counts.has(tag.name)).map((tag) => ({
    label: tag.name,
    href: url(`/tags/${tagSlug(tag.name)}/`),
    hint: `${counts.get(tag.name) ?? 0} 篇`,
  }));

  const series: NavTarget[] = SERIES.filter((item) => usedSeries.has(item.name)).map((item) => ({
    label: item.name,
    href: url(`/series/${seriesSlug(item.name)}/`),
    hint: `${usedSeries.get(item.name)?.length ?? 0} 篇`,
  }));

  const topics: NavTarget[] = usedTopics.map((topic) => ({
    label: topic.meta.name,
    href: url(`/topics/${topic.meta.slug}/`),
    hint: `${topic.posts.length} 篇，按顺序读`,
  }));

  return new Response(JSON.stringify({ pages, tags, series, topics }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
