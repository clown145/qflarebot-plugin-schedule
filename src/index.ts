import { definePlugin } from '@qqbot/sdk'
import type { CronInput, PluginDB } from '@qqbot/sdk'
import { DAY_MS, localDateTime, readCalendarFile } from './calendar-input.js'
import type { ClassEvent } from './calendar-input.js'
import { PAGE_HTML } from './page.js'

interface Config {
  reminderTime: string
}

interface ScheduleRow {
  payload: string | null
  revision: string | null
  recipient: string | null
  last_day: string | null
  delivery: 'sending' | 'sent' | 'failed' | null
}

const REMINDER_TIME = '07:00'
const REMINDER_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const DELIVERY_WINDOW_MINUTES = 10
const MESSAGE_BYTES = 1800
const encoder = new TextEncoder()

function reminderTime(config: Config): string {
  return REMINDER_PATTERN.test(config.reminderTime) ? config.reminderTime : REMINDER_TIME
}

async function readState(db: PluginDB): Promise<ScheduleRow> {
  const row = await db.first<ScheduleRow>('SELECT payload, revision, recipient, last_day, delivery FROM {schedule} WHERE id = 1')
  if (!row) throw new Error('课表存储未初始化。')
  return row
}

function classesOn(payload: string, day: string): ClassEvent[] {
  const start = Date.parse(day + 'T00:00:00+08:00')
  const end = start + DAY_MS
  return (JSON.parse(payload) as ClassEvent[]).filter(event => event.start >= start && event.start < end)
}

function agenda(heading: string, day: string, events: ClassEvent[]): string {
  if (!events.length) return `${heading}（${day}）没有课。`
  const lines = [`${heading}（${day}）`]
  let bytes = encoder.encode(lines[0]!).length
  for (const [index, event] of events.entries()) {
    const start = localDateTime(event.start).slice(11, 16)
    const end = localDateTime(event.end).slice(11, 16)
    const location = event.location ? ' · ' + event.location.slice(0, 48) : ''
    const line = `${start}–${end}  ${event.title.slice(0, 48)}${location}`
    const size = encoder.encode(line).length + 1
    if (bytes + size > MESSAGE_BYTES) {
      lines.push(`还有 ${events.length - index} 项，请查看原课表。`)
      break
    }
    lines.push(line)
    bytes += size
  }
  return lines.join('\n')
}

function summary(events: ClassEvent[]) {
  return {
    count: events.length,
    first: events[0] ? localDateTime(events[0].start).slice(0, 10) : null,
    last: events.at(-1) ? localDateTime(events.at(-1)!.start).slice(0, 10) : null,
  }
}

async function remind({ ctx, scheduledAt }: CronInput<Config>) {
  const scheduledDay = localDateTime(scheduledAt).slice(0, 10)
  const todayDue = Date.parse(`${scheduledDay}T${reminderTime(ctx.config)}:00+08:00`)
  const due = scheduledAt < todayDue ? todayDue - DAY_MS : todayDue
  const day = localDateTime(due).slice(0, 10)
  const cutoff = due + DELIVERY_WINDOW_MINUTES * 60_000
  if (scheduledAt >= cutoff || Date.now() >= cutoff) return

  const row = await ctx.db.first<Pick<ScheduleRow, 'payload' | 'revision' | 'recipient'>>(
    'SELECT payload, revision, recipient FROM {schedule} WHERE id = 1 AND recipient IS NOT NULL AND (last_day IS NULL OR last_day < ?)',
    day,
  )
  if (!row?.payload || !row.recipient) return
  const recipient = row.recipient
  const events = classesOn(row.payload, day)
  if (!events.length) return

  // 先在 D1 原子占用当天的投递。QQ 主动发送没有可重放的幂等凭据。
  const claim = await ctx.db.run(
    "UPDATE {schedule} SET last_day = ?, delivery = 'sending' WHERE id = 1 AND recipient = ? AND revision = ? AND (last_day IS NULL OR last_day < ?)",
    day, recipient, row.revision, day,
  )
  if (!claim.changes) return

  let delivery: 'sent' | 'failed' = 'failed'
  try {
    const result = await ctx.api.sendMessage({ scene: 'c2c', id: recipient }, agenda('今日课程提醒', day, events))
    if (result.ok) delivery = 'sent'
    else ctx.logger.warn('QQ 课程提醒发送失败', { status: result.status, code: result.code, traceId: result.traceId })
  } catch {
    ctx.logger.warn('QQ 课程提醒发送异常')
  }
  await ctx.db.run('UPDATE {schedule} SET delivery = ? WHERE id = 1 AND last_day = ?', delivery, day)
}

