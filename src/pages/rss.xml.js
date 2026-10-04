import rss from '@astrojs/rss';
import { render } from 'astro:content';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { SITE } from '../consts';
import { getPublishedPosts, lastModified } from '../utils/posts';

/**
 * 订阅源里保留的文章数上限。
 *
 * 本站输出的是**全文**订阅（`content:encoded`），每篇约 5 KB，而且阅读器每次
 * 轮询都会拉整个 feed —— 不设上限的话它会随文章数线性膨胀：
 * 28 篇 140 KB，到 100 篇就是约 500 KB（gzip 115 KB）。
 * 截断后体积恒定，旧文章仍然可以从站点上读到，只是不再进订阅流。
 *
 * 调大/调小都只影响 `rss.xml`，不影响页面、sitemap 或搜索索引。
 */
const FEED_LIMIT = 30;

/**
 * 把正文里的站内绝对路径补成完整 URL。
 * RSS 阅读器渲染的页面不在本站域下，`/images/x.jpg`、`/posts/xxx/` 这种
 * 以 / 开头的地址在阅读器里会解析到错误的域名而 404。
 */
function absolutize(html, site) {
  const base = site.replace(/\/+$/, '');
  // 只处理单个 / 开头（"//cdn..." 这类协议相对地址保持原样）
  return html.replace(/(\s(?:src|href)=")\/(?!\/)/g, `$1${base}/`);
}

export async function GET(context) {
  const posts = await getPublishedPosts();
  const site = context.site.href;

  // 全文输出：用 Astro 的 Container API 把每篇正文渲染成 HTML，交给
  // @astrojs/rss 的 item.content —— 只要任一 item 带了 content，
  // 它就会自动加上 content 命名空间并输出 <content:encoded>。
  //
  // 这一步是「锦上添花」，绝不能连累订阅源本身：任何一篇渲染失败就整体
  // 回退成只输出摘要（也就是没有该功能时的行为），RSS 依然可用。
  let contents = null;
  try {
    const container = await AstroContainer.create();
    contents = new Map();
    for (const post of posts) {
      const { Content } = await render(post);
      contents.set(post.id, absolutize(await container.renderToString(Content), site));
    }
  } catch (error) {
    contents = null;
    console.warn(
      '[rss] 正文渲染失败，本次只输出摘要（订阅源仍可用）：',
      error?.message ?? error,
    );
  }

  // 注意：`lastBuildDate` 不是 @astrojs/rss 的受支持选项——RSSOptions 里没有它，
  // 传进去会被 Zod 的 strip 静默丢弃（构建不报错，产物里也没有这个标签）。
  // 必须经 customData 注入 <channel>，它会被解析后合并进 channel 节点。
  //
  // 取值用「最新一篇文章的 updated/date」而不是构建时刻 new Date()：
  // 前者是确定性的（同样源码永远产出同样 feed），且只在内容真正变化时
  // 才让阅读器判定为更新；用构建时刻会让每次部署都触发一次"有新内容"。
  const lastBuildDate = posts.reduce(
    (latest, post) => {
      const date = lastModified(post);
      return date > latest ? date : latest;
    },
    new Date(0),
  );
  const customData =
    '<language>zh-cn</language>' +
    (lastBuildDate.getTime() > 0
      ? `<lastBuildDate>${lastBuildDate.toUTCString()}</lastBuildDate>`
      : '');

  // 只取最近的若干篇进订阅流（posts 已按日期倒序）
  const feedPosts = posts.slice(0, FEED_LIMIT);

  return rss({
    title: SITE.title,
    description: SITE.description,
    site: context.site,
    items: feedPosts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.description,
      link: new URL(`/posts/${post.id}/`, context.site).href,
      categories: post.data.tags,
      ...(contents ? { content: contents.get(post.id) } : {}),
    })),
    customData,
  });
}
