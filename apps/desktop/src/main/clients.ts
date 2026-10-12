import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ClientInfo, Provider } from '../../../../packages/contracts';

type ProbeOptions = { home: string; directory: string; platform?: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv; executable?: string; run?: (file: string, directory: string, env: NodeJS.ProcessEnv) => Promise<string> };
const nativeName = (provider: Provider, file: string, platform: NodeJS.Platform) => {
  const name = path.basename(file).toLowerCase();
  return platform === 'win32' ? new RegExp(`^${provider}(?:-[a-z0-9_-]+)?\\.exe$`).test(name) : name === provider;
};
async function runVersion(file: string, directory: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    // Nested npm installations can exceed MAX_PATH. The extended-length native
    // path avoids a false ENOENT without changing arguments or invoking a shell.
    execFile(process.platform === 'win32' ? path.toNamespacedPath(file) : file, ['--version'], { cwd: directory, env, windowsHide: true, shell: false, timeout: 2000, maxBuffer: 4096, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
/** Called only after an explicit Check version/Choose executable action. */
export async function inspectClient(provider: Provider, options: ProbeOptions): Promise<ClientInfo> {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const dirs = [path.join(options.home, '.local', 'bin'), path.join(options.home, '.cargo', 'bin'), ...(platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']), ...(environment.PATH ?? '').split(platform === 'win32' ? ';' : ':')];
  const searchDirs = [...new Set(dirs.filter(dir => path.isAbsolute(dir)).slice(0, 80))];
  const candidates = options.executable ? [path.resolve(options.executable)] : searchDirs.map(dir => path.join(dir, provider + (platform === 'win32' ? '.exe' : '')));
  // npm exposes a shell wrapper on PATH, but its installed package contains a
  // native binary. Resolve only fixed layouts; never execute/read the wrapper,
  // load package JavaScript, or recursively search an installation/home.
  const arch = options.arch ?? process.arch;
  if (!options.executable && provider === 'codex' && platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
    const triple = `${arch === 'x64' ? 'x86_64' : 'aarch64'}-pc-windows-msvc`;
    const platformPackage = `codex-win32-${arch}`;
    for (const dir of searchDirs) {
      const packageRoot = path.join(dir, 'node_modules', '@openai', 'codex');
      for (const vendorRoot of [
        path.join(packageRoot, 'node_modules', '@openai', platformPackage, 'vendor'),
        path.join(dir, 'node_modules', '@openai', platformPackage, 'vendor'),
        path.join(packageRoot, 'vendor'),
      ]) candidates.push(path.join(vendorRoot, triple, 'bin', 'codex.exe'));
    }
  }
  let executable: string | undefined;
  for (const file of candidates) {
    if (!nativeName(provider, file, platform)) continue;
    try { const info = await fs.stat(file); if (info.isFile()) { executable = file; break; } } catch { /* missing executable */ }
  }
  if (!executable) return { status: options.executable ? 'limited' : 'missing', note: 'A native client executable was not found. Choose the installed claude or codex binary. Shell aliases and Windows command wrappers are not executed. Practice remains available.' };
  const directory = path.join(options.directory, 'client-probe');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // Version checks receive neither provider secrets nor the real client config home.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG']) if (environment[key]) env[key] = environment[key];
  Object.assign(env, { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory, CODEX_HOME: path.join(directory, 'codex'), CLAUDE_CONFIG_DIR: path.join(directory, 'claude'), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  try {
    const output = await (options.run ?? runVersion)(executable, directory, env);
    // Retain only the version number, never arbitrary process output.
    const version = output.match(/(?:^|\s)v?(\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-zA-Z0-9.-]{1,40})?)(?:\s|$)/)?.[1];
    if (!version) throw new Error('Version was not identified');
    return { status: 'found', executable, version, note: 'Version detected locally. This does not certify hook support or subscription status. Complete native trust review and test a normal turn in your client.' };
  } catch { return { status: 'limited', executable, note: 'The bounded --version check failed, timed out, or returned an unknown format. No client output was retained. Practice and configuration review remain available.' }; }
}
