// 使用 Playwright 无头浏览器解析小红书视频（含 HTTP 直取 + Playwright 双层降级）
const { chromium } = require('playwright')
const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

// 单例 Chromium 浏览器实例
let _browser = null

async function getBrowser() {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    })
  }
  return _browser
}

async function closeBrowser() {
  if (_browser) {
    try { await _browser.close() } catch {}
    _browser = null
  }
}

// HTTP GET 请求工具（处理重定向、超时，优先用原生模块避免 fetch 限制）
function httpGet(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      timeout
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpGet(new URL(res.headers.location, url).href, timeout))
        return
      }
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
  })
}

// 从 HTML 中提取 Open Graph meta 标签内容
function extractMetaTag(html, property) {
  const re = new RegExp(`<meta\\s+property=["']${property}["']\\s+content=["']([^"']+)["']`, 'i')
  const m = html.match(re)
  return m ? m[1] : null
}

// 从 HTML 中提取 window.__INITIAL_STATE__ JSON 数据
function extractInitialState(html) {
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});?\s*<\/script>/)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

// 从 __INITIAL_STATE__ 对象中提取视频信息（标题、时长、封面、作者、播放地址）
function extractVideoFromState(state) {
  if (!state?.note?.noteDetailMap) return null
  const noteId = Object.keys(state.note.noteDetailMap)[0]
  if (!noteId) return null
  const note = state.note.noteDetailMap[noteId].note
  if (!note) return null
  const video = note.video
  if (!video) return null
  let videoUrl = video.media?.stream?.h264?.[0]?.master_url
  if (!videoUrl && video.consumer?.originVideoKey) {
    videoUrl = `https://sns-video-al.xhscdn.com/${video.consumer.originVideoKey}`
  }
  if (!videoUrl) return null
  return {
    title: note.title || note.displayTitle || '',
    duration: Math.floor(video.media?.duration || video.duration || 0),
    thumbnail: note.cover?.urlDefault || note.cover?.urlKey || '',
    uploader: note.user?.nickname || note.noteCard?.user?.nickname || '',
    description: note.desc || '',
    webpage_url: `https://www.xiaohongshu.com/explore/${noteId}`,
    video_url: videoUrl
  }
}

