const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { verifyHelperBuildInfo } = require('./helper-build-info.cjs');
// Runs after executable signing, before NSIS archives the final application.
module.exports = async function packageManifest(context) {
  const { extractFile } = await import('@electron/asar');
  const resources = context.electronPlatformName === 'darwin' ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app/Contents/Resources`) : path.join(context.appOutDir, 'resources');
  const shipped = extractFile(path.join(resources, 'app.asar'), 'dist/compatibility.json');
  const source = await fs.readFile(path.join(context.packager.projectDir, 'packages/adapters/compatibility.json'));
  if (!shipped.equals(source)) throw new Error('Packaged compatibility manifest differs from reviewed source.');
  const manifest = JSON.parse(source);
  if (manifest.protocolVersion !== 1 || manifest.schemaVersion !== 1) throw new Error('Unsupported compatibility protocol or schema.');
  const targetArch = { 1:'x64', 3:'arm64' }[context.arch];
  if (!targetArch || context.electronPlatformName!==process.platform || targetArch!==process.arch) throw new Error('Native packaging verification requires a matching operating system and architecture.');
  const info=verifyHelperBuildInfo(path.join(resources,context.electronPlatformName==='win32'?'ccc-hook.exe':'ccc-hook'),manifest,context.electronPlatformName,targetArch);
  const evidence=path.join(context.packager.projectDir,'work/package-verification');
  await fs.mkdir(evidence,{recursive:true});
  await fs.writeFile(path.join(evidence,`${context.electronPlatformName}-${targetArch}.json`),JSON.stringify({passed:true,helper:info},null,2));
  if (context.electronPlatformName !== 'win32') return;
  const template = await fs.readFile(path.join(context.packager.projectDir, 'node_modules/app-builder-lib/templates/nsis/installer.nsi'), 'utf8');
  const templateHash = createHash('sha256').update(template.replace(/\r\n/g, '\n')).digest('hex');
  if (templateHash !== '8811964416d122612c3e7601728af5d3f998d677918df829a4e8b4c739c8b9f8') throw new Error('NSIS template changed: review transaction section inclusion and rerun upgrade acceptance.');
  const embeddedDirectory = path.join(context.packager.projectDir, 'work/nsis');
  await fs.mkdir(embeddedDirectory, { recursive: true });
  await context.packager.signIf(path.join(context.appOutDir, 'resources/ccc-installer.exe'));
  // Use the final resource binary, after app-builder's executable signing pass.
  await fs.copyFile(path.join(context.appOutDir, 'resources/ccc-installer.exe'), path.join(embeddedDirectory, 'ccc-installer.exe'));
  const files = {};
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Linked package assets are not supported.');
      if (entry.isDirectory()) await walk(full);
      else {
        const relative = path.relative(context.appOutDir, full).split(path.sep).join('/');
        if (relative === 'ccc-package.json') continue;
        files[relative] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
      }
    }
  }
  await walk(context.appOutDir);
  await fs.writeFile(path.join(context.appOutDir, 'ccc-package.json'), JSON.stringify({ appId: context.packager.appInfo.id, version: context.packager.appInfo.version, files }, null, 2));
};
