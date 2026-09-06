import { defineCollection, z } from 'astro:content';

const posts = defineCollection({
  type: 'content',
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
