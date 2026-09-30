// Low-level HTTP helpers: errors, JSON replies, bodies and static files.
import fs from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"
import type { ErrorResponse } from "../shared/api.ts"

export class HttpError extends Error {
  readonly status: number
  readonly extra: Omit<ErrorResponse, "error">
  constructor(status: number, message: string, extra: Omit<ErrorResponse, "error"> = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

/** A request that may carry the raw body read for signature checking. */
export type Request = IncomingMessage & { rawBody?: Buffer }

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer"
} as const

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    ...headers
  })
  res.end(data)
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png"
}

export function staticFile(res: ServerResponse, file: string): void {
  fs.readFile(file, (error, data) => {
    if (error) return sendJson(res, 404, { error: "Not found" } satisfies ErrorResponse)
    const type = STATIC_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": data.length, "Cache-Control": "no-cache" })
    res.end(data)
  })
}

/** Reads the body once and keeps it, because a signature covers the exact bytes sent. */
export function rawBody(req: Request, limit: number): Promise<Buffer> {
  if (req.rawBody) return Promise.resolve(req.rawBody)
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, "That request is too large."))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      req.rawBody = Buffer.concat(chunks)
      resolve(req.rawBody)
    })
    req.on("error", reject)
  })
}

export const JSON_LIMIT = 256 * 1024

/** JSON bodies must say so: a cross-site form can only send text/plain or form
    encodings, so this alone refuses forged form posts. The result is unknown
    and has to be validated by the caller. */
export async function jsonBody(req: Request, limit = JSON_LIMIT): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) throw new HttpError(415, "Send JSON with Content-Type: application/json.")
  const raw = await rawBody(req, limit)
  if (!raw.length) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString("utf8"))
  } catch {
    throw new HttpError(400, "That request is not valid JSON.")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "That request is not a JSON object.")
  return parsed as Record<string, unknown>
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
