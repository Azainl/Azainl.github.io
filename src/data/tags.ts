/** 各标签的一句话描述，显示在标签页上；未收录的标签使用默认描述 */
export const TAG_DESCRIPTIONS: Record<string, string> = {
  随笔: '生活中的零散想法与记录',
  思考: '对技术、写作与生活的思考',
  阅读: '读书笔记与阅读记录',
  前端: '前端开发相关内容',
  Astro: 'Astro 框架相关实践',
  写作: '写作方法与长期练习',
  工具: '效率工具与使用技巧',
  效率: '让工作更高效的方法',
  性能优化: '页面加载与构建产物的优化实践',
};

export function tagDescription(tag: string): string {
  return TAG_DESCRIPTIONS[tag] ?? '关于该主题的文章';
}
