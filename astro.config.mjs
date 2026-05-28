// astro.config.mjs
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// `site` is used for absolute URL resolution (Open Graph image meta tags).
// Override at build time with PUBLIC_SITE_URL=https://when.your-domain.com
// so og:image tags in production point at the real host.
const site = process.env.PUBLIC_SITE_URL || 'http://localhost:4321';

export default defineConfig({
  site,
  output: 'static',
  // No adapter - pure static build. Cloudflare Pages serves dist/ directly.
  vite: {
    plugins: [tailwindcss()],
  },
});
