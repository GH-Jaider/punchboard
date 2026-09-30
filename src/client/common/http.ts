// Typed JSON requests for pages on this computer (Control Center, pairing).
// The deck signs its requests and has its own client in deck/api.ts.
import type { ErrorResponse } from "../../shared/api.ts"

/** An error reply from the companion, with its HTTP status and body. */
export class ApiError extends Error {
  readonly status: number
  readonly body: Partial<ErrorResponse>
  constructor(status: number, body: Partial<ErrorResponse>) {
    super(body.error || `Request failed (${status})`)
    this.status = status
    this.body = body
  }
}

export async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiError(response.status, { error: `The companion sent an unreadable reply (${response.status}).` })
  }
  if (!response.ok) throw new ApiError(response.status, (body ?? {}) as Partial<ErrorResponse>)
  return body as T
}

export interface JsonOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE"
  /** Sent as JSON with the right Content-Type. */
  json?: unknown
  /** Raw body with its own Content-Type header. */
  body?: BodyInit
  headers?: Record<string, string>
}

export async function request<T>(url: string, options: JsonOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers }
  let body = options.body
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json"
    body = JSON.stringify(options.json)
  }
  const response = await fetch(url, { method: options.method ?? "GET", headers, body })
  return readJson<T>(response)
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