// 主解析函数：HTTP 直取 → Playwright 兜底，支持 Cookie 登录降级
async function resolveXiaohongshuWithPlaywright(noteUrl, options = {}) {
  // ========== 第一层：HTTP 直取 HTML，解析 og:video / __INITIAL_STATE__ ==========
  console.log(`🌐 HTTP 解析小红书: ${noteUrl}`)
  try {
    const html = await httpGet(noteUrl)
    // 1. og:video 最快
    const ogVideo = extractMetaTag(html, 'og:video')
    if (ogVideo) {
      const title = extractMetaTag(html, 'og:title') || ''
      const thumbnail = extractMetaTag(html, 'og:image') || ''
      const durationMatch = html.match(/<meta\s+property=["']og:videotime["']\s+content=["']([^"']+)["']/i)
      const duration = durationMatch ? parseTimeToSeconds(durationMatch[1]) : 0
      console.log(`✅ HTTP (og:video) 解析成功: ${title.substring(0, 50)}`)
      return {
        title: title.replace(' - 小红书', ''),
        duration,
        thumbnail,
        uploader: '',
        description: '',
        webpage_url: noteUrl,
        video_url: ogVideo
      }
    }
    // 2. __INITIAL_STATE__ 提取
    const state = extractInitialState(html)
    if (state) {
      const result = extractVideoFromState(state)
      if (result) {
        console.log(`✅ HTTP (__INITIAL_STATE__) 解析成功: ${result.title.substring(0, 50)}`)
        return result
      }
    }
    // 3. 登录检测
    if (html.includes('/login') || html.includes('login.redirect')) {
      throw Object.assign(new Error('此笔记需要登录或链接已失效（跳转到登录页）'), { code: 'LOGIN_REQUIRED' })
    }
  } catch (e) {
    if (e.code === 'LOGIN_REQUIRED') throw e
    console.warn(`⚠️ HTTP 解析失败: ${e.message}，回退 Playwright`)
  }

  // ========== 第二层：Playwright 无头浏览器兜底（支持重试 + Cookie）==========
  console.log(`🎭 Playwright 回退解析: ${noteUrl}`)
  const maxAttempts = options.retryOnFailure !== false ? 2 : 1
  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) console.log(`🔄 PW 重试第 ${attempt} 次`)
    let context
    try {
      const browser = await getBrowser()
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai'
      })
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] })
      })
      const cookies = options.cookies || []
      if (Array.isArray(cookies) && cookies.length > 0) {
        await context.addCookies(cookies)
      }

      const page = await context.newPage()
      let noteData = null

      page.on('response', async (response) => {
        const url = response.url()
        try {
          if (url.includes('/api/sns/web/v1/feed') || url.includes('/api/sns/web/v2/note')) {
            if (response.status() === 200) {
              const text = await response.text()
              if (text && text.length > 50) {
                const json = JSON.parse(text)
                if (json?.data?.items?.[0] || json?.data?.note) {
                  noteData = json.data
                }
              }
            }
          }
        } catch {}
      })

      let targetUrl = noteUrl
      if (noteUrl.includes('xhslink.com')) {
        await page.goto(noteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
        await page.waitForTimeout(3000)
        targetUrl = page.url()
      }

      if (targetUrl.includes('xiaohongshu.com') || targetUrl.includes('xhslink.com')) {
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
        await page.waitForTimeout(5000)
        await page.evaluate(() => window.scrollTo(0, 500)).catch(() => {})
        await page.waitForTimeout(2000)
      }

      const finalUrl = page.url()
      if (finalUrl.includes('/login') || finalUrl.includes('login.redirect')) {
        throw Object.assign(new Error('此笔记需要登录或链接已失效（跳转到登录页）'), { code: 'LOGIN_REQUIRED' })
      }

      const result = await page.evaluate(() => {
        try {
          const state = window.__INITIAL_STATE__
          if (state?.note?.noteDetailMap) {
            const noteId = Object.keys(state.note.noteDetailMap)[0]
            if (noteId) {
              const note = state.note.noteDetailMap[noteId].note
              if (note?.video?.media?.stream?.h264?.[0]?.master_url) {
                return { title: note.title || note.displayTitle || '', videoUrl: note.video.media.stream.h264[0].master_url, thumbnail: note.cover?.urlDefault || note.cover?.urlKey || '', duration: note.video.media.duration || 0, uploader: note.user?.nickname || note.noteCard?.user?.nickname || '' }
              }
              if (note?.video?.consumer?.originVideoKey) {
                return { title: note.title || note.displayTitle || '', videoUrl: `https://sns-video-al.xhscdn.com/${note.video.consumer.originVideoKey}`, thumbnail: note.cover?.urlDefault || note.cover?.urlKey || '', duration: note.video.media?.duration || 0, uploader: note.user?.nickname || note.noteCard?.user?.nickname || '' }
              }
            }
          }
        } catch (e) {}
        const ogVideo = document.querySelector('meta[property="og:video"]')
        if (ogVideo?.content) {
          return { title: document.querySelector('meta[property="og:title"]')?.content || '', videoUrl: ogVideo.content, thumbnail: document.querySelector('meta[property="og:image"]')?.content || '', duration: 0, uploader: '' }
        }
        const video = document.querySelector('video')
        if (video?.src) {
          return { title: document.title || '', videoUrl: video.src, thumbnail: video.poster || '', duration: video.duration || 0, uploader: '' }
        }
        return null
      })

      if (result?.videoUrl) {
        console.log(`✅ Playwright 解析成功: ${(result.title||'').substring(0, 50)}`)
        return {
          title: result.title || '小红书笔记',
          duration: Math.floor(result.duration) || 0,
          thumbnail: result.thumbnail || '',
          uploader: result.uploader || '',
          description: '',
          webpage_url: finalUrl,
          video_url: result.videoUrl
        }
      }

      if (noteData) {
        const item = noteData.items?.[0] || noteData.note
        if (item?.note_card?.video || item?.video) {
          const video = item.note_card?.video || item.video
          const streamUrl = video.media?.stream?.h264?.[0]?.master_url || video.consumer?.originVideoKey
          if (streamUrl) {
            const finalVideoUrl = streamUrl.startsWith('http') ? streamUrl : `https://sns-video-al.xhscdn.com/${streamUrl}`
            console.log(`✅ API 数据解析成功`)
            return {
              title: item.note_card?.title || item.title || '小红书笔记',
              duration: Math.floor(video.media?.duration || video.duration || 0),
              thumbnail: item.note_card?.cover?.urlDefault || item.cover?.urlDefault || '',
              uploader: item.note_card?.user?.nickname || item.user?.nickname || '',
              description: item.note_card?.desc || item.desc || '',
              webpage_url: finalUrl,
              video_url: finalVideoUrl
            }
          }
        }
      }

      throw new Error('无法从页面提取视频信息')
    } catch (e) {
      lastError = e
      if (e.code === 'LOGIN_REQUIRED' || attempt >= maxAttempts) throw e
      continue
    } finally {
      if (context) await context.close().catch(() => {})
    }
  }
  throw lastError || new Error('解析失败')
}

// 将时间字符串 "MM:SS" 或 "HH:MM:SS" 转为秒数
function parseTimeToSeconds(str) {
  const parts = str.split(':').map(Number)
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

module.exports = { resolveXiaohongshuWithPlaywright, closeBrowser }

if (require.main === module) {
  const url = process.argv[2]
  if (!url) { console.error('Usage: node xiaohongshu_playwright.js <url>'); process.exit(1) }
  resolveXiaohongshuWithPlaywright(url).then(result => {
    console.log('===RESULT===')
    console.log(JSON.stringify(result, null, 2))
  }).catch(e => {
    console.error('FATAL:', e.message)
    process.exit(1)
  })
}