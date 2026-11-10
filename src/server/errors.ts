export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export const bad = (message: string, code = 'BAD_REQUEST', details?: unknown) => new AppError(400, code, message, details);
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string, code = 'CONFLICT', details?: unknown) => new AppError(409, code, message, details);
