import { build } from 'esbuild'
await build({ entryPoints: ['workshop/server.ts'], outfile: 'dist-workshop/server.mjs', platform: 'node', target: 'node22', bundle: true, packages: 'external', format: 'esm', sourcemap: true })
