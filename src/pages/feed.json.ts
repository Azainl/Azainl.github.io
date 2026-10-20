/**
 * JSON Feed 1.1：/feed.json
 *
 * 与 /rss.xml 内容等价，只是格式不同。JSON Feed 是 RSS 的现代替代，
 * 字段更直白（没有 XML 命名空间、没有 CDATA），消费方解析成本更低。
 *
 * 条目集合、条目顺序、哪几篇带全文，三者都严格跟随 /rss.xml —— 唯一的差别是
 * 全文放在 `content_html` 而不是 `<content:encoded>`。
 *
 * 两个容易写错的地方：
 * 1. date_published / date_modified 必须是 RFC 3339，用 toISOString()；
 *    沿用 RSS 那边的 toUTCString() 会产出 "Sun, 19 Oct 2026 00:00:00 GMT"，
 *    不符合规范的 date-time 类型（要求 T 分隔）。
 * 2. 静态构建会丢弃端点返回的 Content-Type 头，扩展名才是最终类型依据；
 *    所以这个文件必须存在为 .json（Pages 会给 application/json）。
 */
import type { APIRoute } from 'astro';
import { SITE } from '../consts';
import { FEED_FULLTEXT_LIMIT, absolutize, renderContents } from '../utils/feed';
import { getPublishedPosts, lastModified } from '../utils/posts';

export const GET: APIRoute = async ({ site }) => {
  // 与 /rss.xml 同口径（见 src/utils/feed.ts 的 FEED_FULLTEXT_LIMIT 注释）：
  // 条目覆盖**全部**已发布文章，只有最近 FEED_FULLTEXT_LIMIT 篇带 content_html，
  // 其余只有 summary。两个订阅源对「哪几篇有全文」的判断必须一致，
  // 否则同一篇文章在 RSS 里是摘要、在 JSON Feed 里是全篇，读起来像两个站。
  const posts = await getPublishedPosts();
  const contents = await renderContents(posts.slice(0, FEED_FULLTEXT_LIMIT), site!);
  const base = site!.href;

  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: SITE.title,
    home_page_url: base,
    feed_url: new URL('/feed.json', site).href,
    description: SITE.description,
    language: SITE.locale,
    authors: [{ name: SITE.author }],
    items: posts.map((post) => {
      const url = new URL(`/posts/` + post.id + '/', site).href;
      const content = contents?.get(post.id);
      return {
        id: url,
        url,
        title: post.data.title,
        summary: post.data.description,
        ...(content ? { content_html: absolutize(content, base) } : {}),
        date_published: post.data.date.toISOString(),
        // 与 RSS 的 lastModified 同一口径（updated 仅在晚于 date 时生效），
        // 否则同一篇文章在两个订阅源里的“更新时间”会互相矛盾。
        date_modified: lastModified(post).toISOString(),
        tags: post.data.tags,
      };
    }),
  };

  return new Response(JSON.stringify(feed), {
    headers: { 'Content-Type': 'application/feed+json; charset=utf-8' },
  });
};
