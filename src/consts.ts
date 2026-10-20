export const SITE = {
  name: 'Azain',
  title: '山月 · 个人博客',
  description: '一个关于代码、阅读与生活的个人博客。',
  author: 'Azain',
  email: '2013386765@qq.com',
  locale: 'zh-CN',
};
// 站点域名不在这里配置：构建真正使用的是 astro.config.mjs 的 `site`，
// RSS / sitemap / canonical / og:url 全部由 Astro.site 派生。
// 这里曾经有一个从未被任何代码引用的 `url` 字段，两处配置容易只改一处，
// 已删除以保持单一事实来源。改域名请改 astro.config.mjs。

/**
 * 全站翻页的单一事实来源：首页「最近文章」与 /page/N/ 分页页共用同一个值。
 * 首页第 1 页 = /，第 2 页起 = /page/N/，Archive 组件的链接契约
 * （pageUrl(1)='/'、pageUrl(n)='/page/n/'）要求所有页 perPage 一致，
 * 否则总页数、切片范围、上一页/下一页目标会全面错位。
 * 取值 6 兼顾规格书「最近文章 5～8 篇」的要求。
 */
export const PER_PAGE = 6;

/**
 * 订阅源里**带全文**的文章数。
 *
 * 这里曾经是 `FEED_LIMIT = 30`，语义是「feed 里最多放 30 篇」。那条路有个
 * 隐蔽的后果：截断的是**条目**，于是排在 30 名之外的旧文章直接不进订阅流。
 * 现在把「条数」和「全文」拆成两件独立的事：
 *
 *   ① **条目数不设上限**，覆盖订阅源对应的全部已发布文章；
 *   ② **全文只给最近 FEED_FULLTEXT_LIMIT 篇**，更旧的条目降级成摘要。
 *
 * 取 20 的依据：全文条目单条约 4 KB，20 条约 80 KB —— 正好是「阅读器一次轮询
 * 能舒服拿完」的量级；翻倍到 40 篇会让每次轮询白拉 160 KB。
 * 12 个标签与 1 个系列的已发布文章数全部 ≤ 11，因此这个阈值对子 feed
 * 天然不生效，订阅者拿到的是该标签/系列的**全量**全文。
 *
 * 放在 consts（纯常量模块）而不是 utils/feed（会 import Astro 的 RSS 与渲染器），
 * 是为了让 nav.json / 订阅页这些只需要数字的地方不必拖入整套 feed 运行时。
 */
export const FEED_FULLTEXT_LIMIT = 20;
