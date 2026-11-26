import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import type { HealthRecorder } from "../../src/common/health.js";
import type { Clock } from "../../src/common/limiter.js";

/** Часы, которые идут только вперёд и только когда кто-то «спит». */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  constructor(public t: number) {}
  now = () => this.t;
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.t += ms;
  };
  advance(ms: number) {
    this.t += ms;
  }
}

export class MemoryHealth implements HealthRecorder {
  readonly events: Array<{ kind: "ok" | "error"; sourceId: string; message?: string; at: Date }> = [];
  async ok(sourceId: string, at: Date) {
    this.events.push({ kind: "ok", sourceId, at });
  }
  async error(sourceId: string, message: string, at: Date) {
    this.events.push({ kind: "error", sourceId, message, at });
  }
  last() {
    return this.events.at(-1);
  }
}

export const silentLog = pino({ level: "silent" });

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void;

/** Настоящий HTTP-сервер на 127.0.0.1: клиент ходит в него обычным fetch. */
export async function startServer(handler: Handler) {
  const requests: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, requests.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
