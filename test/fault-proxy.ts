import net from 'node:net';

/**
 * A TCP proxy in front of a real service (Postgres in the outage tests) that a test can cut and
 * restore: `cut()` drops every open connection and refuses new ones, as when the database restarts
 * or the network between the hub and it fails; `restore()` lets connections through again.
 */
export class FaultProxy {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private down = false;
  port = 0;

  private constructor(private readonly target: { host: string; port: number }) {
    this.server = net.createServer((client) => {
      if (this.down) {
        client.destroy();
        return;
      }
      const upstream = net.connect(this.target.port, this.target.host);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
  }

  /** Starts a proxy to the host and port of `url` (a `postgres://` URL). */
  static async start(url: string): Promise<FaultProxy> {
    const parsed = new URL(url);
    const proxy = new FaultProxy({ host: parsed.hostname, port: Number(parsed.port || 5432) });
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    proxy.port = (proxy.server.address() as net.AddressInfo).port;
    return proxy;
  }

  /** `url` with its host and port pointing at this proxy. */
  url(url: string): string {
    const parsed = new URL(url);
    parsed.hostname = '127.0.0.1';
    parsed.port = String(this.port);
    return parsed.toString();
  }

  cut(): void {
    this.down = true;
    for (const socket of this.sockets) socket.destroy();
  }

  /**
   * A network partition: open connections stay open but nothing gets through any more (no reset,
   * as when packets are dropped), and new ones are refused. `restore()` lets new connections in;
   * the frozen ones stay dead, like half-open TCP connections after a partition.
   */
  freeze(): void {
    this.down = true;
    for (const socket of this.sockets) {
      socket.unpipe();
      socket.removeAllListeners('data');
      socket.pause();
    }
  }

  restore(): void {
    this.down = false;
  }

  async close(): Promise<void> {
    this.cut();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
