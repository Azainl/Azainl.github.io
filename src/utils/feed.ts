import rss, { type RSSFeedItem } from '@astrojs/rss';
import { render } from 'astro:content';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { FEED_FULLTEXT_LIMIT, SITE } from '../consts';
import { lastModified, type Post } from './posts';

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
 * 三条容易踩的坑：
 * 1. `link` 用 `new URL()` + `site`（绝对 URL），**不能**用 `src/utils/url.ts`
 *    的 `url()` —— 那个是拼 BASE 相对路径的，喂给订阅源会得到站内路径。
 * 2. `contents` 为 `null`（渲染失败）时**完全不产出** `content` 字段。
 * 3. `contents` 是 Map 但**不含这一篇**时，同样不能产出 `content: undefined` ——
 *    @astrojs/rss 判定的是 `item.content` 的真值，但序列化时
 *    `typeof result.content === 'string'` 才写 `<content:encoded>`；
 *    给个 undefined 虽然不会写出空标签，却会让「这篇是摘要档」的意图藏在类型里。
 *    所以这里按篇判断，只有真正拿到 HTML 的才带 content 字段。
 */
export function toRssItems(
  posts: Post[],
  contents: Map<string, string> | null,
  site: URL,
): RSSFeedItem[] {
  return posts.map((post) => {
    const content = contents?.get(post.id);
    return {
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.description,
      link: new URL(`/posts/${post.id}/`, site).href,
      categories: post.data.tags,
      ...(content ? { content } : {}),
    };
  });
}

/**
 * 组装一个完整的 RSS 响应。
 *
 * 主 feed（/rss.xml）与 13 个子 feed（按标签 / 按系列）只在这几个参数上不同：
 * 文章集合、全文条数上限、标题、以及自引用地址。把这层差异抽成一个函数，
 * 避免四份端点各写一遍 rss({...}) 而让字段口径（xmlns、customData、limit）
 * 在之后的修改中悄悄漂移。
 *
 * 注意这里**没有**「条目数上限」参数：条目永远覆盖 `posts` 全部。
 * `fulltextLimit` 只决定前多少篇带 <content:encoded>，其余降级为摘要。
 *
 * `selfUrl` 给了才声明 atom 命名空间并输出 <atom:link rel="self">：
 * 子 feed 地址不直观（/rss/tag/frontend.xml），阅读器与聚合服务靠这个字段
 * 知道"订阅的到底是什么地址"；主 feed 的地址就是 /rss.xml，历来不加。
 */
export async function feedResponse({
  site,
  posts,
  fulltextLimit = FEED_FULLTEXT_LIMIT,
  selfUrl,
  title = SITE.title,
  description = SITE.description,
}: {
  site: URL;
  posts: Post[];
  fulltextLimit?: number;
  selfUrl?: string;
  title?: string;
  description?: string;
}): Promise<Response> {
  // posts 已按日期倒序（getPublishedPosts 的契约），所以 slice 取到的正是「最近 N 篇」。
  // 只把这几篇渲染成 HTML，不白烧排在后面的文章的渲染时间 —— 它们本来就只出摘要。
  const fulltextPosts = posts.slice(0, fulltextLimit);
  const contents = await renderContents(fulltextPosts, site);
  // lastBuildDate 取**该 feed 的全部文章**，与条目覆盖面对齐。
  const lastBuildDate = feedLastBuildDate(posts);

  return rss({
    title,
    description,
    site,
    items: toRssItems(posts, contents, site),
    ...(selfUrl ? { xmlns: { atom: 'http://www.w3.org/2005/Atom' } } : {}),
    customData: feedCustomData({ selfUrl, lastBuildDate }),
  });
}
