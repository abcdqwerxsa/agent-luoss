// Eventbus: streams AgentEvents to the task service via client-streaming
// gRPC (PushEvents). Buffers while disconnected; bounded, drops oldest.
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

export interface OutEvent {
  taskId: string;
  sessionId?: string;
  type: string;
  payload: string;
  timestamp: number;
}

export class EventBus {
  private client: any;
  private stream: any = null;
  private queue: OutEvent[] = [];
  private readonly maxQueue = 10_000;

  constructor(
    private protoDir: string,
    private taskAddr: string,
    private runtimeId: string,
    private advertiseAddr: string,
  ) {
    const def = protoLoader.loadSync(`${protoDir}/task.proto`, {
      includeDirs: [protoDir],
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = grpc.loadPackageDefinition(def) as any;
    this.client = new pkg.agentluoss.v1.task.Task(
      taskAddr,
      grpc.credentials.createInsecure(),
    );
  }

  // register once + heartbeat loop (interval ms). Never throws; logs failures.
  startRegistry(intervalMs: number): void {
    this.client.registerRuntime(
      { runtimeId: this.runtimeId, address: this.advertiseAddr },
      (err: any) => {
        if (err) console.warn("[registry] register failed:", err.message);
      },
    );
    setInterval(() => this.heartbeatOnce(), intervalMs);
  }

  // The pool reports live counts so heartbeats carry real load.
  private getActive: () => { active: number; max: number } = () => ({ active: 0, max: 0 });
  setActiveProvider(fn: () => { active: number; max: number }): void {
    this.getActive = fn;
  }

  heartbeatOnce(): void {
    const { active, max } = this.getActive();
    this.client.runtimeHeartbeat(
      { runtimeId: this.runtimeId, activeSessions: active, maxSessions: max },
      (err: any) => {
        if (err) console.warn("[registry] heartbeat failed:", err.message);
      },
    );
  }

  push(ev: OutEvent): void {
    this.queue.push(ev);
    if (this.queue.length > this.maxQueue) {
      console.warn("[eventbus] queue overflow, dropping", this.queue.length - this.maxQueue, "events");
      this.queue.splice(0, this.queue.length - this.maxQueue);
    }
    this.flush();
  }

  private flush(): void {
    if (!this.stream) this.connect();
    while (this.stream && this.queue.length > 0) {
      const ok = this.stream.write(this.queue[0]);
      this.queue.shift();
      if (!ok) {
        // buffer full inside grpc — wait for drain
        this.stream.once("drain", () => this.flush());
        return;
      }
    }
  }

  private connect(): void {
    if (this.stream) return;
    const stream = this.client.pushEvents((err: any, resp: any) => {
      // server ended the stream (resp delivered) or errored
      console.warn("[eventbus] pushEvents ended:", err?.message ?? "server closed");
      this.stream = null;
      setTimeout(() => this.flush(), 1000);
    });
    stream.on("error", () => {
      /* handled by callback */
    });
    this.stream = stream;
  }
}
