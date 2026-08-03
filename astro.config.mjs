import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://azainl.github.io',
  integrations: [sitemap()],
  markdown: {
    shikiConfig: {
      theme: {
        light: 'github-light',
        dark: 'github-dark',
      },
    },
  },
});
