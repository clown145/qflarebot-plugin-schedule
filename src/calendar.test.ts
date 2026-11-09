import { describe, expect, it } from 'vitest'
import { parseCalendar } from './calendar.js'
import { readCalendarFile, MAX_FILE_BYTES } from './calendar-input.js'

const now = Date.parse('2026-11-09T12:00:00+08:00')
const ics = (...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n')

describe('ICS 课表', () => {
  it('按北京时间读取 UTC、浮动时间与没有 VTIMEZONE 的 Asia/Shanghai', () => {
    const events = parseCalendar(ics(
      'BEGIN:VEVENT', 'UID:a', 'DTSTART:20261109T000000Z', 'DTEND:20261109T014000Z',
      'SUMMARY:计\r\n 算机专业导论', 'LOCATION:南校区\\, 西区104', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:b', 'DTSTART:20261116T140000', 'DURATION:PT100M',
      'SUMMARY:心理健康', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:c', 'DTSTART;TZID=Asia/Shanghai:20261121T140000', 'DURATION:PT100M',
      'SUMMARY:形势与政策', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:d', 'DTSTART;VALUE=DATE:20261109', 'SUMMARY:全天活动', 'END:VEVENT',
    ), now)
    expect(events.map(event => [event.title, new Date(event.start).toISOString()])).toEqual([
      ['计算机专业导论', '2026-11-09T00:00:00.000Z'],
      ['心理健康', '2026-11-16T06:00:00.000Z'],
      ['形势与政策', '2026-11-21T06:00:00.000Z'],
    ])
    expect(events[0]?.location).toBe('南校区, 西区104')
    expect(events[2]?.end).toBe(Date.parse('2026-11-21T15:40:00+08:00'))
  })

  it('展开双周 RRULE，保留补课和改期并排除取消的日期', () => {
    const events = parseCalendar(ics(
      'BEGIN:VEVENT', 'UID:weekly', 'DTSTART:20261102T060000Z', 'DTEND:20261102T074000Z',
      'SUMMARY:心理健康', 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4',
      'EXDATE:20261116T060000Z', 'RDATE:20261216T060000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:weekly', 'RECURRENCE-ID:20261130T060000Z',
      'DTSTART:20261201T060000Z', 'DTEND:20261201T074000Z',
      'SUMMARY:心理健康（调课）', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:weekly', 'RECURRENCE-ID:20261214T060000Z', 'STATUS:CANCELLED', 'END:VEVENT',
    ), now)
    expect(events.map(event => new Date(event.start).toISOString().slice(0, 10)))
      .toEqual(['2026-11-02', '2026-12-01', '2026-12-16'])
    expect(events[1]?.title).toBe('心理健康（调课）')
  })

  it('遇到未知时区和超限请求时明确拒绝', async () => {
    expect(() => parseCalendar(ics('BEGIN:VEVENT', 'UID:a', 'DTSTART;TZID=Custom:20261109T080000', 'END:VEVENT'), now))
      .toThrow('缺少时区定义')
    const request = new Request('https://example.test', { method: 'POST', body: new Uint8Array(MAX_FILE_BYTES + 1) })
    await expect(readCalendarFile(request)).rejects.toThrow('256 KiB')
  })
})
