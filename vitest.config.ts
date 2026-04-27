import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { holdMusicTracksPlugin } from './client/vite/holdMusicTracksPlugin';

export default defineConfig({
  plugins: [holdMusicTracksPlugin(resolve(__dirname, 'client/public/music'))],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
