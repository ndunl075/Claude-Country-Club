import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, protocol, screen, shell } from 'electron';
import { Tray } from 'electron';
import { spawn, ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentEvent, ClientInfo, Diagnostic, HostState, IntegrationPreview, Provider, validateEvent } from '../../../../packages/contracts';
import { Store } from './store';
import { RecoverableStorageError, preserveDamagedStorage } from './storageRecovery';
import { confirmStorageRecovery } from './storageRecoveryPrompt';
import { SessionRegistry } from './sessions';
import { IntegrationManager } from '../../../../packages/adapters';
import { inspectClient } from './clients';
import { validateRound } from '../../../../packages/game';
import { createSocketPath } from './socket-path';
import { writeProgressExport } from './progressExport';
import { loadIdentityKey } from './identityKey';
import { bindSystemLifecycle } from './systemLifecycle';
import { fitWindowBounds } from './windowBounds';
import { diagnosticReport, DiagnosticReviews } from './diagnosticExport';
import { DiagnosticLog, DIAGNOSTIC_CHUNK_BYTES } from './diagnosticLog';
import { runWindowWorker } from './windowWorkerMain';
import { launchWindowWorker } from './windowWorkerLauncher';
import { relayWindowWorkerApi } from './windowWorkerApiRelay';

app.setName('Claude Country Club');
const testing = process.env.CCC_TEST_MODE === '1';
const windowWorkerMode = process.argv.includes('--ccc-window-worker');
if(testing && process.env.CCC_TEST_SOFTWARE==='1')app.disableHardwareAcceleration();
if (testing && process.env.CCC_DATA_DIR) app.setPath('userData', path.resolve(process.env.CCC_DATA_DIR));
protocol.registerSchemesAsPrivileged([{ scheme: 'ccc', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (!testing && !windowWorkerMode && !app.requestSingleInstanceLock()) app.quit();
let window: BrowserWindow | undefined, tray: Tray | undefined, store: Store, integrations: IntegrationManager;
let windowWorkerBridge: import('./windowWorkerBridge').WindowWorkerBridge | undefined;
let windowWorkerChild: ChildProcess | undefined;
const workerRenderer = process.env.CCC_WINDOW_WORKER === '1';
let broker: ChildProcessWithoutNullStreams | undefined, brokerReady = false, quitting = false;
let quitPending = false;
let uiReady = false, startupOpenSuppressed = false;
let courseProtocolRegistered = false;
let queuedOpen: 'dashboard' | 'practice' | undefined;
let socketDirectory: string | undefined;
let openedByUser = true;
let rendererCrashed = false, rendererRecovery: Promise<void> | undefined;
let parkTimer: ReturnType<typeof setTimeout> | undefined;
const clientCache: Partial<Record<Provider,ClientInfo>> = {};
let suspended = true, practice = false, selected: string | null = null, demo = false, eligibleTimer: ReturnType<typeof setTimeout> | undefined;
let dismissedWait: string | undefined, freezeVersion = 0, freezing: Promise<void> | undefined;
let demoTurn = randomUUID();
const registry = new SessionRegistry();
const diagnostics: Diagnostic[] = [];
const diagnosticReviews=new DiagnosticReviews();
const frozenWaiters = new Map<string, () => void>();
const controllerHandlers = new Map<string, (...args: any[]) => unknown>();
const systemHolds = new Set<'sleep' | 'lock'>();
let lockStateKnown = false;
const dataDir = app.getPath('userData');
const diagnosticLog=new DiagnosticLog(dataDir,fs,DIAGNOSTIC_CHUNK_BYTES,()=>diagnose('DIAGNOSTIC_LOG_UNAVAILABLE','Local diagnostic history is unavailable. Gameplay and reviewed export remain available; existing files were preserved.'));
let windowMode: 'dashboard' | 'companion' = 'dashboard';
function rememberBounds() {
  if(!window || window.isDestroyed() || !store)return;
  try { store.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`window:${windowMode}`,JSON.stringify(window.getBounds())); } catch { /* presentation preferences must not crash gameplay */ }
}
function fittedBounds(candidate: unknown) {
  return fitWindowBounds(candidate, screen.getAllDisplays().map(display => display.workArea), screen.getPrimaryDisplay().workArea);
}
function applyBounds(candidate: unknown) {
  if (!window || window.isDestroyed()) return;
  const { bounds, workArea } = fittedBounds(candidate);
  window.setMinimumSize(Math.min(520, workArea.width), Math.min(480, workArea.height));
  window.setBounds(bounds);
}
function repairBounds() {
  if (!window || window.isDestroyed()) return;
  applyBounds(window.getBounds());
  rememberBounds();
}
function restoreBounds(mode: 'dashboard' | 'companion') {
  if(!window || window.isDestroyed())return;
  if(windowMode!==mode)rememberBounds();
  windowMode=mode;
  const a=screen.getPrimaryDisplay().workArea;
  const defaults=mode==='companion'?{x:a.x+a.width-644,y:a.y+a.height-624,width:620,height:600}:{x:a.x+40,y:a.y+40,width:620,height:600};
  let bounds: unknown=defaults;
  try {
    const row=store.db.prepare('SELECT value FROM settings WHERE key=?').get(`window:${mode}`) as {value:string}|undefined;
    if(row)bounds=JSON.parse(row.value);
  } catch { /* ignore invalid presentation preferences */ }
  applyBounds(bounds);
}
function diagnose(code: string, message: string) { const entry={time:new Date().toISOString(),code,message};diagnostics.unshift(entry); diagnostics.splice(80);diagnosticLog.append(entry); publish(); }
function state(): HostState {
  return { settings: store.settings(), sessions: registry.list(), integrations: integrationCache, selectedSession: selected, practice, suspended, brokerReady, diagnostics:[...diagnostics], version:app.getVersion(),platform:process.platform };
}
let integrationCache: HostState['integrations'] = [];
function publish() { const next=state(); if (store && window && !window.isDestroyed() && !rendererCrashed) window.webContents.send('ccc:state',next); if(windowWorkerBridge)void windowWorkerBridge.request('state',next).catch(()=>undefined); }
async function refreshIntegrations() { integrationCache = (await integrations.list()).map(info=>({...info,client:clientCache[info.provider] ?? {status:'not-checked',note:'Choose Check version to inspect an installed native client. No client is launched automatically.'}})); publish(); }
function waitKey() { const s = registry.get(selected); return s ? `${s.key}:${s.generation}` : undefined; }
function eligible() { const s=registry.get(selected); return lockStateKnown && systemHolds.size===0 && (store.settings().automatic || demo) && !practice && s?.state==='working' && s.reliable && dismissedWait!==waitKey(); }
function systemHold(reason: 'sleep' | 'lock', active: boolean) {
  if(active)systemHolds.add(reason);else systemHolds.delete(reason);
  if(active){queuedOpen=undefined;if(!uiReady)startupOpenSuppressed=true;}
  // Resume/unlock never revives work observed before or during the hold.
  practice=false;registry.disconnect();void freezeAndHide();
}
function cancelEligibility() { if (eligibleTimer) clearTimeout(eligibleTimer); eligibleTimer=undefined; }
function cancelPark() { if(parkTimer)clearTimeout(parkTimer);parkTimer=undefined; }
function schedulePark() {
  cancelPark();
  parkTimer=setTimeout(()=>{
    if(workerRenderer && windowWorkerBridge && !practice && !eligible() && !rendererRecovery && !freezing){const bridge=windowWorkerBridge;windowWorkerBridge=undefined;windowWorkerChild=undefined;void bridge.request('quit',{}).catch(()=>undefined);return;}
    if(window && !window.isDestroyed() && !window.isVisible() && !practice && !eligible() && !rendererRecovery && !freezing){
      rememberBounds();const parked=window;window=undefined;parked.destroy();
    }
  },30_000);
  parkTimer.unref();
}
async function freezeAndHide() {
  cancelEligibility(); suspended = true; publish();
  if (freezing) return freezing;
  const epoch = ++freezeVersion;
  freezing = (async () => {
    if(workerRenderer&&windowWorkerBridge){
      const id=randomUUID();
      await new Promise<void>(resolve=>{const timer=setTimeout(()=>{frozenWaiters.delete(id);resolve();},180);frozenWaiters.set(id,()=>{clearTimeout(timer);resolve();});void windowWorkerBridge?.request('freeze',id).catch(()=>{frozenWaiters.delete(id);resolve();});});
      if(freezeVersion===epoch){await windowWorkerBridge?.request('hide',{}).catch(()=>undefined);schedulePark();}return;
    }
    if (window && !window.isDestroyed() && !rendererCrashed) {
      const id=randomUUID();
      await new Promise<void>(resolve => {
        const timer=setTimeout(() => { frozenWaiters.delete(id); resolve(); },180);
        frozenWaiters.set(id,()=>{clearTimeout(timer);resolve();});
        window!.webContents.send('ccc:freeze',id);
      });
      if (freezeVersion === epoch) { window.hide(); schedulePark(); }
    }
  })().finally(()=>{ freezing=undefined; });
  return freezing;
}
function reconcile() {
  publish();
  if (practice || rendererCrashed) return;
  if (!eligible()) { if (!openedByUser) void freezeAndHide(); else { suspended=true;publish(); } return; }
  if (!suspended || eligibleTimer) return;
  cancelPark();
  // Recreate a parked renderer during the eligibility delay, before showing it.
  void recoverRenderer().catch(()=>diagnose('RENDERER_REPAIR','The course could not reopen. Repair the application; saved progress was preserved.'));
  const key=waitKey();
  eligibleTimer=setTimeout(async()=> {
    eligibleTimer=undefined;
    try { await recoverRenderer(); } catch { diagnose('RENDERER_REPAIR','The course could not reopen. Repair the application; saved progress was preserved.'); return; }
    if (!eligible() || waitKey()!==key) return;
    freezeVersion++; openedByUser=false; suspended=false;
    if (window && !window.isDestroyed()) { restoreBounds('companion'); window.showInactive(); publish(); }
  },store.settings().delayMs);
}
function accept(raw: unknown) {
  try {
    const event=validateEvent(raw);
    if (!registry.accept(event)) return;
    // Retain deduplication/turn tombstones, but never trust held events as work.
    if(systemHolds.size){registry.disconnect();publish();return;}
    const active=registry.list().filter(s=>s.state==='working');
    if (!selected && active.length===1) selected=active[0].key;
    reconcile();
  } catch { diagnose('EVENT_REJECTED','An invalid local lifecycle event was ignored.'); }
}
async function recoverRenderer() {
  if(!uiReady || !store)throw new Error('Country Club is still starting.');
  if(quitting || quitPending)return;
  cancelPark();
  if(workerRenderer){
    if(windowWorkerBridge)return;
    const launched=launchWindowWorker(freezeVersion+1,(command,payload)=>{
      if(command==='api')return relayWindowWorkerApi(payload,controllerHandlers);
      if(command==='frozen'&&payload&&typeof payload==='object'&&typeof (payload as {id?:unknown}).id==='string'){const id=(payload as {id:string}).id;frozenWaiters.get(id)?.();frozenWaiters.delete(id);return undefined;}
      return Promise.reject(new Error('Denied worker request'));
    });
    windowWorkerChild=launched.child;windowWorkerBridge=launched.bridge;
    launched.child.on('exit',()=>{if(windowWorkerBridge===launched.bridge){windowWorkerBridge=undefined;windowWorkerChild=undefined;}});
    try{await launched.bridge.start();}catch(error){if(windowWorkerBridge===launched.bridge){windowWorkerBridge=undefined;windowWorkerChild=undefined;}throw error;}
    return;
  }
  if(rendererRecovery){await rendererRecovery;return;}
  if (!rendererCrashed && window && !window.isDestroyed()) return;
  if (!rendererRecovery) {
    const previous=window;window=undefined;previous?.destroy();
    rendererRecovery = createWindow().then(()=>{rendererCrashed=false;}).finally(()=>{rendererRecovery=undefined;});
  }
  await rendererRecovery;
}
async function showDashboard() {
  if(quitting || quitPending || systemHolds.size)return;
  if(!uiReady){queuedOpen='dashboard';return;}
  if(!store)return;
  openedByUser=true; dismissedWait=waitKey(); const epoch=++freezeVersion; suspended=true; practice=false; cancelEligibility();
  await recoverRenderer();
  if(quitting || quitPending || systemHolds.size || freezeVersion!==epoch)return;
  if(workerRenderer)await windowWorkerBridge?.request('open',{});else {restoreBounds('dashboard'); window?.show();} publish();
}
async function startPractice() {
  if(quitting || quitPending || systemHolds.size)return;
  if(!uiReady){queuedOpen='practice';return;}
  if(!store)return;
  openedByUser=true; const epoch=++freezeVersion; cancelEligibility();
  await recoverRenderer();
  if(quitting || quitPending || systemHolds.size || freezeVersion!==epoch)return;
  practice=true; suspended=false;if(workerRenderer)await windowWorkerBridge?.request('open',{});else {restoreBounds('dashboard'); window?.show();} publish();
}
async function requestOpen(mode: 'dashboard' | 'practice') {
  try { await (mode==='practice'?startPractice():showDashboard()); }
  catch { if(!quitting && !quitPending)diagnose('RENDERER_REPAIR','The course could not reopen. Repair the application; saved progress was preserved.'); }
}
function helperPath() { return path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname,'native'),process.platform==='win32'?'ccc-hook.exe':'ccc-hook'); }
async function startBroker() {
  const token = randomBytes(32).toString('hex');
  const localSocket=process.platform==='win32'?undefined:await createSocketPath();
  socketDirectory=localSocket?.directory;
  const pipe=process.platform==='win32' ? `\\\\.\\pipe\\country-club-${randomBytes(12).toString('hex')}` : localSocket!.socket;
  const config=path.join(dataDir,'connection.json');
  await fs.mkdir(dataDir,{recursive:true,mode:0o700});
  const identity=await loadIdentityKey(dataDir);
  if(identity.created && selected){selected=null;store.setSettings({selectedSession:null});}
  await fs.writeFile(config,JSON.stringify({pipe,token,identityKey:identity.key}),{mode:0o600});
  try {
    broker=spawn(helperPath(),['--serve','--config',config],{windowsHide:true,stdio:'pipe'});
  } catch {
    // Windows may reject a damaged executable synchronously, before an error
    // listener exists. Optional integration failure must not abort practice.
    brokerReady=false;
    if(socketDirectory)await fs.rmdir(socketDirectory).catch(()=>undefined);
    diagnose('BROKER_UNAVAILABLE','Automatic connections are unavailable. Practice still works. Repair the application to restore the helper.');
    return;
  }
  let buffer='';
  broker.stdout.on('data',(chunk:Buffer)=> {
    buffer+=chunk.toString('utf8');
    if (buffer.length>32_768) { buffer=''; diagnose('BROKER_FRAME','An oversized local broker message was rejected.'); return; }
    let index:number;
    while ((index=buffer.indexOf('\n'))>=0) {
      const line=buffer.slice(0,index); buffer=buffer.slice(index+1);
      try { const data=JSON.parse(line); if (data.ready) { brokerReady=true;publish(); } else if (data.event) accept(data.event); } catch { diagnose('BROKER_MESSAGE','A malformed broker message was ignored.'); }
    }
  });
  broker.stderr.on('data',()=>{ /* no raw helper diagnostics are collected */ });
  broker.on('error',()=>diagnose('BROKER_UNAVAILABLE','Automatic connections are unavailable. Practice still works. Repair the application to restore the helper.'));
  broker.on('exit',()=>{if(socketDirectory)void fs.rmdir(socketDirectory).catch(()=>undefined);brokerReady=false;registry.disconnect(); if (!quitting) {reconcile();diagnose('BROKER_STOPPED','Local connection stopped. Restart Country Club to reconnect.');}});
}
async function runWindowWorkerControllerProbe() {
  const { child, bridge } = launchWindowWorker(1,(command,payload)=>{
    if(command==='api')return relayWindowWorkerApi(payload,controllerHandlers);
    if(command==='frozen'&&payload&&typeof payload==='object'&&typeof (payload as {id?:unknown}).id==='string'){const id=(payload as {id:string}).id;frozenWaiters.get(id)?.();frozenWaiters.delete(id);return undefined;}
    if(command==='state')return { relay: 'controller', payload };
    return Promise.reject(new Error('Unexpected worker request'));
  });
  try {
    await bridge.start();
    windowWorkerBridge=bridge;
    await bridge.request('open', {});
    const relay=await bridge.request('controller-state', {});
    if(JSON.stringify(relay)!==JSON.stringify({relay:'controller',payload:{requested:'worker'}}))throw new Error('Window worker relay response mismatch.');
    await bridge.request('hide', {});
    await bridge.request('quit', {});windowWorkerBridge=undefined;
    await new Promise<void>((resolve, reject) => {
      const timer=setTimeout(()=>reject(new Error('Window worker did not exit.')),5_000);
      child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Window worker exited ${code}.`));});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    console.log('CCC_WINDOW_WORKER_CONTROLLER_PROBE_OK');
  } catch (error) {
    console.error('CCC_WINDOW_WORKER_CONTROLLER_PROBE_FAILED',error instanceof Error?error.message:String(error));
    windowWorkerBridge=undefined;child.kill(); throw error;
  }
}
async function runWindowWorkerSmoke() {
  await startPractice();
  await new Promise(resolve=>setTimeout(resolve,500));
  console.log('CCC_WINDOW_WORKER_SMOKE_OK');
  app.quit();
}
function installIPC() {
  const handle=(name:string,fn:(...args:any[])=>unknown) => ipcMain.handle(`ccc:${name}`,(event,...args)=> {
    if (!window || event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame || !event.senderFrame.url.startsWith('ccc://app/')) throw new Error('Untrusted IPC sender');
    if (JSON.stringify(args).length>300_000) throw new Error('IPC payload too large');
    return fn(...args);
  });
  const register=(name:string,fn:(...args:any[])=>unknown)=>{controllerHandlers.set(name,fn);handle(name,fn);};
  register('state',()=>state());
  register('settings',(patch:unknown)=>{const settings=store.setSettings(patch); if (patch && typeof patch === 'object' && 'selectedSession' in patch) selected=settings.selectedSession; if (!testing && patch && typeof patch === 'object' && 'startAtLogin' in patch) app.setLoginItemSettings({openAtLogin:settings.startAtLogin,args:['--ccc-background']}); reconcile();return state();});
  register('load',()=> { try { return store.load(); } catch { diagnose('SAVE_RECOVERY','The saved round could not be read. Export your data before resetting progress.'); const raw=store.db.prepare('SELECT revision FROM round_save WHERE id=1').get() as {revision:number}|undefined; return raw ? {revision:raw.revision,state:null} : null; } });
  register('save',(value:unknown,revision:number)=> { try {return store.save(value,revision);} catch (e) {diagnose('SAVE_FAILED','Progress could not be saved. Play is paused until storage is available.'); suspended=true;publish();throw e;} });
  register('practice',startPractice);
  register('hide',async()=>{dismissedWait=waitKey();practice=false;await freezeAndHide();});
  register('select',(key:string|null)=>{if(key!==null&&!registry.get(key))throw new Error('Unknown session');selected=key;store.setSettings({selectedSession:key});dismissedWait=undefined;practice=false;void freezeAndHide().then(reconcile);});
  const provider=(p:unknown):Provider=>{if(p!=='claude'&&p!=='codex')throw new Error('Invalid provider');return p;};
  register('preview',(p:unknown)=>integrations.preview(provider(p)));
  register('apply',async(preview:IntegrationPreview)=>{await integrations.apply(preview);await refreshIntegrations();return state();});
  register('remove',async(p:unknown)=>{await integrations.remove(provider(p));await refreshIntegrations();return state();});
  register('inspect-client',async(p:unknown,choose:unknown)=>{
    const selectedProvider=provider(p);
    if(choose!==undefined && typeof choose!=='boolean')throw new Error('Invalid executable selection');
    let executable:string|undefined;
    if(choose){const result=await dialog.showOpenDialog(window!,{title:`Choose the installed ${selectedProvider} executable`,properties:['openFile'],...(process.platform==='win32'?{filters:[{name:'Native executable',extensions:['exe']}]}:{})});if(result.canceled)return state();executable=result.filePaths[0];}
    clientCache[selectedProvider]=await inspectClient(selectedProvider,{home:testing&&process.env.CCC_TEST_HOME?process.env.CCC_TEST_HOME:os.homedir(),directory:dataDir,...(executable?{executable}:{}),...(testing?{env:{PATH:''}}:{})});
    await refreshIntegrations();return state();
  });
  register('simulate',(kind:unknown)=>{
    if (!['start','attention','stop'].includes(String(kind))) throw new Error('Invalid demo event');
    demo=kind!=='stop'; practice=false; selected='codex:local-demo';dismissedWait=undefined;
    if(kind==='start')demoTurn=randomUUID();
    accept({protocolVersion:1,eventId:randomUUID(),sessionKey:'local-demo',turnId:demoTurn,provider:'codex',adapterVersion:'synthetic',kind: kind as AgentEvent["kind"]} satisfies AgentEvent);
  });
  register('export',async()=> {const result=await dialog.showSaveDialog(window!,{defaultPath:'Country-Club-Progress.json',filters:[{name:'Progress JSON',extensions:['json']}]});if(result.canceled||!result.filePath)return false;await writeProgressExport(result.filePath,JSON.stringify(store.export(),null,2));return true;});
  register('diagnostics-preview',()=>diagnosticReviews.create(diagnosticReport(state(),process.arch)));
  register('diagnostics-export',async(id:unknown)=>{
    diagnosticReviews.read(id);
    const result=await dialog.showSaveDialog(window!,{defaultPath:'Country-Club-Diagnostics.json',filters:[{name:'Diagnostic JSON',extensions:['json']}]});
    if(result.canceled||!result.filePath)return false;
    // Revalidate after the chooser: the exact reviewed snapshot may expire or
    // be replaced while the native dialog is open. Renderer bytes are ignored.
    const content=diagnosticReviews.read(id);
    await writeProgressExport(result.filePath,content);diagnosticReviews.complete(id as string);return true;
  });
  register('import',async()=> {
    const result=await dialog.showOpenDialog(window!,{properties:['openFile'],filters:[{name:'Progress JSON',extensions:['json']}]});if(result.canceled)return false;
    const info=await fs.stat(result.filePaths[0]);if(!info.isFile()||info.size>300_000)throw new Error('Progress file too large or not a regular file');
    const content=await fs.readFile(result.filePaths[0]);if(content.byteLength>300_000)throw new Error('Progress file too large');
    const data=JSON.parse(content.toString('utf8'));
    if(data?.format!=='claude-country-club'||data.version!==1||!data.round)throw new Error('Invalid progress file');
    validateRound(data.round.state);
    await freezeAndHide();
    try {store.import(data);await showDashboard();window?.webContents.reload();return true;}catch(error){await showDashboard();throw error;}
  });
  register('docs',()=>shell.openExternal('https://github.com/ndunl075/Claude-Country-Club'));
  register('updates',()=>shell.openExternal('https://github.com/ndunl075/Claude-Country-Club/releases'));
  ipcMain.on('ccc:frozen',(event,id)=>{if(event.sender===window?.webContents && typeof id==='string'){frozenWaiters.get(id)?.();frozenWaiters.delete(id);}});
}
function ensureCourseProtocol() {
  if(courseProtocolRegistered)return;
  const uiRoot=path.join(__dirname,'renderer');
  protocol.handle('ccc',async request=>{
    const url=new URL(request.url);
    if(url.host!=='app')return new Response('Forbidden',{status:403});
    let requested:string;try{requested=decodeURIComponent(url.pathname);}catch{return new Response('Invalid path',{status:400});}
    const filename=path.resolve(uiRoot,`.${requested==='/'?'/index.html':requested}`);
    if (!filename.startsWith(uiRoot+path.sep)) return new Response('Forbidden',{status:403});
    try {
      const content=await fs.readFile(filename);
      const mime=({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'} as Record<string,string>)[path.extname(filename)]??'application/octet-stream';
      return new Response(content,{headers:{'Content-Type':mime,'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'"}});
    } catch{return new Response('Not found',{status:404});}
  });
  // Leave the guard false if synchronous registration fails, allowing retry.
  courseProtocolRegistered=true;
}
async function createWindow() {
    const { bounds: initialBounds, workArea: area }=fittedBounds(undefined);
    ensureCourseProtocol();
    window=new BrowserWindow({title:'Claude Country Club',...initialBounds,minWidth:Math.min(520,area.width),minHeight:Math.min(480,area.height),backgroundColor:'#f5f2e9',show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,spellcheck:false}});
    const created = window;
    restoreBounds('dashboard');
    let boundsTimer: ReturnType<typeof setTimeout> | undefined;
    const remember=()=>{if(boundsTimer)clearTimeout(boundsTimer);boundsTimer=setTimeout(()=>{if(window===created)rememberBounds();},250);boundsTimer.unref();};
    window.on('move',remember);window.on('resize',remember);
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('ccc://app/'))event.preventDefault();});
    window.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('ccc://app/')&&!details.url.startsWith('devtools://')}));
    window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    window.webContents.session.setPermissionCheckHandler(()=>false);
    window.webContents.on('render-process-gone',()=>{if(window!==created)return;rendererCrashed=true;practice=false;suspended=true;cancelEligibility();registry.disconnect();window?.hide();diagnose('RENDERER_STOPPED','The course paused after a display problem. Open Country Club from its tray icon to recover the last saved position.');});
    window.on('close',event=>{if(!quitting){event.preventDefault();dismissedWait=waitKey();practice=false;void freezeAndHide();}});

    try { await created.loadURL('ccc://app/index.html'); }
    catch(error) {
      // A failed load must not become the healthy window reused by later opens.
      // Never clear or destroy a replacement belonging to a newer attempt.
      if(window===created){window=undefined;rendererCrashed=true;practice=false;suspended=true;freezeVersion++;cancelEligibility();if(!created.isDestroyed())created.destroy();}
      throw error;
    }
}
if (windowWorkerMode) runWindowWorker();
else app.whenReady().then(async()=> {
  const background=process.argv.includes('--ccc-background') || (!testing && process.platform==='darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
  try {
    screen.on('display-removed',repairBounds);
    screen.on('display-metrics-changed',repairBounds);
    bindSystemLifecycle(powerMonitor,{hold:systemHold,lockKnowledge:known=>{
      lockStateKnown=known;
      if(!known)diagnose('LOCK_STATE_UNKNOWN','Automatic play is paused because screen lock state is unavailable. Practice remains available; a lock or unlock notification can restore detection.');
    }});
    try {store=new Store(dataDir);} catch(error) {
      if(!(error instanceof RecoverableStorageError))throw error;
      if(background || systemHolds.size || !await confirmStorageRecovery()){quitting=true;app.quit();return;}
      const archive=preserveDamagedStorage(dataDir);
      store=new Store(dataDir);
      diagnose('STORAGE_RECOVERED',`Fresh rounds and preferences are ready. Original database files are preserved in ${archive}.`);
    }
    const history=await diagnosticLog.initialize();
    if(quitting || quitPending){queuedOpen=undefined;return;}
    for(const entry of [...diagnostics].reverse())diagnosticLog.append(entry);
    diagnostics.push(...history);diagnostics.splice(80);
    selected=store.settings().selectedSession;
    integrations=new IntegrationManager({dataDir,helperPath:helperPath(),...(testing&&process.env.CCC_TEST_HOME?{homeDir:process.env.CCC_TEST_HOME}:{})});
    await refreshIntegrations();
    if(quitting || quitPending){queuedOpen=undefined;return;}
    installIPC();
    // IPC and startup state are ready; createWindow installs the course protocol
    // before creating a renderer. Consume the latest queued request once.
    uiReady=true;
    const initialOpen=queuedOpen ?? (!background && !startupOpenSuppressed?'dashboard':undefined);
    queuedOpen=undefined;openedByUser=false;
    if(initialOpen)await requestOpen(initialOpen);
    if(quitting || quitPending)return;
    publish();
    const icon=nativeImage.createFromPath(path.join(__dirname,'icon.png')).resize({width:20,height:20});
    tray=new Tray(icon);tray.setToolTip('Claude Country Club');
    tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Country Club',click:()=>void requestOpen('dashboard')},{label:'Practice a round',click:()=>void requestOpen('practice')},{label:'Pause automatic play',click:()=>{store.setSettings({automatic:false});reconcile();}},{type:'separator'},{label:'Quit',click:()=>app.quit()}]));
    tray.on('click',()=>void requestOpen('dashboard'));
    try {await startBroker();} catch {diagnose('BROKER_UNAVAILABLE','Automatic connections are unavailable. Practice still works. Repair the application to restore the helper.');}
    if (testing && workerRenderer && process.env.CCC_WINDOW_WORKER_SMOKE==='1') { await runWindowWorkerSmoke(); return; }
    if (testing && process.env.CCC_WINDOW_WORKER_CONTROLLER_PROBE==='1') { await runWindowWorkerControllerProbe(); app.quit(); return; }
    const interval=setInterval(()=>{if(registry.expire())reconcile();},60_000);interval.unref();
  } catch(error) { if(!background && systemHolds.size===0)dialog.showErrorBox('Country Club could not start',error instanceof Error?error.message:'Your saved data was preserved. Please repair the application.');quitting=true;app.quit(); }
});
if (!windowWorkerMode) {
app.on('second-instance',(_event,args)=>{if(args.includes('--ccc-installer-quit'))app.quit();else void requestOpen('dashboard');});
app.on('activate',()=>void requestOpen('dashboard'));
app.on('window-all-closed',()=>{});
app.on('before-quit',event=>{
  if(!quitting && store){
    event.preventDefault();if(quitPending)return;quitPending=true;practice=false;
    const save=window && !window.isDestroyed()?freezeAndHide():Promise.resolve();
    void save.finally(async()=>{
      // Diagnostic I/O cannot hold quitting indefinitely or delay gameplay saves.
      await Promise.race([diagnosticLog.flush(),new Promise(resolve=>setTimeout(resolve,500))]);
      quitting=true;app.quit();
    });return;
  }
  quitting=true;windowWorkerChild?.kill();broker?.stdin.end();broker?.kill();try{store?.close();}catch{};tray?.destroy();
});
}
