interface Monitor {
  on(event: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen', listener: () => void): unknown;
  getSystemIdleState(threshold: number): string;
}
export function bindSystemLifecycle(monitor: Monitor, callbacks: {
  hold(reason: 'sleep' | 'lock', active: boolean): void;
  lockKnowledge(known: boolean): void;
}) {
  monitor.on('suspend',()=>callbacks.hold('sleep',true));
  monitor.on('resume',()=>callbacks.hold('sleep',false));
  monitor.on('lock-screen',()=>{callbacks.lockKnowledge(true);callbacks.hold('lock',true);});
  monitor.on('unlock-screen',()=>{callbacks.lockKnowledge(true);callbacks.hold('lock',false);});
  // Subscribe before reading, and before any async startup work or window show.
  // Only locked/unknown matters; idle duration is not retained or polled.
  let state: string;
  try { state=monitor.getSystemIdleState(1); } catch { state='unknown'; }
  if(state==='locked'){callbacks.lockKnowledge(true);callbacks.hold('lock',true);}
  else if(state==='active'||state==='idle'){callbacks.lockKnowledge(true);callbacks.hold('lock',false);}
  else callbacks.lockKnowledge(false);
}
