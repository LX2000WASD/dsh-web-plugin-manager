/**
 * Client bundle build (mirrors the official clientConfig preset in
 * deepseek-harness/packages/client/tsdown.client.ts): the bundle is CJS
 * wrapped in a __ModuleLoader__.load({ id, factory }) handoff — the
 * client-modules contract. Without the handoff the loader reports
 * "loaded without registering <id> via __ModuleLoader__.load".
 * React rides the platform module table (external); everything else
 * (our own modules, type-only @deepseek-ai imports) inlines.
 */
import { defineConfig } from 'tsdown'

// Mirrors the official PLATFORM_MODULES seed table
// (deepseek-harness/packages/client/web/src/platform.ts). Anything on the
// table MUST stay external: the shell shares one frozen instance, and
// inlining a second copy splits module identity. Anything off the table must
// NOT be external — a require() the seed table cannot answer throws
// "missed the module table" and aborts the whole client boot.
const PLATFORM = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

export default defineConfig({
  name: 'dsh-web-plugin-manager/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'dist',
  format: 'cjs',
  platform: 'browser',
  // Types ship from tsc (tsconfig.client.json); dts here would wrap the
  // banner/footer into .d.cts and break parsing (official note).
  dts: false,
  clean: false,
  sourcemap: false,
  external: PLATFORM,
  // Everything not on the platform table inlines (no shared identity).
  noExternal: (id: string) => (PLATFORM.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    // The handoff: register this bundle's factory with the client-modules
    // loader; externals resolve through the injected require (module table).
    banner: 'window.__ModuleLoader__.load({ id: "dsh-web-plugin-manager", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
