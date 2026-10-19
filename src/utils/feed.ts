import rss, { type RSSFeedItem } from '@astrojs/rss';
import { render } from 'astro:content';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { SITE } from '../consts';
import { lastModified, type Post } from './posts';

/**
 * 主订阅源（/rss.xml）保留的文章数上限。
 *
 * 本站输出的是**全文**订阅（`content:encoded`），每篇约 5 KB，而且阅读器每次
 * 轮询都会拉整个 feed —— 不设上限的话它会随文章数线性膨胀：
 * 28 篇 140 KB，到 100 篇就是约 500 KB（gzip 115 KB）。
 * 截断后体积恒定，旧文章仍然可以从站点上读到，只是不再进订阅流。
 *
 * 调大/调小都只影响 `rss.xml`，不影响页面、sitemap 或搜索索引。
 */
export const FEED_LIMIT = 30;

/**
 * 子订阅源（按标签 / 按系列）保留的文章数上限。
 *
 * 取 20 而不是 30：实测 12 个标签的已发布文章数全部低于 20，
 * 于是「截断」对子 feed 天然不生效 —— 每个标签的订阅者拿到的是该标签的**全量**文章。
 * 这也是对主 feed 截断缺陷的补偿：主 feed 只留最近 30 篇，随笔标签实有 5 篇，
 * 排在 30 名之外的 2 篇就进不了主 feed，但订阅者可以订 /rss/tag/essays.xml 拿全。
 */
export const SUB_FEED_LIMIT = 20;

/**
 * 把正文里的站内绝对路径补成完整 URL。
 * RSS 阅读器渲染的页面不在本站域下，`/images/x.jpg`、`/posts/xxx/` 这种
 * 以 / 开头的地址在阅读器里会解析到错误的域名而 404。
 */
