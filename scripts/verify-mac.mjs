import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { verifyHelperBuildInfo } = require('./helper-build-info.cjs');
const root = process.cwd(); const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const run = (cmd, argv, extra = {}) => { const r = spawnSync(cmd, argv, { encoding: 'utf8', ...extra }); if (r.error || r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.stderr || r.error?.message || ''}`); return r.stdout.trim(); };
const config = require('js-yaml').load(await readFile('electron-builder.yml', 'utf8'));
assert(config.mac.binaries.includes('Contents/Resources/ccc-hook'), 'Native helper must be explicitly signed');
assert(config.mac.strictVerify && config.mac.hardenedRuntime, 'Strict hardened signing is required');
assert.equal(config.pkg.allowAnywhere, false); assert.equal(config.pkg.isVersionChecked, true); assert.equal(config.pkg.overwriteAction, 'upgrade');
assert(config.pkg.mustClose.includes('com.countryclub.desktop')); assert.equal(config.publish, null);
const scripts = ['installers/macos/Uninstall-Claude-Country-Club.command', 'installers/macos/pkg-scripts/preinstall'];
for (const file of scripts) { const source = await readFile(file, 'utf8'); assert(source.startsWith('#!/bin/bash\n') && !source.includes('\r'), `${file} needs Unix line endings`); assert(!source.includes('sudo '), `${file} cannot invoke elevated cleanup`); }
for (const field of ['welcome', 'conclusion', 'scripts']) assert(existsSync(path.resolve(config.directories.buildResources, config.pkg[field])), `Missing PKG ${field}`);
if (args.includes('--source')) { console.log('Mac packaging source checks passed. Mac execution and signing are unverified on this host.'); process.exit(0); }
assert.equal(process.platform, 'darwin', 'Artifact checks must run on macOS; use --source elsewhere');
const arch = option('--arch'); assert(['arm64', 'x64'].includes(arch), 'Specify --arch arm64|x64');
const expectedArch = arch === 'x64' ? 'x86_64' : 'arm64'; const pkg = path.resolve(option('--pkg') ?? ''); assert(pkg.endsWith('.pkg') && existsSync(pkg), 'Specify an existing --pkg installer');
const work = path.join(root, 'work/mac-verification'); await mkdir(work, { recursive: true }); const temp = await mkdtemp(path.join(work, 'package-')); const expanded = path.join(temp, 'expanded');
run('/usr/sbin/pkgutil', ['--expand-full', pkg, expanded]);
async function find(dir, predicate) { const found = []; for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (predicate(file, entry)) found.push(file); if (entry.isDirectory() && !entry.name.endsWith('.app')) found.push(...await find(file, predicate)); } return found; }
const apps = await find(expanded, (file, entry) => entry.isDirectory() && entry.name === 'Claude Country Club.app'); assert.equal(apps.length, 1, 'PKG must contain exactly one primary application'); const app = apps[0];
const resources = path.join(app, 'Contents/Resources'); const helper = path.join(resources, 'ccc-hook'); const uninstall = path.join(resources, 'Uninstall-Claude-Country-Club.command'); const executable = path.join(app, 'Contents/MacOS/Claude Country Club');
for (const file of [helper, executable, uninstall, path.join(resources, 'app.asar')]) assert((await stat(file)).isFile(), `Missing payload ${path.basename(file)}`);
for (const file of [helper, executable]) assert.equal(run('/usr/bin/lipo', ['-archs', file]), expectedArch, 'Packaged helper and app architecture must match installer');
verifyHelperBuildInfo(helper,JSON.parse(await readFile('packages/adapters/compatibility.json','utf8')),'darwin',arch);
assert((await stat(uninstall)).mode & 0o111, 'Removal assistant is not executable');
assert.equal(run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(app, 'Contents/Info.plist')]), 'com.countryclub.desktop');
const packageInfos = await find(expanded, file => path.basename(file) === 'PackageInfo'); assert.equal(packageInfos.length, 1, 'Unexpected component packages');
const info = await readFile(packageInfos[0], 'utf8'); assert(info.includes('identifier="com.countryclub.desktop"') && info.includes('install-location="/Applications"'), 'Package receipt identity/location mismatch');
const distribution = await readFile(path.join(expanded, 'Distribution'), 'utf8'); assert(distribution.includes('com.countryclub.desktop'), 'Missing distribution identity');
const scriptFiles = await find(expanded, file => /[\\/]Scripts[\\/]/.test(file)); assert(scriptFiles.every(file => path.basename(file) === 'preinstall'), 'Package must not run provider setup or postinstall scripts');
const signed = args.includes('--require-signed');
if (signed) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]); run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', helper]);
  // Gatekeeper and stapler establish Developer ID trust and notarization, beyond ad-hoc verification.
  run('/usr/sbin/pkgutil', ['--check-signature', pkg]); run('/usr/sbin/spctl', ['--assess', '--type', 'install', '--verbose=2', pkg]); run('/usr/bin/xcrun', ['stapler', 'validate', pkg]); run('/usr/bin/xcrun', ['stapler', 'validate', app]);
}
run('/bin/bash', ['-n', uninstall]); run('/bin/bash', [uninstall, '--check']);
// Uninstall cleanup is exercised only against a disposable home. No live provider settings are read.
const home = await mkdtemp(path.join(temp, 'home-')); const data = path.join(home, 'Library/Application Support/Claude Country Club'); await mkdir(data, { recursive: true }); const providerFile = path.join(home, '.codex/hooks.json'); await mkdir(path.dirname(providerFile), { recursive: true });
const group = { hooks: [{ type: 'command', command: `'${helper}' --provider codex --event stop`, timeout: 1 }] }; const other = { hooks: [{ type: 'command', command: 'echo unrelated' }] };
const ledger = { codex: { configPath: providerFile, entries: [{ event: 'Stop', group }], backupPath: path.join(data, 'backup.json'), installedAt: new Date().toISOString() } };
await writeFile(providerFile, JSON.stringify({ authentication: 'fixture-only-preserve', hooks: { Stop: [group, other] } })); await writeFile(path.join(data, 'config-patches.json'), JSON.stringify(ledger)); await writeFile(path.join(data, 'progress-fixture.json'), '{"keep":true}');
run('/bin/bash', [uninstall, '--cleanup-only', '--yes'], { env: { ...process.env, HOME: home } });
const cleaned = JSON.parse(await readFile(providerFile, 'utf8')); assert.deepEqual(cleaned.hooks.Stop, [other]); assert.equal(cleaned.authentication, 'fixture-only-preserve'); assert.equal(await readFile(path.join(data, 'progress-fixture.json'), 'utf8'), '{"keep":true}');
await writeFile(providerFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ ...group.hooks[0], timeout: 2 }] }] } })); await writeFile(path.join(data, 'config-patches.json'), JSON.stringify(ledger));
const blocked = spawnSync('/bin/bash', [uninstall, '--cleanup-only', '--yes'], { encoding: 'utf8', env: { ...process.env, HOME: home } }); assert.equal(blocked.status, 2, 'Modified helper references must block uninstall'); assert(existsSync(helper), 'Blocked uninstall must preserve helper'); assert(JSON.parse(await readFile(path.join(data, 'config-patches.json'), 'utf8')).codex, 'Blocked uninstall must preserve ownership');
if (args.includes('--installed')) { const receipt = run('/usr/sbin/pkgutil', ['--pkg-info-plist', 'com.countryclub.desktop']); assert(receipt.includes('com.countryclub.desktop'), 'Installed receipt missing'); const installedApp = option('--app') ?? '/Applications/Claude Country Club.app'; assert(existsSync(path.join(installedApp, 'Contents/Resources/ccc-hook')), 'Installed helper missing'); }
if (args.includes('--smoke')) {
  run(process.execPath, ['scripts/e2e.mjs'], { env: { ...process.env, CCC_EXECUTABLE: executable }, stdio: 'inherit' });
}
const result = { passed: true, architecture: arch, signedReleaseVerified: signed, previewOnly: !signed, installedReceiptChecked: args.includes('--installed'), smokeTested: args.includes('--smoke'), installer: path.basename(pkg), sha256: createHash('sha256').update(await readFile(pkg)).digest('hex'), gates: ['real desktop focus/Spaces/sleep-wake tests', 'live enrolled client lifecycle traces', 'normal Installer dialogs and Finder removal'] };
await writeFile(path.join(work, `result-${arch}.json`), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
