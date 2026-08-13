import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  // Platform modules resolve from the client-modules loader table at runtime;
  // inline nothing shared. Host half keeps harness packages external too
  // (they resolve from the profile/installation node_modules).
  external: [
    /^@deepseek-ai\//,
    /^react($|\/)/,
    /^react-dom($|\/)/,
  ],
})
