import { feedResponse } from '../utils/feed';
import { getPublishedPosts } from '../utils/posts';

export async function GET({ site }) {
  const posts = await getPublishedPosts();

  // 主 feed 就是 feedResponse 的默认形态：标题/描述取 SITE 全局值，不带 selfUrl。
  //
  // 这里不再切片 —— 条目覆盖**全部**已发布文章（32/32，曾经是 30/32，
  // hello-world 与 why-i-write 因此进不了订阅流）。体积靠「只有最近
  // FEED_FULLTEXT_LIMIT 篇带 <content:encoded>、其余降级为摘要」来控制，
  // 详见 src/consts.ts 里 FEED_FULLTEXT_LIMIT 的注释。
  //
  // 主 feed 不加 atom:link self：它的地址就是 /rss.xml，第 3 方阅读器不会去
  // 解析这个字段。子 feed 才需要，因为它们的地理解析不出含义。
  return feedResponse({ site, posts });
}
