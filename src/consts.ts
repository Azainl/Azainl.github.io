export const SITE = {
  name: 'Azain',
  title: '山月 · 个人博客',
  description: '一个关于代码、阅读与生活的个人博客。',
  author: 'Azain',
  email: '2013386765@qq.com',
  // 部署后替换为你的真实域名
  url: 'https://azainl.github.io',
  locale: 'zh-CN',
};

/**
 * 全站翻页的单一事实来源：首页「最近文章」与 /page/N/ 分页页共用同一个值。
 * 首页第 1 页 = /，第 2 页起 = /page/N/，Archive 组件的链接契约
 * （pageUrl(1)='/'、pageUrl(n)='/page/n/'）要求所有页 perPage 一致，
 * 否则总页数、切片范围、上一页/下一页目标会全面错位。
 * 取值 6 兼顾规格书「最近文章 5～8 篇」的要求。
 */
export const PER_PAGE = 6;
