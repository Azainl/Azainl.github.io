import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import icon from 'astro-icon';

export default defineConfig({
  site: 'https://azainl.github.io',
  integrations: [sitemap(), icon()],
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  markdown: {
    shikiConfig: {
      theme: {
        light: 'github-light',
        dark: 'github-dark',
      },
    },
  },
});
