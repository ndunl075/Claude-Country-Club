import { AgentEvent, AgentSession } from '../../../../packages/contracts';

/** Events without source turn IDs are intentionally conservative on conflicts. */
export class SessionRegistry {
  private sessions = new Map<string, AgentSession>();
  private seen = new Map<string, number>();
  private turns = new Map<string, Set<string>>();
  accept(event: AgentEvent, now = Date.now()): boolean {
    if (event.rootSessionKey && event.rootSessionKey !== event.sessionKey) return false;
    const key = `${event.provider}:${event.sessionKey}`;
    const eventKey = `${key}:${event.eventId}`;
    for (const [id, time] of this.seen) if (now - time > 600_000) this.seen.delete(id);
    if (this.seen.has(eventKey)) return false;
    this.seen.set(eventKey, now);
    if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value!);
    const old = this.sessions.get(key);
    const turns = this.turns.get(key) ?? new Set<string>();
    if (event.kind === 'start' && event.turnId && turns.has(event.turnId)) return false;
    if (event.turnId) {
      turns.add(event.turnId);
      if (turns.size > 128) turns.delete(turns.values().next().value!);
      this.turns.set(key, turns);
    }
    const session: AgentSession = old ? { ...old } : { key, provider: event.provider, state: 'unknown', generation: 0, updatedAt: now, reliable: false };
    if (event.kind === 'start') {
      if (!event.turnId && old && ['working','unknown','attention'].includes(old.state)) {
        session.state = 'unknown'; session.reliable = false;
      } else if (old?.state === 'working' && old.turnId === event.turnId) {
        // A second unique start with no native turn identity is ambiguous, not a new wait.
        if (!event.turnId) { session.state = 'unknown'; session.reliable = false; }
      } else {
        session.state = 'working'; session.generation += 1; session.turnId = event.turnId;
        session.reliable = true;
      }
    } else {
      if (event.turnId && old?.turnId && event.turnId !== old.turnId) return false;
      switch (event.kind) {
        case 'activity':
          if (!old) return false;
          if (old.state === 'attention' && old.reliable && event.turnId && event.turnId === old.turnId) session.state = 'working';
          break;
        case 'attention': if (!old || old.state === 'working') session.state = 'attention'; break;
        case 'stop': session.state = 'stopped'; break;
        case 'failed': session.state = 'failed'; break;
        case 'interrupted': session.state = 'interrupted'; break;
        case 'session-ended': session.state = 'closed'; break;
      }
    }
    if (!old && event.turnId) session.turnId = event.turnId;
    session.source = event.adapterVersion === 'synthetic' && event.sessionKey === 'local-demo' ? 'demo' : 'local-hook';
    session.lastEventKind = event.kind;
    session.adapterVersion = event.adapterVersion;
    session.updatedAt = now; this.sessions.set(key, session);
    if (this.sessions.size > 100) {
      const candidate = [...this.sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
      this.sessions.delete(candidate.key);
      this.turns.delete(candidate.key);
    }
    return true;
  }
  expire(now = Date.now()): boolean {
    let changed = false;
    for (const s of this.sessions.values()) if (s.state === 'working' && now - s.updatedAt > 900_000) { s.state = 'unknown'; s.reliable = false; changed = true; }
    return changed;
  }
  disconnect() { for (const s of this.sessions.values()) { s.state = 'unknown'; s.reliable = false; } }
  list() { return [...this.sessions.values()].map(s => ({ ...s })); }
  get(key: string | null) { return key ? this.sessions.get(key) : undefined; }
}
