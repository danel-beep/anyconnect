import type { Child } from 'hono/jsx';
import { createContext } from 'hono/jsx';

/**
 * Lets a route render a stand-alone page (security settings, confirmations) inside the dashboard
 * layout: the route provides a frame, `Layout` uses it instead of its own centered shell.
 */
export type Frame = (page: {
  title: string;
  passkeys: boolean;
  /** Reloads the page every this many seconds (pages that wait for something elsewhere). */
  refreshSeconds?: number;
  children?: Child;
}) => Child;

export const PageFrame = createContext<Frame | null>(null);
