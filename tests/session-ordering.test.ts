import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '../apps/desktop/src/main/sessions';
import type { AgentEvent } from '../packages/contracts';

let counter = 0;
const event = (kind: AgentEvent['kind'], patch: Partial<AgentEvent> = {}): AgentEvent => ({ protocolVersion: 1, provider: 'codex', adapterVersion: '1', sessionKey: 'root', turnId: 'turn-a', eventId: `order-${++counter}`, kind, ...patch });
const state = (r: SessionRegistry) => r.get('codex:root');
const terminalKinds = ['stop', 'failed', 'interrupted', 'session-ended'] as const;

describe('conservative root lifecycle ordering', () => {
  it('an unidentified start cannot replace an active identified turn',()=>{
    const r=new SessionRegistry();r.accept(event('start'),100);r.accept(event('start',{turnId:undefined}),200);
    expect(state(r)?.state).toBe('unknown');expect(state(r)?.reliable).toBe(false);
  });
  it.each(terminalKinds)('a delayed start cannot reopen a %s turn', kind => {
    const r = new SessionRegistry();
    r.accept(event('start'), 100); r.accept(event(kind), 200);
    r.accept(event('start'), 300);
    expect(state(r)?.state).not.toBe('working');
  });

  it.each(terminalKinds)('remembers %s before its delayed start arrives', kind => {
    const r = new SessionRegistry();
    r.accept(event(kind), 100); r.accept(event('start'), 200);
    expect(state(r)?.state).not.toBe('working');
    // A genuinely new native turn can still start in this root session.
    r.accept(event('start', { turnId: 'turn-b' }), 300);
    expect(state(r)?.state).toBe('working'); expect(state(r)?.turnId).toBe('turn-b');
  });

  it('an earlier turn cannot replace a newer active turn or alter its generation', () => {
    const r = new SessionRegistry();
    r.accept(event('start'), 100); r.accept(event('start', { turnId: 'turn-b' }), 200);
    const current = { ...state(r)! };
    r.accept(event('start'), 300);
    expect(state(r)).toEqual(current);
    r.accept(event('stop'), 400);
    expect(state(r)?.state).toBe('working'); expect(state(r)?.turnId).toBe('turn-b');
  });

  it('attention received before its delayed start cannot be overridden', () => {
    const r = new SessionRegistry();
    r.accept(event('attention'), 100); r.accept(event('start'), 200);
    expect(state(r)?.state).not.toBe('working');
    r.accept(event('activity'), 300);
    // No trusted start was accepted: activity alone cannot establish eligibility.
    expect(state(r)?.state).not.toBe('working');
  });

  it('repeated unidentified starts remain ambiguous instead of alternating back to working', () => {
    const r = new SessionRegistry();
    r.accept(event('start', { turnId: undefined }), 100);
    r.accept(event('start', { turnId: undefined }), 200);
    expect(state(r)?.reliable).toBe(false);
    r.accept(event('start', { turnId: undefined }), 300);
    expect(state(r)?.state).not.toBe('working'); expect(state(r)?.reliable).toBe(false);
  });

  it('same-turn duplicate starts cannot dismiss attention or refresh working evidence', () => {
    const r = new SessionRegistry();
    r.accept(event('start'), 100); r.accept(event('start'), 200);
    expect(state(r)?.updatedAt).toBe(100);
    r.accept(event('attention'), 300); r.accept(event('start'), 400);
    expect(state(r)?.state).toBe('attention');
    r.accept(event('activity', { turnId: undefined }), 500);
    expect(state(r)?.state).toBe('attention');
    r.accept(event('activity'), 600);
    expect(state(r)?.state).toBe('working');
  });

  it('a repeated start cannot revive an expired or disconnected native turn', () => {
    const r = new SessionRegistry();
    r.accept(event('start'), 0); expect(r.expire(900001)).toBe(true);
    r.accept(event('start'), 900002);
    expect(state(r)?.state).not.toBe('working');
    r.accept(event('start', { turnId: 'turn-b' }), 900003); r.disconnect();
    r.accept(event('start', { turnId: 'turn-b' }), 900004);
    expect(state(r)?.state).not.toBe('working');
  });

  it('event deduplication is scoped to the root session and provider', () => {
    const r = new SessionRegistry();
    r.accept(event('start', { eventId: 'shared-id', sessionKey: 'other' }), 100);
    r.accept(event('start'), 200);
    r.accept(event('stop', { eventId: 'shared-id' }), 300);
    expect(state(r)?.state).not.toBe('working');
  });

  it('ignored subagent traffic cannot poison root event deduplication', () => {
    const r = new SessionRegistry(); r.accept(event('start'), 100);
    r.accept(event('stop', { eventId: 'shared-id', rootSessionKey: 'parent' }), 200);
    r.accept(event('stop', { eventId: 'shared-id' }), 300);
    expect(state(r)?.state).not.toBe('working');
  });

  it('unidentified activity never resumes attention and unidentified terminals hide', () => {
    const r = new SessionRegistry();
    r.accept(event('start', { turnId: undefined }), 100);
    r.accept(event('attention', { turnId: undefined }), 200);
    r.accept(event('activity', { turnId: undefined }), 300);
    expect(state(r)?.state).toBe('attention');
    r.accept(event('stop', { turnId: undefined }), 400);
    expect(state(r)?.state).not.toBe('working');
  });

  it('subagents and other roots cannot end the selected root wait', () => {
    const r = new SessionRegistry(); r.accept(event('start'), 100);
    r.accept(event('stop', { sessionKey: 'child', rootSessionKey: 'root' }), 200);
    r.accept(event('stop', { sessionKey: 'other' }), 300);
    expect(state(r)?.state).toBe('working');
  });
});
