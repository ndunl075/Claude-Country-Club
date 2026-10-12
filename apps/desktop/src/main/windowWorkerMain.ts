import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseControllerMessage } from './windowWorkerProtocol';

// An opt-in, intentionally presentation-only worker. It has no Store, tray,
// native helper, provider configuration, or preload bridge. This proves the
// private window lifecycle before the controller delegates real renderer work.
export function runWindowWorker() {
  if (typeof process.send !== 'function' || !process.connected) { app.quit(); return; }
  void app.whenReady().then(() => startWorker());
}

function startWorker() {
  let generation: number | undefined;
  let window: BrowserWindow | undefined;
  let controllerRequest = 0;
  const controllerPending = new Map<string, { resolve: (payload: unknown) => void; reject: () => void }>();
  const uiRoot=path.join(__dirname,'renderer');
  const respond = (id: string, ok: boolean, payload?: unknown, errorCode?: string) => {
    if (generation === undefined || !process.connected) return;
    process.send?.({ protocolVersion: 1, type: 'response', generation, id, ok, ...(payload === undefined ? {} : { payload }), ...(errorCode ? { errorCode } : {}) });
  };
  const open = async () => {
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({ title: 'Claude Country Club', width: 620, height: 600, show: false, autoHideMenuBar: true, backgroundColor: '#f5f2e9', webPreferences: { preload:path.join(__dirname,'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      window.webContents.session.setPermissionCheckHandler(() => false);
      await window.loadURL('ccc://app/index.html');
    }
    window.showInactive();
  };
  const requestController = (command: string, payload: unknown) => new Promise<unknown>((resolve, reject) => {
    if (generation === undefined || !process.connected) { reject(new Error('Controller unavailable.')); return; }
    const id = `worker-${++controllerRequest}`;
    controllerPending.set(id, { resolve, reject });
    process.send?.({ protocolVersion: 1, type: 'request', generation, id, command, payload }, error => { if (error) { controllerPending.delete(id); reject(error); } });
  });
  const apiNames=['state','settings','load','save','practice','hide','select','preview','apply','remove','inspect-client','simulate','export','diagnostics-preview','diagnostics-export','import','docs','updates'];
  for(const name of apiNames)ipcMain.handle(`ccc:${name}`,(event,...args)=>{
    if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||!event.senderFrame.url.startsWith('ccc://app/'))throw new Error('Untrusted worker renderer');
    if(Buffer.byteLength(JSON.stringify(args),'utf8')>256*1024)throw new Error('Worker IPC payload too large');
    return requestController('api',{name,args});
  });
  protocol.handle('ccc',async request=>{
    const url=new URL(request.url);if(url.host!=='app')return new Response('Forbidden',{status:403});
    let requested:string;try{requested=decodeURIComponent(url.pathname);}catch{return new Response('Invalid path',{status:400});}
    const filename=path.resolve(uiRoot,`.${requested==='/'?'/index.html':requested}`);if(!filename.startsWith(uiRoot+path.sep))return new Response('Forbidden',{status:403});
    try{const content=await fs.readFile(filename);const mime=({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}as Record<string,string>)[path.extname(filename)]??'application/octet-stream';return new Response(content,{headers:{'Content-Type':mime,'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'"}});}catch{return new Response('Not found',{status:404});}
  });
  process.on('message', async raw => {
    const message = parseControllerMessage(raw);
    if (!message) return;
    if (message.type === 'init') {
      if (generation !== undefined) return;
      generation = message.generation;
      process.send?.({ protocolVersion: 1, type: 'ready', generation, nonce: message.nonce });
      return;
    }
    if (message.type === 'response') {
      const pending=controllerPending.get(message.id); if(!pending)return;
      controllerPending.delete(message.id); message.ok ? pending.resolve(message.payload) : pending.reject(); return;
    }
    if (generation === undefined || message.generation !== generation) return;
    try {
      if (message.command === 'open') { await open(); respond(message.id, true, { visible: !!window?.isVisible() }); }
      else if (message.command === 'hide') { window?.hide(); respond(message.id, true, { visible: false }); }
      else if (message.command === 'state') { window?.webContents.send('ccc:state',message.payload); respond(message.id, true); }
      else if (message.command === 'freeze') { window?.webContents.send('ccc:freeze',message.payload); respond(message.id, true); }
      else if (message.command === 'controller-state') { respond(message.id, true, await requestController('state', { requested: 'worker' })); }
      else if (message.command === 'quit') { respond(message.id, true); app.quit(); }
      else respond(message.id, false, undefined, 'UNKNOWN_COMMAND');
    } catch { respond(message.id, false, undefined, 'WINDOW_FAILURE'); }
  });
  process.on('disconnect', () => app.quit());
}
