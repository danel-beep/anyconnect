declare module 'hoodiecrow-imap' {
  import type { Server } from 'node:net';

  export interface HoodiecrowServer {
    server: Server;
    listen(port: number, host?: string, callback?: () => void): void;
    close(callback?: () => void): void;
    address(): import('node:net').AddressInfo;
    getMailbox(path: string): { messages: { uid: number; flags: string[]; raw: string }[] } | undefined;
  }

  export default function hoodiecrow(options?: Record<string, unknown>): HoodiecrowServer;
}
