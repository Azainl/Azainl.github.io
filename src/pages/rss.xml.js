import rss from '@astrojs/rss';
import { SITE } from '../consts';
import { getPublishedPosts } from '../utils/posts';
import {
  FEED_LIMIT,
  feedCustomData,
  feedLastBuildDate,
  renderContents,
  toRssItems,
} from '../utils/feed';

export async function GET(context) {
  const posts = await getPublishedPosts();
  const site = context.site;

  // 全文输出：把每篇正文渲染成 HTML 交给 @astrojs/rss 的 item.content ——
  // 只要任一 item 带了 content，它就会自动加上 content 命名空间并输出
  // <content:encoded>。渲染失败时 renderContents 返回 null，整体回退成只输出摘要。
  //
  // 只渲染真正会进 feed 的那批文章：以前是全量渲染再 slice，白烧了
  // 排在第 30 名之后的那些篇的渲染时间。产物完全相同（feedPosts ⊂ posts）。
  const feedPosts = posts.slice(0, FEED_LIMIT);
  const contents = await renderContents(feedPosts, site);

  const lastBuildDate = feedLastBuildDate(posts);

  return rss({
    title: SITE.title,
    description: SITE.description,
    site,
    items: toRssItems(feedPosts, contents, site),
    // 主 feed 不加 atom:link self：它的地址就是 /rss.xml，第 3 方阅读器不会去
    // 解析这个字段，加了只会让产物与历史基线不一致（T-25 要求逐字节不变）。
    customData: feedCustomData({ lastBuildDate }),
  });
}
