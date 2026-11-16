import { resolve } from 'node:path';

export default {
  base: '',
  server: {
    host: true,
    port: 5931,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 5932,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve('index.html'),
        export: resolve('export/index.html'),
      },
    },
  },
};
