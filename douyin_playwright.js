const { chromium } = require('playwright');

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

async function closeDouyinBrowser() {
  if (_browser) {
    try { await _browser.close() } catch {}
    _browser = null
  }
}

async function resolveDouyinWithPlaywright(videoUrl) {
  console.log(`🎭 Playwright 解析抖音: ${videoUrl}`)
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
    const page = await context.newPage()

    let videoApiData = null
    let apiUrlsFound = []

    page.on('response', async (response) => {
      const url = response.url()
      try {
        if (url.includes('aweme/v1/web/aweme/detail') || url.includes('/aweme/detail/')) {
          const status = response.status()
          apiUrlsFound.push(`${url.substring(0, 100)} [${status}]`)
          if (status === 200) {
            const text = await response.text()
            console.log(`📡 API 响应 (${text.length} bytes): ${url.substring(0, 80)}`)
            if (text && text.length > 10) {
              try {
                videoApiData = JSON.parse(text)
                console.log(`✅ 拦截到有效 API 数据`)
              } catch(e) {
                console.log(`⚠️ API JSON 解析失败: ${e.message}`)
              }
            }
          } else {
            console.log(`⚠️ API 返回非 200: ${status}`)
          }
        }
        if (url.includes('douyin.com/aweme') && url.includes('detail')) {
          apiUrlsFound.push(`${url.substring(0, 100)} [${response.status()}]`)
        }
      } catch {}
    })

    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(2000)

    let targetUrl = videoUrl
    if (videoUrl.includes('v.douyin.com') || !videoUrl.includes('douyin.com/video/')) {
      await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(5000)
      targetUrl = page.url()
      console.log(`🔗 短链接解析结果: ${targetUrl}`)
    }

    if (targetUrl.includes('douyin.com/video/') || targetUrl.includes('douyin.com/note/')) {
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
      await page.waitForTimeout(5000)
    }

    const finalUrl = page.url()
    console.log(`📍 最终 URL: ${finalUrl}`)
    if (apiUrlsFound.length > 0) console.log(`🌐 发现的 API: ${JSON.stringify(apiUrlsFound)}`)

    const cookies = await context.cookies()
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

    // 生成 Netscape 格式 cookie 文件
    const netscapeCookies = cookies.map(c => {
      const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain
      const includeSub = 'TRUE'
      const path = c.path || '/'
      const secure = c.secure ? 'TRUE' : 'FALSE'
      const expires = Math.floor((c.expires || Date.now()/1000 + 86400))
      return `${domain}\t${includeSub}\t${path}\t${secure}\t${expires}\t${c.name}\t${c.value}`
    }).join('\n')

    if (videoApiData) {
      const item = videoApiData.aweme_detail || (videoApiData.item_list ? videoApiData.item_list[0] : null)
      if (item) {
        const playUrl = item.video?.play_addr?.url_list?.[0] || item.video?.play_api?.url_list?.[0] || ''
        const thumbnail = item.video?.cover?.url_list?.[0] || ''
        const duration = item.video?.duration || 0
        console.log(`✅ Playwright 解析成功: ${(item.desc||'').substring(0, 50)}`)
        return {
          title: item.desc || '抖音视频',
          duration: Math.floor(duration / 1000) || 0,
          thumbnail: thumbnail,
          uploader: item.author?.nickname || '未知作者',
          description: item.desc || '',
          webpage_url: finalUrl,
          video_url: noWatermarkUrl(playUrl),
          cookies: netscapeCookies,
          cookieStr: cookieStr
        }
      }
    }

    const title = await page.title()
    const videoId = finalUrl.match(/video\/(\d+)/)?.[1] || ''

    return {
      title: title || '抖音视频',
      duration: 0,
      thumbnail: '',
      uploader: '',
      description: '',
      webpage_url: finalUrl,
      video_url: '',
      videoId: videoId,
      cookies: netscapeCookies,
      cookieStr: cookieStr
    }

  } catch (e) {
    console.warn('⚠️ Playwright 解析失败:', e.message)
    throw e
  } finally {
    if (context) await context.close().catch(() => {})
  }
}

function noWatermarkUrl(url) {
  if (!url) return ''
  return url.replace('/playwm/', '/play/').replace('playwm', 'play')
}

module.exports = { resolveDouyinWithPlaywright, closeBrowser: closeDouyinBrowser }

if (require.main === module) {
  const url = process.argv[2]
  if (!url) { console.error('Usage: node douyin_playwright.js <url>'); process.exit(1) }
  resolveDouyinWithPlaywright(url).then(result => {
    console.log('===RESULT===')
    console.log(JSON.stringify(result, null, 2))
  }).catch(e => {
    console.error('FATAL:', e.message)
    process.exit(1)
  })
}
