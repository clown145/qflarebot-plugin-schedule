export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>课程表</title>
<link rel="stylesheet" href="/tokens.css">
<style>
  main { max-width: 46rem; margin: auto; padding: var(--qb-space-4); }
  section { padding: var(--qb-space-4); margin-block: var(--qb-space-3); }
  h1, h2 { margin-top: 0; }
  label { display: block; font-weight: 600; margin-bottom: var(--qb-space-2); }
  input { display: block; max-width: 100%; margin-bottom: var(--qb-space-3); }
  .hint { color: var(--qb-fg-muted); }
</style>
</head>
<body class="qb-page">
<main>
  <h1>课程表</h1>
  <section class="qb-card" aria-labelledby="import-title">
    <h2 id="import-title">导入课表</h2>
    <p id="current" role="status">正在读取当前课表…</p>
    <form id="upload">
      <label for="file">iCalendar 文件</label>
      <input id="file" type="file" accept=".ics,text/calendar" aria-describedby="file-help" required>
      <p id="file-help" class="hint">最大 256 KiB。导入成功后会替换当前课表。</p>
      <button id="submit" class="qb-btn" type="submit" disabled>导入并替换课表</button>
    </form>
    <p id="result" role="status"></p>
  </section>
  <section class="qb-card" aria-labelledby="reminder-title">
    <h2 id="reminder-title">QQ 提醒</h2>
    <p>私聊发送 <code>/课表 提醒 开启</code>，这条会话就会接收提醒。</p>
    <p>有课当天默认北京时间 07:00 发一条汇总，发送时间可在插件设置里修改。</p>
    <p><code>/课表 今日</code> 和 <code>/课表 明日</code> 可随时查课。</p>
  </section>
</main>
<script type="module">
  import { createBridge } from '/bridge.js'
  const file = document.getElementById('file')
  const submit = document.getElementById('submit')
  const result = document.getElementById('result')
  const current = document.getElementById('current')
  try {
    const bridge = await createBridge()
    bridge.setTitle('课程表')
    function show(data) {
      current.textContent = data.count
        ? '当前课表 · ' + data.count + ' 次课 · ' + data.first + ' 至 ' + data.last
        : '还没有导入课表。'
    }
    file.addEventListener('change', () => {
      const chosen = file.files[0]
      const valid = chosen && chosen.name.toLowerCase().endsWith('.ics') && chosen.size > 0 && chosen.size <= 262144
      file.setAttribute('aria-invalid', chosen && !valid ? 'true' : 'false')
      result.textContent = chosen && !valid ? '请选择非空且不超过 256 KiB 的 .ics 文件。' : ''
      submit.disabled = !valid
    })
    document.getElementById('upload').addEventListener('submit', async (event) => {
      event.preventDefault()
      if (submit.disabled) return
      submit.disabled = file.disabled = true
      result.textContent = '正在导入…'
      try {
        const res = await bridge.fetch('/api/import', { method: 'POST', body: file.files[0] })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
        show(data)
        result.textContent = '导入成功。'
        file.value = ''
      } catch (error) {
        result.textContent = '导入失败。' + error.message
      } finally {
        file.disabled = false
        submit.disabled = !file.files.length
      }
    })
    const res = await bridge.fetch('/api/status')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    show(await res.json())
  } catch (error) {
    current.textContent = '读取课表失败。' + error.message
  }
</script>
</body>
</html>`
