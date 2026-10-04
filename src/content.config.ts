// Astro 7 移除了 legacy content collections（`type: 'content'`），
// 改用 Content Layer API：必须显式给一个 loader。
// `z` 也从 `astro:content` 挪到了 `astro/zod`。
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  // 文件的 slug 由文件名推导，与旧的 `type: 'content'` 行为一致
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    /** 精选：首页「精选文章」区块展示用，最多 2～3 篇 */
    featured: z.boolean().default(false),
  }),
});

export const collections = { posts };
