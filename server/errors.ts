export class ServiceError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message) }
}

export function publicError(error: unknown): ServiceError {
  return error instanceof ServiceError ? error : new ServiceError('INTERNAL_ERROR', '服务暂时不可用，请稍后重试', 500)
}
