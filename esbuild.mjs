import { build } from 'esbuild'

// `vscode` is provided by the extension host at runtime and must stay external; everything
// else is bundled because the extension ships with zero runtime dependencies.
await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  minify: true,
  sourcemap: false,
})
