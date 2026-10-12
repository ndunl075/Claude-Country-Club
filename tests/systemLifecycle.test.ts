import { expect,test } from 'vitest';
import { EventEmitter } from 'node:events';
import { bindSystemLifecycle } from '../apps/desktop/src/main/systemLifecycle';
function fixture(state:string,throws=false){
  const holds=new Set<string>();let known=false;
  const monitor=Object.assign(new EventEmitter(),{getSystemIdleState:()=>{
    for(const event of ['suspend','resume','lock-screen','unlock-screen'])expect(monitor.listenerCount(event)).toBe(1);
    if(throws)throw Error('private OS error');return state;
  }});
  bindSystemLifecycle(monitor,{hold:(reason,active)=>{if(active)holds.add(reason);else holds.delete(reason);},lockKnowledge:value=>{known=value;}});
  return {monitor,holds,known:()=>known};
}
test('startup already locked is held without waiting for another lock event',()=>{
  const f=fixture('locked');expect(f.known()).toBe(true);expect([...f.holds]).toEqual(['lock']);
  f.monitor.emit('suspend');f.monitor.emit('resume');expect([...f.holds]).toEqual(['lock']);
  f.monitor.emit('unlock-screen');expect(f.holds.size).toBe(0);
});
test.each(['active','idle'])('known %s startup permits automatic eligibility without storing idle duration',state=>{
  const f=fixture(state);expect(f.known()).toBe(true);expect(f.holds.size).toBe(0);
  f.monitor.emit('lock-screen');expect(f.holds.has('lock')).toBe(true);
});
test.each([['unknown',false],['unexpected',false],['active',true]] as const)('unavailable initial state requires reliable notification: %s %s',(state,throws)=>{
  const f=fixture(state,throws);expect(f.known()).toBe(false);
  f.monitor.emit('resume');expect(f.known()).toBe(false);
  f.monitor.emit('unlock-screen');expect(f.known()).toBe(true);expect(f.holds.size).toBe(0);
});
