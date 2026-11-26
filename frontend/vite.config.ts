import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), {
    name: 'go-embed-placeholder',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '.gitkeep', source: '' });
    },
  }, {
    name: 'local-development-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        // React Refresh injects an inline preamble in development only.
        return context.server ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : html;
      },
    },
  }],
  clearScreen: false,
  server: { host: '127.0.0.1', strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
