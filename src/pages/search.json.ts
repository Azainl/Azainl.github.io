import { getCollection } from 'astro:content';

/** 把 Markdown 正文转成适合搜索的纯文本 */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[^\n]*\n?/g, ' ') // 去掉代码围栏标记，保留代码内容
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片保留 alt 文字
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接保留文字
    .replace(/^#{1,6}\s*/gm, '') // 标题符号
    .replace(/^>\s?/gm, '') // 引用符号
    .replace(/^[-*+]\s+/gm, '') // 无序列表符号
    .replace(/^\d+\.\s+/gm, '') // 有序列表符号
    .replace(/(\*\*|__|\*|_|`|~~)/g, '') // 强调、行内代码、删除线
    .replace(/\|/g, ' ') // 表格竖线
    .replace(/<[^>]+>/g, ' ') // HTML 标签
    .replace(/\s+/g, ' ') // 压缩空白
    .trim();
}

export async function GET() {
  const posts = (
    await getCollection('posts', ({ data }) => !data.draft)
  ).sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());

  const items = posts.map((post) => ({
    slug: post.slug,
    title: post.data.title,
    description: post.data.description,
    date: post.data.date.toISOString(),
    tags: post.data.tags,
    content: stripMarkdown(post.body),
  }));

  return new Response(JSON.stringify(items), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