export default definePlugin<Config>({
  name: 'schedule',
  displayName: '课程表',
  description: '导入 ICS 课表，在 QQ 单聊查询课程与接收每日提醒',
  permissions: ['admin', 'db', 'proactive'],
  defaultConfig: { reminderTime: REMINDER_TIME },
  configSchema: {
    type: 'object',
    properties: {
      reminderTime: {
        type: 'string', title: '每日提醒时间（北京时间）', default: REMINDER_TIME,
        pattern: REMINDER_PATTERN.source, description: '24 小时格式，例如 07:00。有课时发送当天的课程汇总。',
      },
    },
  },
  hooks: {
    async onInstall({ db }) {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS {schedule} (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload TEXT,
          revision TEXT,
          recipient TEXT,
          last_day TEXT,
          delivery TEXT
        );
      `)
      await db.run('INSERT OR IGNORE INTO {schedule} (id) VALUES (1)')
    },
  },
  commands: {
    课表: {
      aliases: ['timetable'],
      scenes: ['c2c'],
      description: '查询课程与设置提醒',
      usage: '/课表 [今日|明日|提醒 开启|提醒 关闭|提醒 状态]',
      async handler({ session, ctx, args, argText }) {
        if (session.scene !== 'c2c' || !session.canReply) return
        const recipient = session.targetId
        const command = args.join(' ')
        if (command === '提醒 开启') {
          if (!recipient) return '无法识别当前单聊，请重新打开会话再试。'
          await ctx.db.run('UPDATE {schedule} SET recipient = ? WHERE id = 1', recipient)
          return `已开启单聊提醒。有课时会在北京时间 ${reminderTime(ctx.config)} 发一条汇总。`
        }
        if (command === '提醒 关闭') {
          await ctx.db.run('UPDATE {schedule} SET recipient = NULL WHERE id = 1 AND recipient = ?', recipient)
          return '已关闭单聊提醒。'
        }
        if (command === '提醒 状态') {
          const row = await readState(ctx.db)
          const status = row.recipient ? '开启' : '关闭'
          const delivery = row.delivery === 'sent' ? '已发送' : row.delivery === 'failed' ? '发送失败' : '发送结果未知'
          return `提醒${status} · 北京时间 ${reminderTime(ctx.config)}`
            + (row.last_day ? `\n最近一次尝试（${row.last_day}）${delivery}。` : '')
        }
        if (argText && command !== '今日' && command !== '明日') {
          return '/课表 今日 · /课表 明日 · /课表 提醒 开启／关闭／状态'
        }
        const row = await readState(ctx.db)
        if (!row.payload) return '还没有导入课表。请在管理面板的「课程表」页面上传 ICS。'
        const tomorrow = command === '明日'
        const day = localDateTime(Date.now() + (tomorrow ? DAY_MS : 0)).slice(0, 10)
        return agenda(tomorrow ? '明日课程' : '今日课程', day, classesOn(row.payload, day))
      },
    },
  },
  cron: { daily: { cron: '* * * * *', handler: remind } },
  ui: { path: '/ui/', title: '课程表' },
  routes: [
    {
      method: 'GET', path: '/ui/', auth: 'admin',
      handler: () => new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    },
    {
      method: 'GET', path: '/api/status', auth: 'admin',
      async handler({ ctx }) {
        const row = await readState(ctx.db)
        return Response.json(summary(row.payload ? JSON.parse(row.payload) as ClassEvent[] : []))
      },
    },
    {
      method: 'POST', path: '/api/import', auth: 'admin',
      async handler({ ctx, request }) {
        let events: ClassEvent[]
        try {
          const text = await readCalendarFile(request)
          const { parseCalendar } = await import('./calendar.js')
          events = parseCalendar(text, Date.now())
        } catch (error) {
          const message = error instanceof Error ? error.message : '无法读取 ICS 文件。'
          return Response.json({ error: message.slice(0, 240) }, { status: 400 })
        }
        await ctx.db.run('UPDATE {schedule} SET payload = ?, revision = ? WHERE id = 1', JSON.stringify(events), crypto.randomUUID())
        return Response.json(summary(events))
      },
    },
  ],
})
