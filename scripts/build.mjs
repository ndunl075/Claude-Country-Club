import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
await mkdir('dist/native', { recursive: true });
await bundle({entryPoints:['apps/desktop/src/main/index.ts'],outfile:'dist/main.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron','node:sqlite'],sourcemap:true});
await bundle({entryPoints:['apps/desktop/src/preload/index.ts'],outfile:'dist/preload.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron'],sourcemap:true});
await viteBuild({root:path.join(root,'apps/desktop/src/renderer'),base:'./',build:{outDir:path.join(root,'dist/renderer'),emptyOutDir:true},logLevel:'warn'});
const arch = process.env.CCC_BUILD_ARCH ?? (process.arch === 'arm64' ? 'arm64' : 'amd64');
const platform = process.env.CCC_BUILD_OS ?? (process.platform === 'win32' ? 'windows' : process.platform);
const output=path.join(root,'dist/native',platform==='windows'?'ccc-hook.exe':'ccc-hook');
// Hooks and the broker communicate through inherited pipes, never a console.
// Keep the NSIS transaction coordinator's existing console subsystem below.
const helperLinkFlags=platform==='windows'?'-s -w -H=windowsgui':'-s -w';
const result=spawnSync('go',['build','-trimpath',`-ldflags=${helperLinkFlags}`,'-o',output,'.'],{cwd:path.join(root,'native/ccc-hook'),stdio:'inherit',env:{...process.env,GOOS:platform,GOARCH:arch,GOCACHE:path.join(root,'work/go-cache'),GOMODCACHE:path.join(root,'work/go-modcache'),CGO_ENABLED:'0'}});
if(result.status!==0)throw new Error('Native helper build failed');
if(platform==='windows') {
  const installer=spawnSync('go',['build','-trimpath','-ldflags=-s -w','-o',path.join(root,'dist/native/ccc-installer.exe'),'./cmd/ccc-installer'],{cwd:path.join(root,'native/ccc-hook'),stdio:'inherit',env:{...process.env,GOOS:platform,GOARCH:arch,GOCACHE:path.join(root,'work/go-cache'),GOMODCACHE:path.join(root,'work/go-modcache'),CGO_ENABLED:'0'}});
  if(installer.status!==0)throw new Error('Installer transaction coordinator build failed');
}
await copyFile('apps/desktop/build/icon-v2.png','dist/icon.png');
await copyFile('packages/adapters/compatibility.json','dist/compatibility.json');
console.log(`Built desktop application and ${platform}/${arch} helper.`);