export function absolutize(html: string, site: string): string {
  const base = site.replace(/\/+$/, '');
  // 只处理单个 / 开头（"//cdn..." 这类协议相对地址保持原样）
  return html.replace(/(\s(?:src|href)=")\/(?!\/)/g, `$1${base}/`);
}

/**
 * 用 Astro 的 Container API 把每篇正文渲染成 HTML，供 `content:encoded` 使用。
 *
 * 返回 Map（post.id → 已补全绝对路径的 HTML）；任一环节失败返回 `null`，
 * 调用方据此回退成「只输出摘要」。
 *
 * **这条回退路径是刻意的**：全文订阅是锦上添花，绝不能连累订阅源本身 ——
 * 以前这段 try/catch 就在端点里，抽出来时必须原样保留，且细节不能丢
 * （catch 里要 `console.warn`，否则构建日志里看不出 feed 悄悄退化了）。
 */
export async function renderContents(
  posts: Post[],
  site: URL,
): Promise<Map<string, string> | null> {
  const href = site.href;
  try {
    const container = await AstroContainer.create();
    const contents = new Map<string, string>();
    for (const post of posts) {
      const { Content } = await render(post);
      contents.set(
        post.id,
        absolutize(await container.renderToString(Content), href),
      );
    }
    return contents;
  } catch (error) {
    console.warn(
      '[rss] 正文渲染失败，本次只输出摘要（订阅源仍可用）：',
      (error as Error)?.message ?? error,
    );
    return null;
  }
}

/**
 * `<lastBuildDate>` 的取值：最新一篇文章的 updated/date。
 *
 * 不用构建时刻 `new Date()`：前者是确定性的（同样源码永远产出同样 feed，
 * 才能用 sha256 对比重构是否零差异），且只在内容真正变化时才让阅读器判定为更新；
 * 用构建时刻会让每次部署都触发一次「有新内容」。
 *
 * 没有任何文章时返回 `new Date(0)`，调用方据此省略该标签（RSS 规范允许）。
 */
export function feedLastBuildDate(posts: Post[]): Date {
  return posts.reduce((latest, post) => {
    const date = lastModified(post);
    return date > latest ? date : latest;
  }, new Date(0));
}

/**
 * 生成 `<channel>` 级的自定义字段串。
 *
 * `lastBuildDate` **不是** @astrojs/rss 的受支持选项 —— RSSOptions 里没有它，
 * 传进去会被 Zod 的 strip 静默丢弃（构建不报错，产物里也没有这个标签）。
 * 必须经 customData 注入 <channel>，它会被解析后合并进 channel 节点。
 *
 * `selfUrl` 给了才输出 `<atom:link rel="self">`；**调用方必须同时**在
 * `rss({ xmlns: { atom: ... } })` 里声明命名空间，否则是非法 XML。
 */
export function feedCustomData({
  selfUrl,
  lastBuildDate,
}: {
  selfUrl?: string;
  lastBuildDate: Date;
}): string {
  return (
    '<language>zh-cn</language>' +
    (lastBuildDate.getTime() > 0
      ? `<lastBuildDate>${lastBuildDate.toUTCString()}</lastBuildDate>`
      : '') +
    (selfUrl
      ? `<atom:link href="${selfUrl}" rel="self" type="application/rss+xml"/>`
      : '')
  );
}

/**
 * 把文章列表映射成 @astrojs/rss 的 item 数组。
 *
 * 两条容易踩的坑：
 * 1. `link` 用 `new URL()` + `site`（绝对 URL），**不能**用 `src/utils/url.ts`
 *    的 `url()` —— 那个是拼 BASE 相对路径的，喂给订阅源会得到站内路径。
 * 2. `contents` 为 `null`（渲染失败）时必须**完全不产出** `content` 字段，
 *    而不是产出 `content: undefined` —— 后者会让 @astrojs/rss 仍加上
 *    content 命名空间，产物里多一个空的 `<content:encoded>`。
 */
export function toRssItems(
  posts: Post[],
  contents: Map<string, string> | null,
  site: URL,
): RSSFeedItem[] {
  return posts.map((post) => ({
    title: post.data.title,
    pubDate: post.data.date,
    description: post.data.description,
    link: new URL(`/posts/${post.id}/`, site).href,
    categories: post.data.tags,
    ...(contents ? { content: contents.get(post.id) } : {}),
  }));
}

/**
 * 组装一个完整的 RSS 响应。
 *
 * 主 feed（/rss.xml）与 13 个子 feed（按标签 / 按系列）只在这几个参数上不同：
 * 文章集合、条数上限、标题、以及自引用地址。把这层差异抽成一个函数，
 * 避免四份端点各写一遍 rss({...}) 而让字段口径（xmlns、customData、limit）
 * 在之后的修改中悄悄漂移。
 *
 * `selfUrl` 给了才声明 atom 命名空间并输出 <atom:link rel="self">：
 * 子 feed 地址不直观（/rss/tag/frontend.xml），阅读器与聚合服务靠这个字段
 * 知道"订阅的到底是什么地址"；主 feed 的地址就是 /rss.xml，历来不加。
 */
export async function feedResponse({
  site,
  posts,
  limit = FEED_LIMIT,
  selfUrl,
  title = SITE.title,
  description = SITE.description,
}: {
  site: URL;
  posts: Post[];
  limit?: number;
  selfUrl?: string;
  title?: string;
  description?: string;
}): Promise<Response> {
  // 只渲染真正会进 feed 的那批文章，不白烧排在 limit 之后的渲染时间。
  const feedPosts = posts.slice(0, limit);
  const contents = await renderContents(feedPosts, site);
  // lastBuildDate 取**该 feed 的全部文章**（不是截断后的），
  // 与主 feed 的口径一致：被截掉的旧文章也是这个订阅源的一部分。
  const lastBuildDate = feedLastBuildDate(posts);

  return rss({
    title,
    description,
    site,
    items: toRssItems(feedPosts, contents, site),
    ...(selfUrl ? { xmlns: { atom: 'http://www.w3.org/2005/Atom' } } : {}),
    customData: feedCustomData({ selfUrl, lastBuildDate }),
  });
}
