import { build } from 'esbuild'

// Two bundles: the runner drives the editor from plain node, the suite runs inside the extension
// host and is copied into the extension-development folder so `require('vscode')` resolves to the
// companion's own API instance. `vscode` and the launcher stay external.
for (const entry of ['runner', 'suite']) {
  await build({
    entryPoints: [`uat/src/${entry}.ts`],
    outfile: `uat/dist/${entry}.cjs`,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['vscode', '@vscode/test-electron'],
  })
}
