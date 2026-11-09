import ICAL from 'ical.js'
import { DAY_MS, SHANGHAI_OFFSET } from './calendar-input.js'
import type { ClassEvent } from './calendar-input.js'

const MAX_CLASSES = 1_500
const MAX_ITERATIONS = 8_000

function timestamp(time: InstanceType<typeof ICAL.Time>): number {
  return time.toUnixTime() * 1000 - (time.zone === ICAL.Timezone.localTimezone ? SHANGHAI_OFFSET : 0)
}

function eventText(value: string | null, max: number): string {
  return (value ?? '').replace(/[\s\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, max)
}

function cancelled(event: InstanceType<typeof ICAL.Event>): boolean {
  const status = event.component.getFirstPropertyValue('status')
  return typeof status === 'string' && status.toUpperCase() === 'CANCELLED'
}

export function parseCalendar(text: string, now: number): ClassEvent[] {
  const calendar = new ICAL.Component(ICAL.parse(text.replace(/^\uFEFF/, '')))
  if (calendar.name !== 'vcalendar') throw new Error('请选择一个 iCalendar (.ics) 文件。')

  const components = calendar.getAllSubcomponents('vevent')
  const dates = ['dtstart', 'dtend', 'recurrence-id', 'rdate', 'exdate']
  for (const component of components) {
    for (const name of dates) {
      for (const property of component.getAllProperties(name)) {
        const zone = property.getParameter('tzid')
        if (zone && (typeof zone !== 'string' || (zone !== 'Asia/Shanghai' && !calendar.getTimeZoneByID(zone)))) {
          throw new Error('ICS 缺少时区定义：' + zone + '。请用包含时区的导出，或导出为 UTC。')
        }
        if (property.type === 'period' || property.getParameter('range')) {
          throw new Error('此 ICS 包含时间段 RDATE 或批量重复事件改期，请先导出为单次事件。')
        }
      }
    }
  }
  // 部分导出工具省略中国标准时间的 VTIMEZONE。把定义限制在当前文件里。
  if (!calendar.getTimeZoneByID('Asia/Shanghai')) {
    calendar.addSubcomponent(new ICAL.Component(ICAL.parse([
      'BEGIN:VTIMEZONE', 'TZID:Asia/Shanghai', 'BEGIN:STANDARD',
      'DTSTART:19920101T000000', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800',
      'END:STANDARD', 'END:VTIMEZONE',
    ].join('\r\n'))))
  }

  const events = components.map(component => new ICAL.Event(component, { exceptions: [] }))
  const overrides = new Map<string, Set<number>>()
  for (const event of events) {
    if (!event.uid) throw new Error('ICS 有缺少 UID 的日程。')
    if (!event.isRecurrenceException()) continue
    const times = overrides.get(event.uid) ?? new Set<number>()
    const original = timestamp(event.recurrenceId)
    if (times.has(original)) throw new Error('ICS 包含重复的改期记录。')
    times.add(original)
    overrides.set(event.uid, times)
  }

  const output = new Map<string, ClassEvent>()
  function add(event: InstanceType<typeof ICAL.Event>, startTime: InstanceType<typeof ICAL.Time>, endTime: InstanceType<typeof ICAL.Time>) {
    const start = timestamp(startTime)
    const end = timestamp(endTime)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new Error('ICS 有起止时间无效的日程。')
    }
    const title = eventText(event.summary, 100) || '未命名课程'
    const location = eventText(event.location, 100)
    output.set(JSON.stringify([event.uid, start, end, title, location]), { title, location, start, end })
    if (output.size > MAX_CLASSES) throw new Error('课程超过 1500 条，请按学期分别导出。')
  }

  const earliest = now - 180 * DAY_MS
  const latest = now + 366 * DAY_MS
  let steps = 0
  const masters = new Set<string>()
  for (const event of events) {
    if (cancelled(event)) continue
    const start = event.startDate
    if (!start) throw new Error('ICS 有缺少 DTSTART 的日程。')
    if (start.isDate) continue
    if (event.isRecurrenceException() || !event.isRecurring()) {
      add(event, start, event.endDate)
      continue
    }
    if (masters.has(event.uid)) throw new Error('ICS 包含重复的周期课程。')
    masters.add(event.uid)
    const iterator = event.iterator()
    let occurrence = iterator.next()
    while (occurrence && timestamp(occurrence) < latest) {
      if (++steps > MAX_ITERATIONS) throw new Error('重复课程过多，请缩小导出的日期范围。')
      const time = timestamp(occurrence)
      if (time >= earliest && !overrides.get(event.uid)?.has(time)) {
        const details = event.getOccurrenceDetails(occurrence)
        add(event, details.startDate, details.endDate)
      }
      occurrence = iterator.next()
    }
  }
  if (!output.size) throw new Error('文件里没有带具体时间的课程。')
  return [...output.values()].sort((a, b) => a.start - b.start || a.end - b.end || a.title.localeCompare(b.title))
}
