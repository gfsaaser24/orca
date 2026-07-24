import http from 'node:http'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export type CpaManagementErrorCode =
  | 'key-mismatch'
  | 'auth-budget-exhausted'
  | 'http'
  | 'transport'
  | 'invalid-json'

export class CpaManagementError extends Error {
  constructor(
    message: string,
    readonly code: CpaManagementErrorCode,
    readonly status?: number
  ) {
    super(message)
    this.name = 'CpaManagementError'
  }
}

type CpaHttpResponse = {
  status: number
  body: string
}

type CpaHttpTransportOptions = {
  port: number
  timeoutMs?: number
  onVersion?: (version: string) => void
}

export class CpaHttpTransport {
  private readonly timeoutMs: number

  constructor(private readonly options: CpaHttpTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  request(
    method: string,
    requestPath: string,
    headers: http.OutgoingHttpHeaders = {},
    body?: string
  ): Promise<CpaHttpResponse> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: this.options.port,
          path: requestPath,
          method,
          headers
        },
        (response) => {
          let responseBody = ''
          let responseBytes = 0
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            responseBytes += Buffer.byteLength(chunk)
            if (responseBytes > MAX_RESPONSE_BYTES) {
              request.destroy(new Error(`${requestPath} response exceeded the size limit`))
              return
            }
            responseBody += chunk
          })
          response.on('end', () => {
            const version = response.headers['x-cpa-version']
            if (typeof version === 'string' && version.trim()) {
              this.options.onVersion?.(version.trim())
            }
            resolve({ status: response.statusCode ?? 0, body: responseBody })
          })
          response.on('error', (error) => {
            reject(new CpaManagementError(error.message, 'transport'))
          })
        }
      )
      request.on('error', (error) => {
        reject(new CpaManagementError(error.message, 'transport'))
      })
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error(`${requestPath} timed out`))
      })
      if (body !== undefined) {
        request.write(body)
      }
      request.end()
    })
  }

  parseJson<T>(response: CpaHttpResponse, route: string): T {
    if (response.status < 200 || response.status >= 300) {
      throw new CpaManagementError(`${route} responded ${response.status}`, 'http', response.status)
    }
    if (response.body.trim() === '') {
      return undefined as T
    }
    try {
      return JSON.parse(response.body) as T
    } catch {
      throw new CpaManagementError(
        `${route} returned invalid JSON`,
        'invalid-json',
        response.status
      )
    }
  }
}
