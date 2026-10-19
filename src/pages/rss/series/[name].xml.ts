/**
 * 按系列的子订阅源：/rss/series/<slug>.xml
 *
 * 系列与标签的差别在顺序：系列是有阅读顺序的，所以这里用 getSeriesPosts
 * （按 seriesOrder 升序）而不是按日期倒序 —— 订阅一个系列的人想按顺序读。
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { SITE } from '../../../consts';
import { seriesName, seriesSlug } from '../../../data/series';
import { SUB_FEED_LIMIT, feedResponse } from '../../../utils/feed';
import { getPublishedPosts } from '../../../utils/posts';
import { getSeriesPosts, getUsedSeries } from '../../../utils/series';

export const getStaticPaths: GetStaticPaths = async () => {
  const posts = await getPublishedPosts();
  const series = getUsedSeries(posts);
  return [...series.keys()].map((name) => ({ params: { name: seriesSlug(name) } }));
};

export const GET: APIRoute = async ({ params, site }) => {
  const name = seriesName(params.name!);
  const posts = getSeriesPosts(await getPublishedPosts(), name);

  return feedResponse({
    site: site!,
    posts,
    limit: SUB_FEED_LIMIT,
    selfUrl: new URL(`/rss/series/${params.name}.xml`, site).href,
    title: `${name} · ${SITE.title}`,
    description: `「${name}」系列的全部文章，按阅读顺序排列，来自 ${SITE.title}。`,
  });
};
