/**
 * 页脚「随便看看」的数据源。
 *
 * 只收录**真正会生成页面**的文章：直接复用 getPublishedPosts()，
 * 因此 draft 与北京时间尚未到当天的文章自动排除，不会把读者送进 404。
 * 排序沿用站点的日期倒序，客户端不再排序；选择哪一篇由浏览器完成，
 * 这样静态站也能每次点击都换一篇。
 */
import type { APIRoute } from 'astro';
import { getPublishedPosts } from '../utils/posts';
import { url } from '../utils/url';

export const GET: APIRoute = async () => {
  const posts = await getPublishedPosts();
  const data = posts.map((post) => ({
    id: post.id,
    title: post.data.title,
    href: url(`/posts/${post.id}/`),
  }));

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
