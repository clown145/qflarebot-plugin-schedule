export const MAX_FILE_BYTES = 256 * 1024
export const DAY_MS = 86_400_000
export const SHANGHAI_OFFSET = 8 * 3_600_000

export interface ClassEvent {
  title: string
  location: string
  start: number
  end: number
}

export function localDateTime(timestamp: number): string {
  return new Date(timestamp + SHANGHAI_OFFSET).toISOString()
}

export async function readCalendarFile(request: Request): Promise<string> {
  if (!request.body) throw new Error('请选择一个 ICS 文件。')
  if (Number(request.headers.get('content-length')) > MAX_FILE_BYTES) {
    throw new Error('ICS 文件最多 256 KiB。')
  }
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_FILE_BYTES) {
        await reader.cancel()
        throw new Error('ICS 文件最多 256 KiB。')
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}
