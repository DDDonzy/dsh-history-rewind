/**
 * tsdown config for dsh-history-rewind (standalone mirror of the
 * official packages/client/tsdown.client.ts preset).
 *
 * Node half: ESM bundles of src/index.ts + src/invariant.ts into lib/.
 * Client half: one CJS bundle wrapped in the shell's __ModuleLoader__ protocol
 * (lib/client.js), externalizing the platform module table and inlining the rest.
 */
import { defineConfig, type UserConfig } from 'tsdown'

const ID = 'dsh-history-rewind'

/** Shell module-table specifiers the client bundle must NOT inline. */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const lib: UserConfig = {
  name: ID,
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // One self-contained bundle per entry: with multiple entries tsdown
  // otherwise splits shared modules into a constants-<hash>.js chunk, which
  // the package.json `files` list (and any non-link install) would not ship.
  splitting: false,
}

const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([lib, client])
