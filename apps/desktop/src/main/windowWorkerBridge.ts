import { randomBytes, randomUUID } from 'node:crypto';
import { ControllerToWindowWorker, WindowWorkerToController, isCurrentWorkerMessage } from './windowWorkerProtocol';

export interface WindowWorkerPort {
  send(message: ControllerToWindowWorker, callback: (error?: Error | null) => void): boolean;
  on(event: 'message' | 'disconnect' | 'exit' | 'error', listener: (...args: unknown[]) => void): void;
  connected?: boolean;
}

export class WindowWorkerUnavailableError extends Error {
  constructor(message = 'The course window worker is unavailable.') { super(message); this.name = 'WindowWorkerUnavailableError'; }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

// Controller-owned lifecycle for a future private inherited-IPC window worker.
// It intentionally has no Electron dependency so malformed/stale traffic can be
// tested without opening a second application process.
export class WindowWorkerBridge {
  readonly generation: number;
  readonly nonce: string;
  private ready = false;
  private stopped = false;
  private readonly pending = new Map<string, Pending>();
  private startup: Promise<void> | undefined;
  private settleStartup: Pending | undefined;

  constructor(private readonly port: WindowWorkerPort, options: { generation: number; nonce?: string; id?: () => string; onRequest?: (command: string, payload: unknown) => Promise<unknown> | unknown }) {
    this.generation = options.generation;
    this.nonce = options.nonce ?? randomBytes(24).toString('hex');
    this.id = options.id ?? randomUUID;
    this.onRequest = options.onRequest;
    port.on('message', value => this.receive(value));
    port.on('disconnect', () => this.stop('The course window worker disconnected.'));
    port.on('exit', () => this.stop('The course window worker exited.'));
    port.on('error', () => this.stop('The course window worker failed.'));
  }
  private readonly id: () => string;
  private readonly onRequest: ((command: string, payload: unknown) => Promise<unknown> | unknown) | undefined;

  async start(): Promise<void> {
    if (this.stopped) throw new WindowWorkerUnavailableError();
    if (this.ready) return;
    if (this.startup) return this.startup;
    this.startup = new Promise((resolve, reject) => {
      this.settleStartup = { resolve: () => resolve(), reject };
      void this.transmit({ protocolVersion: 1, type: 'init', generation: this.generation, nonce: this.nonce }).catch(error => this.stop(error.message));
    });
    return this.startup;
  }

  request(command: string, payload: unknown): Promise<unknown> {
    if (!this.ready || this.stopped) return Promise.reject(new WindowWorkerUnavailableError());
    const id = this.id();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.transmit({ protocolVersion: 1, type: 'command', generation: this.generation, id, command, payload }).catch(error => {
        this.pending.delete(id); reject(error);
      });
    });
  }

  private transmit(message: ControllerToWindowWorker): Promise<void> {
    if (this.stopped || this.port.connected === false) return Promise.reject(new WindowWorkerUnavailableError());
    return new Promise((resolve, reject) => {
      const accepted = this.port.send(message, error => error ? reject(new WindowWorkerUnavailableError(error.message)) : resolve());
      if (!accepted) reject(new WindowWorkerUnavailableError('The course window worker rejected a message.'));
    });
  }

  private receive(value: unknown) {
    if (this.stopped || !isCurrentWorkerMessage(value, this.generation, this.nonce)) return;
    const message: WindowWorkerToController = value;
    if (message.type === 'ready') { this.ready = true; this.settleStartup?.resolve(undefined); this.settleStartup = undefined; this.startup = undefined; return; }
    if (message.type === 'request') { void this.handleRequest(message); return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.payload);
    else pending.reject(new WindowWorkerUnavailableError(message.errorCode ?? 'The course window worker rejected the request.'));
  }

  private async handleRequest(message: Extract<WindowWorkerToController, { type: 'request' }>) {
    if (!this.ready || !this.onRequest) { await this.transmit({ protocolVersion: 1, type: 'response', generation: this.generation, id: message.id, ok: false, errorCode: 'WORKER_NOT_READY' }).catch(() => undefined); return; }
    try {
      const payload = await this.onRequest(message.command, message.payload);
      await this.transmit({ protocolVersion: 1, type: 'response', generation: this.generation, id: message.id, ok: true, payload });
    } catch {
      await this.transmit({ protocolVersion: 1, type: 'response', generation: this.generation, id: message.id, ok: false, errorCode: 'CONTROLLER_REJECTED' }).catch(() => undefined);
    }
  }

  private stop(message: string) {
    if (this.stopped) return;
    this.stopped = true; this.ready = false;
    this.settleStartup?.reject(new WindowWorkerUnavailableError(message)); this.settleStartup = undefined; this.startup = undefined;
    for (const pending of this.pending.values()) pending.reject(new WindowWorkerUnavailableError(message));
    this.pending.clear();
  }
}
