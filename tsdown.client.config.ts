import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    client: 'src/client/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: false,
  external: [/^@deepseek-ai\//, /^react($|\/)/, /^react-dom($|\/)/],
})
