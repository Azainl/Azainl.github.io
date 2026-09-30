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
