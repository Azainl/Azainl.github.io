import { getPublishedPosts } from '../utils/posts';

/** 把 Markdown 正文转成适合搜索的纯文本 */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ') // 成对剔除代码块（含闭合围栏）
    .replace(/`[^`]*`/g, ' ') // 行内代码
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
  const posts = await getPublishedPosts();

  const items = posts.map((post) => ({
    slug: post.slug,
    title: post.data.title,
    description: post.data.description,
    date: post.data.date.toISOString(),
    tags: post.data.tags,
    // 索引只需要够搜索用，正文截断避免文件随文章数线性膨胀
    content: stripMarkdown(post.body).slice(0, 2000),
  }));

  return new Response(JSON.stringify(items), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
