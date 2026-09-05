import rss from '@astrojs/rss';
import { SITE } from '../consts';
import { getPublishedPosts } from '../utils/posts';

export async function GET(context) {
  const posts = await getPublishedPosts();

  return rss({
    title: SITE.title,
    description: SITE.description,
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.description,
      link: new URL(`/posts/${post.slug}/`, context.site).href,
      categories: post.data.tags,
    })),
    customData: '<language>zh-cn</language>',
    lastBuildDate: new Date(),
  });
}
