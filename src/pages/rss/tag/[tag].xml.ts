/**
 * 按标签的子订阅源：/rss/tag/<slug>.xml
 *
 * 为什么不是 /rss/<slug>.xml：标签与系列两个动态段放在同一层时，路由模式都
 * 退化成 ([^/]+?)，会互相覆盖（后注册的那条赢）。分目录是唯一稳妥的写法。
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { SITE } from '../../../consts';
import { tagName, tagSlug } from '../../../data/tags';
import { feedResponse } from '../../../utils/feed';
import { getPublishedPosts } from '../../../utils/posts';

// 标签集合必须**从已发布文章反推**，不能直接用 TAGS 那张表：表里可能留着
// 一篇文章都没有的标签，那样会产出一个空 feed（列表页那边是同一个口径）。
export const getStaticPaths: GetStaticPaths = async () => {
  const posts = await getPublishedPosts();
  const tags = new Set(posts.flatMap((post) => post.data.tags));
  return [...tags].map((tag) => ({ params: { tag: tagSlug(tag) } }));
};

export const GET: APIRoute = async ({ params, site }) => {
  // 端点里拿不到 getStaticPaths 的 props（GET 的入参只有 params/request/site），
  // 所以只能用 slug 反查展示名。
  const name = tagName(params.tag!);
  const posts = (await getPublishedPosts()).filter((post) =>
    post.data.tags.includes(name),
  );

  // 不传 fulltextLimit，用默认值 20。这不构成截断：实测 12 个标签的已发布
  // 文章数全部 ≤ 11，所以每个标签子 feed 拿到的都是该标签的全量全文。
  // 条目数同样不设上限 —— 它与 tags/[tag].astro 列表页一一对应。
  return feedResponse({
    site: site!,
    posts,
    selfUrl: new URL(`/rss/tag/${params.tag}.xml`, site).href,
    title: `${name} · ${SITE.title}`,
    description: `只包含「${name}」标签的文章，来自 ${SITE.title}。`,
  });
};
