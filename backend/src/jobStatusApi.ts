/**
 * Internal job status endpoint (issue #55: "expose job status and failure
 * state through an internal/API endpoint").
 *
 * Pure request handling (no sockets) is what the tests exercise; a thin
 * node:http server wraps it for real use. Read routes:
 *
 *   GET  /health
 *   GET  /jobs?status=QUEUED&type=RULES&txHash=0x...
 *   GET  /jobs/:id
 *   GET  /jobs/:id/events          <- full audit trail for one job
 *   POST /jobs/:id/replay          <- requeue a dead-lettered/failed job
 *
 * This is deliberately internal: bind it to 127.0.0.1, not the public
 * internet. The dashboard/audit front-end talks to it the same way it
 * talks to any other read API.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import { type AnalysisType, ANALYSIS_TYPES, JOB_STATUSES, type JobStatus } from "./jobTypes.js"
import { JobStateError, type JobEngine } from "./jobEngine.js"

export class JobApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = "JobApiError"
  }
}

export interface JobApiResponse {
  status: number
  json: unknown
}

function parseId(path: string): { id: string; rest: string } | null {
  const match = path.match(/^\/jobs\/([^/]+)(\/.*)?$/)
  if (!match) return null
  return { id: decodeURIComponent(match[1]), rest: match[2] ?? "" }
}

/** Pure handler: given a request shape, returns the JSON response. No I/O,
 * no sockets - fully unit-testable. */
export function handleJobApiRequest(
  engine: JobEngine,
  method: string,
  path: string,
  query: Record<string, string> = {},
): JobApiResponse {
  try {
    if (path === "/health") {
      return { status: 200, json: { ok: true } }
    }

    if (path === "/jobs" && method === "GET") {
      const status = query.status
      if (status !== undefined && !(JOB_STATUSES as readonly string[]).includes(status)) {
        throw new JobApiError(400, `status must be one of ${JOB_STATUSES.join(", ")} (got "${status}")`)
      }
      const analysisType = query.type
      if (analysisType !== undefined && !(ANALYSIS_TYPES as readonly string[]).includes(analysisType)) {
        throw new JobApiError(400, `type must be one of ${ANALYSIS_TYPES.join(", ")} (got "${analysisType}")`)
      }
      const jobs = engine.listJobs({
        ...(status !== undefined ? { status: status as JobStatus } : {}),
        ...(analysisType !== undefined ? { analysisType: analysisType as AnalysisType } : {}),
        ...(query.txHash !== undefined ? { txHash: query.txHash } : {}),
      })
      return { status: 200, json: { count: jobs.length, jobs } }
    }

    const parsed = parseId(path)
    if (parsed) {
      const { id, rest } = parsed
      if (method === "GET" && rest === "") {
        const job = engine.getJob(id)
        if (!job) throw new JobApiError(404, `no job with id ${id}`)
        return { status: 200, json: { job } }
      }
      if (method === "GET" && rest === "/events") {
        const events = engine.eventsFor(id)
        if (events.length === 0) throw new JobApiError(404, `no job with id ${id}`)
        return { status: 200, json: { count: events.length, events } }
      }
      if (method === "POST" && rest === "/replay") {
        const job = engine.replay(id)
        return { status: 200, json: { job } }
      }
    }

    throw new JobApiError(404, `no such route: ${method} ${path}`)
  } catch (error) {
    if (error instanceof JobStateError) return { status: 409, json: { error: error.message } }
    if (error instanceof JobApiError) return { status: error.statusCode, json: { error: error.message } }
    throw error
  }
}

function readBody(request: IncomingMessage, limitBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new JobApiError(413, `request body too large (max ${limitBytes} bytes)`))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}

export interface JobStatusServer {
  url: string
  close(): Promise<void>
}

/** Wraps the pure handler in a real server. */
export async function startJobStatusServer(engine: JobEngine, port = 0, host = "127.0.0.1"): Promise<JobStatusServer> {
  const server: Server = createServer(async (request, response) => {
    const respond = (status: number, json: unknown): void => {
      const body = JSON.stringify(json)
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
      response.end(body)
    }
    try {
      const url = new URL(request.url ?? "/", `http://${host}:${port}`)
      const query: Record<string, string> = {}
      url.searchParams.forEach((value, key) => {
        query[key] = value
      })
      if (request.method === "POST") {
        await readBody(request) // replay needs no body; drain it so the client can finish
      }
      const result = handleJobApiRequest(engine, request.method ?? "GET", url.pathname, query)
      respond(result.status, result.json)
    } catch (error) {
      respond(error instanceof JobApiError ? error.statusCode : 500, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  const address = server.address()
  const actualPort = typeof address === "object" && address ? address.port : port

  return {
    url: `http://${host}:${actualPort}`,
    close() {
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}
