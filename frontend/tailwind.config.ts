import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { ink: 'var(--ink)', teal: 'var(--teal)', canvas: 'var(--canvas)' },
      fontFamily: { sans: ['Segoe UI', '-apple-system', 'BlinkMacSystemFont', 'Arial', 'sans-serif'] },
    },
  },
  plugins: [],
} satisfies Config;
