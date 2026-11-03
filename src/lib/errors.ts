/** An error whose message is safe to show to API callers. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Forbidden') => new AppError(403, 'forbidden', message);
