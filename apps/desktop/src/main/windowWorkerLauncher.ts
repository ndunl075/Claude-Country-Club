import { app } from 'electron';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { WindowWorkerBridge, WindowWorkerPort } from './windowWorkerBridge';

export type LaunchedWindowWorker = { child: ChildProcess; bridge: WindowWorkerBridge };

// No token, storage location, or provider configuration is sent on the command
// line. The child has only the inherited anonymous IPC channel and an isolated
// profile because it does not own persistent application state.
export function launchWindowWorker(generation: number, onRequest?: (command: string, payload: unknown) => Promise<unknown> | unknown): LaunchedWindowWorker {
  const childData = path.join(app.getPath('userData'), 'window-worker');
  const args = app.isPackaged ? ['--ccc-window-worker'] : [app.getAppPath(), '--ccc-window-worker'];
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    env: { ...process.env, CCC_DATA_DIR: childData, CCC_WINDOW_WORKER_CONTROLLER_PROBE: undefined }
  });
  const bridge = new WindowWorkerBridge(child as unknown as WindowWorkerPort, { generation, onRequest });
  return { child, bridge };
}
