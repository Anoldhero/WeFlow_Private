export function isLoopback(hostname: string): boolean
export function validateServiceUrl(value: string, allowLoopbackHttp?: boolean): URL
export function validateClientConfig(value: unknown): { url: string; preview: boolean }
