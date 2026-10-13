import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '../apps/desktop/src/main/sessions';
import { AgentEvent, validateEvent } from '../packages/contracts';
let serial=0;
const event = (kind: AgentEvent['kind'], extra: Partial<AgentEvent> = {}): AgentEvent => ({ protocolVersion:1, eventId:`e${serial++}`,provider:'codex',adapterVersion:'1',sessionKey:'test',turnId:'turn1',kind,...extra });
describe('root session lifecycle', () => {
  it('does not retain turn history for rejected unknown activity sessions', () => {
    const r = new SessionRegistry();
    for (let i = 0; i < 5000; i++) {
      expect(r.accept(event('activity', { sessionKey: `unknown-${i}`, turnId: `turn-${i}` }), i)).toBe(false);
    }
    expect(r.list()).toEqual([]);
    // The memory bound includes auxiliary indexes, not only visible sessions.
    expect((Reflect.get(r, 'turns') as Map<string, Set<string>>).size).toBe(0);
    expect((Reflect.get(r, 'seen') as Map<string, number>).size).toBeLessThanOrEqual(4096);
  });
  it('does not let a rejected mismatched event consume a future turn identity', () => {
    const r = new SessionRegistry();
    expect(r.accept(event('start'))).toBe(true);
    expect(r.accept(event('activity', { turnId: 'turn2' }))).toBe(false);
    expect(r.accept(event('start', { turnId: 'turn2' }))).toBe(true);
    expect(r.get('codex:test')).toMatchObject({ state: 'working', turnId: 'turn2', generation: 2 });
  });
  it('does not let an old stop finish a new turn', () => { const r=new SessionRegistry(); r.accept(event('start')); r.accept(event('start',{turnId:'turn2'})); r.accept(event('stop')); expect(r.get('codex:test')?.state).toBe('working'); });
  it('deduplicates events and ignores subagent completion', () => { const r=new SessionRegistry(), e=event('start'); r.accept(e); expect(r.accept(e)).toBe(false); r.accept(event('stop',{rootSessionKey:'parent'})); expect(r.get('codex:test')?.state).toBe('working'); });
  it('requires correlated evidence to resume attention', () => { const r=new SessionRegistry(); r.accept(event('start')); r.accept(event('attention')); r.accept(event('activity',{turnId:undefined})); expect(r.get('codex:test')?.state).toBe('attention'); r.accept(event('activity')); expect(r.get('codex:test')?.state).toBe('working'); });
  it('marks ambiguous starts and stale sessions unknown', () => { const r=new SessionRegistry(); r.accept(event('start',{turnId:undefined}),0); r.accept(event('start',{turnId:undefined}),1); expect(r.get('codex:test')?.reliable).toBe(false); r.accept(event('start'),10); r.expire(900_011); expect(r.get('codex:test')?.state).toBe('unknown'); });
  it('keeps independent sessions separate and clears connection loss', () => { const r=new SessionRegistry(); r.accept(event('start')); r.accept(event('start',{sessionKey:'other'})); r.accept(event('stop')); expect(r.get('codex:other')?.state).toBe('working'); r.disconnect(); expect(r.get('codex:other')?.state).toBe('unknown'); });
  it('rejects invalid input and drops unapproved fields', () => { expect(()=>validateEvent({...event('start'),sessionKey:'../bad'})).toThrow(); expect(validateEvent({...event('start'),prompt:'SECRET'})).not.toHaveProperty('prompt'); });
});

describe('automatic session selection', () => {
  it('follows a new session after the selected one ends', () => { const r=new SessionRegistry(); r.accept(event('start',{sessionKey:'first',turnId:'a'})); let selected=r.autoSelect(null); expect(selected).toBe('codex:first'); r.accept(event('session-ended',{sessionKey:'first',turnId:'a'})); r.accept(event('start',{sessionKey:'second',turnId:'b'})); selected=r.autoSelect(selected); expect(selected).toBe('codex:second'); });
  it('follows the working session when a remembered choice is unknown after restart', () => { const r=new SessionRegistry(); r.accept(event('start',{sessionKey:'fresh',turnId:'c'})); expect(r.autoSelect('codex:yesterday')).toBe('codex:fresh'); });
  it('keeps a live selection between turns and stays put when several sessions work', () => { const r=new SessionRegistry(); r.accept(event('start',{sessionKey:'mine',turnId:'d'})); r.accept(event('stop',{sessionKey:'mine',turnId:'d'})); r.accept(event('start',{sessionKey:'other',turnId:'e'})); expect(r.autoSelect('codex:mine')).toBe('codex:mine'); r.accept(event('start',{sessionKey:'third',turnId:'f'})); expect(r.autoSelect(null)).toBe(null); });
});
