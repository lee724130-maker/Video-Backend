// 文件系统与路径操作
const fs = require('fs')
const path = require('path')
// 子进程执行（exec用于简单命令，spawn用于流式处理）
const { exec, spawn } = require('child_process')
const util = require('util')

// 将 exec 转为 Promise 版本，便于 async/await 调用
const execPromise = util.promisify(exec)

// 配置：视频下载工具路径、B站 Cookie、临时文件目录
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp'
const BILIBILI_COOKIES_FILE = path.join(__dirname, 'bilibili_cookies.txt')
const tempDir = path.join(__dirname, 'temp')

// ========== AI 模型 API 配置 ==========
const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY
const BAILIAN_BASE_URL = process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const BAILIAN_MODEL_PRO = process.env.BAILIAN_MODEL_PRO || 'tongyi-xiaomi-analysis-pro'
const BAILIAN_MODEL_FLASH = process.env.BAILIAN_MODEL_FLASH || 'tongyi-xiaomi-analysis-flash'
const BAILIAN_MODEL_VL = process.env.BAILIAN_MODEL_VL || 'qwen2.5-vl-72b-instruct'
const BAILIAN_MODEL_VL_LITE = process.env.BAILIAN_MODEL_VL_LITE || 'qwen2.5-vl-7b-instruct'
const BAILIAN_MODEL_OMNI = process.env.BAILIAN_MODEL_OMNI || 'qwen3.5-omni-plus-2026-03-15'
const BAILIAN_MODEL_OMNI_FLASH = process.env.BAILIAN_MODEL_OMNI_FLASH || 'qwen3-omni-flash'
const BAILIAN_MODEL_VL_NEW = process.env.BAILIAN_MODEL_VL_NEW || 'qwen3-vl-30b-a3b-thinking'
const BAILIAN_MODEL_ASR = process.env.BAILIAN_MODEL_ASR || 'fun-asr-flash-2026-06-15'
const BAILIAN_DASHSCOPE_URL = process.env.BAILIAN_DASHSCOPE_URL || 'https://dashscope.aliyuncs.com/api/v1'
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com'
const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY
const DOUBAO_BASE_URL = process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
const DOUBAO_MODEL = process.env.DOUBAO_MODEL || 'doubao-lite-32k'

// 获取北京时间（用于日志时间戳）
const getBeijingTime = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
}

// 清理临时文件
function cleanupTempFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath)
    } catch (e) {}
  }
}

// ========== vision-tool 视觉分析引擎集成 ==========
const VISION_TOOL_PATH = process.env.VISION_TOOL_PATH || path.join(__dirname, 'vision-tool', 'vision_proxy.py')
const VISION_FRAME_ANALYZER_PATH = process.env.VISION_FRAME_ANALYZER_PATH || path.join(__dirname, 'vision-tool', 'analyze_frames.py')

// 场景A: 有本地视频文件 → 直接调用 vision_proxy.py
async function callVisionTool(videoPath, prompt = '') {
  const escapedPath = `"${videoPath}"`
  const escapedPrompt = prompt ? `"${prompt}"` : ''
  const cmd = `python ${VISION_TOOL_PATH} ${escapedPath} ${escapedPrompt}`
  try {
    const { stdout } = await execPromise(cmd, { timeout: 120000 })
    const lines = stdout.trim().split('\n')
    const desc = lines.slice(1).join('\n').trim()
    if (desc) console.log(`✅ vision-tool 描述: ${desc.length} 字`)
    return desc
  } catch (error) {
    console.warn('⚠️ vision-tool 调用失败:', error.message)
    return ''
  }
}

// 场景B: 只有帧无本地文件 → 写帧到临时目录，调 analyze_frames.py
async function callVisionToolWithFrames(frames, prompt = '') {
  if (!frames || frames.length === 0) return ''
  const tempDir = path.join(__dirname, 'temp', `vision_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`)
  fs.mkdirSync(tempDir, { recursive: true })
  try {
    frames.forEach((b64, i) => {
      const data = b64.replace(/^data:image\/\w+;base64,/, '')
      fs.writeFileSync(path.join(tempDir, `frame_${i}.jpg`), data, 'base64')
    })
    const cmd = `python ${VISION_FRAME_ANALYZER_PATH} "${tempDir}" ${prompt ? `"${prompt}"` : ''}`
    const { stdout } = await execPromise(cmd, { timeout: 120000 })
    const lines = stdout.trim().split('\n')
    const desc = lines.slice(1).join('\n').trim()
    if (desc) console.log(`✅ vision-tool 帧分析: ${desc.length} 字`)
    return desc
  } catch (error) {
    console.warn('⚠️ vision-tool 帧分析失败:', error.message)
    return ''
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
// ========== vision-tool 结束 ==========

// 从 YouTube URL 中提取视频 ID（支持多种 URL 格式）
function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^&]+)/,
    /(?:youtu\.be\/)([^?]+)/,
    /(?:youtube\.com\/embed\/)([^?]+)/
  ]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]
  }
  return null
}

// ========== 抖音链接检测函数 ==========
function isDouyinUrl(url) {
  if (!url) return false;
  const urlStr = String(url).toLowerCase();
  return urlStr.includes('douyin.com') || urlStr.includes('v.douyin.com');
}

// ========== 小红书链接检测 ==========
function isXiaohongshuUrl(url) {
  if (!url) return false;
  const urlStr = String(url).toLowerCase();
  return urlStr.includes('xiaohongshu.com') || urlStr.includes('xhslink.com');
}

// 从抖音各种 URL 格式中提取 video_id（短链接、完整链接、分享页）
async function resolveDouyinVideoId(videoUrl) {
  const urlStr = String(videoUrl).toLowerCase()

  // 如果已经是完整链接（含 /video/），直接提取 ID
  const fullMatch = urlStr.match(/douyin\.com\/video\/(\d+)/)
  if (fullMatch) return fullMatch[1]

  // iesdouyin 分享页格式（数字 ID 或短码）
  const iesNumMatch = urlStr.match(/iesdouyin\.com\/share\/video\/(\d+)/)
  if (iesNumMatch) return iesNumMatch[1]
  const iesCodeMatch = urlStr.match(/iesdouyin\.com\/share\/video\/([a-zA-Z0-9]+)/)
  if (iesCodeMatch) return iesCodeMatch[1]

  // 短链接 v.douyin.com/xxx → 通过 HTTP 重定向解析真实 video ID
  // 方法1: 用 redirect follow 获取最终 URL，再从中提取 video ID
  try {
    const response = await fetch(videoUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 8.0.0; SM-G955U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36'
      },
      redirect: 'follow'
    })
    const finalUrl = response.url
    const idMatch = finalUrl.match(/video\/(\d+)/)
    if (idMatch) return idMatch[1]
  } catch {}

  // 方法2: 从分享短链接 HTML 页面中提取 canonical URL 或 video ID（不跟随重定向，手动解析）
  try {
    const resp = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 8.0.0; SM-G955U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36'
      },
      redirect: 'manual'
    })
    const location = resp.headers.get('location') || resp.headers.get('Location') || ''
    const locMatch = location.match(/video\/(\d+)/)
    if (locMatch) return locMatch[1]
    const altMatch = location.match(/(\d{17,})/)
    if (altMatch) return altMatch[1]

    const text = await resp.text()
    const canonMatch = text.match(/canonical[^>]+href="[^"]*\/video\/(\d+)/)
    if (canonMatch) return canonMatch[1]
    const ogMatch = text.match(/og:url[^>]+content="[^"]*\/video\/(\d+)/)
    if (ogMatch) return ogMatch[1]
  } catch {}

  // 方法3: 提取短码作为 video ID，后续由 iesdouyin + Playwright 兜底解析
  const shortCode = urlStr.match(/v\.douyin\.com\/([a-zA-Z0-9]+)/)
  if (shortCode) return shortCode[1]

  throw new Error('无法从抖音链接中提取视频ID')
}

// 从抖音/iesdouyin 页面 HTML 中提取 window._ROUTER_DATA JSON（手动解析花括号匹配）
function extractRouterData(html) {
  const marker = 'window._ROUTER_DATA = '
  const startIdx = html.indexOf(marker)
  if (startIdx === -1) return null

  let jsonStart = startIdx + marker.length
  let bracketCount = 0
  let inString = false
  let escape = false
  let jsonEnd = jsonStart

  for (let i = jsonStart; i < html.length; i++) {
    const char = html[i]
    if (escape) { escape = false; continue }
    if (char === '\\') { escape = true; continue }
    if (char === '"' && !escape) { inString = !inString; continue }
    if (!inString) {
      if (char === '{') bracketCount++
      else if (char === '}') {
        bracketCount--
        if (bracketCount === 0) { jsonEnd = i + 1; break }
      }
    }
  }

  const jsonStr = html.substring(jsonStart, jsonEnd)
  return JSON.parse(jsonStr)
}

// ========== 抖音视频解析主函数（三层降级：iesdouyin → Douyin API → Playwright）==========
async function getDouyinVideoInfo(videoUrl) {
  console.log(`📱 解析抖音视频: ${videoUrl}`)

  // 第一步：从 URL 中提取 video ID
  const videoId = await resolveDouyinVideoId(videoUrl)
  let html = ''
  // 第二层：尝试通过 iesdouyin 分享页面获取视频信息
  try {
    const shareUrl = `https://www.iesdouyin.com/share/video/${videoId}/`
    const response = await fetch(shareUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 8.0.0; SM-G955U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
        'Referer': 'https://www.douyin.com/'
      }
    })
    if (response.ok) {
      html = await response.text()
    }
  } catch (iesErr) {
    console.warn(`⚠️ iesdouyin 请求失败: ${iesErr.message}`)
  }

  // 从 HTML 中解析 _ROUTER_DATA JSON，提取视频元信息
  const data = extractRouterData(html)

  if (data) {
    const loaderData = data.loaderData
    // 查找非 layout 的 video 数据键名（动态键名）
    const videoKey = Object.keys(loaderData).find(k => k !== 'video_layout' && loaderData[k]?.videoInfoRes)
    const item = videoKey ? loaderData[videoKey].videoInfoRes.item_list?.[0] : undefined
    if (item) {
      // 提取无水印播放地址（将 /playwm/ 替换为 /play/）
      const playUrl = item.video?.play_addr?.url_list?.[0] || ''
      const noWatermarkUrl = playUrl.replace('/playwm/', '/play/').replace('playwm', 'play')
      const thumbnail = item.video?.cover?.url_list?.[0] || item.video?.dynamic_cover?.url_list?.[0] || ''
      const duration = item.video?.duration || 0
      console.log(`✅ 抖音解析成功: ${item.desc?.substring(0, 50) || '无标题'}`)
      return {
        title: item.desc || '抖音视频',
        duration: Math.floor(duration / 1000) || 0,
        thumbnail: thumbnail,
        uploader: item.author?.nickname || '未知作者',
        description: item.desc || '',
        webpage_url: `https://www.douyin.com/video/${videoId}`,
        video_url: noWatermarkUrl
      }
    }
  }

  // Fallback: 直接调用 Douyin Web API 获取视频详情
  console.log('🔄 iesdouyin 解析失败，尝试 Douyin API 直连')
  try {
    const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${videoId}`
    const apiRes = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Referer': 'https://www.douyin.com/'
      }
    })
    if (apiRes.ok) {
      const apiData = await apiRes.json()
      const item = apiData?.aweme_detail || apiData?.item_list?.[0]
      if (item) {
        const playUrl = item.video?.play_addr?.url_list?.[0] || item.video?.play_api?.url_list?.[0] || ''
        const thumbnail = item.video?.cover?.url_list?.[0] || item.video?.dynamic_cover?.url_list?.[0] || ''
        const duration = item.video?.duration || 0
        console.log(`✅ 抖音 API 解析成功: ${item.desc?.substring(0, 50) || '无标题'}`)
        return {
          title: item.desc || '抖音视频',
          duration: Math.floor(duration / 1000) || 0,
          thumbnail: thumbnail,
          uploader: item.author?.nickname || '未知作者',
          description: item.desc || '',
          webpage_url: `https://www.douyin.com/video/${videoId}`,
          video_url: playUrl
        }
      }
    }
  } catch (apiErr) {
    console.warn(`⚠️ Douyin API 请求失败: ${apiErr.message}`)
  }

  // 第三层降级：使用 Playwright 无头浏览器解析抖音页面（对抗强反爬）
  console.log('🔄 尝试 Playwright 解析抖音')
  try {
    const { resolveDouyinWithPlaywright } = require('./douyin_playwright')
    const pwResult = await resolveDouyinWithPlaywright(videoUrl)
    if (pwResult && (pwResult.video_url || pwResult.videoId)) {
      console.log(`✅ Playwright 解析成功: ${(pwResult.title||'').substring(0, 50)}`)
      return {
        title: pwResult.title || '抖音视频',
        duration: pwResult.duration || 0,
        thumbnail: pwResult.thumbnail || '',
        uploader: pwResult.uploader || '',
        description: pwResult.description || '',
        webpage_url: pwResult.webpage_url || `https://www.douyin.com/video/${pwResult.videoId}`,
        video_url: pwResult.video_url || ''
      }
    }
  } catch (pwErr) {
    console.warn(`⚠️ Playwright 抖音解析失败: ${pwErr.message}`)
  }

  throw new Error('无法从抖音页面提取数据，页面结构可能已变更')
}

// 构建 yt-dlp 命令，根据平台添加 UA、代理、Cookie 等额外参数
function buildYtdlpCommand(baseCmd, videoUrl) {
  let cmd = baseCmd
  cmd += ` --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"`
  
  // YouTube 特殊配置：代理或 Android 客户端模式绕过限制
  if (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be')) {
    const proxy = process.env.YOUTUBE_PROXY || ''
    if (proxy) {
      cmd += ` --proxy "${proxy}"`
      console.log('🌐 使用代理访问 YouTube')
    } else {
      cmd += ` --extractor-args "youtube:player_client=android"`
      console.log('📱 使用 Android 客户端模式解析 YouTube')
    }
  }

  // B站专用请求头（Referer/Origin 防盗链 + Cookie 登录态）
  if (videoUrl.includes('bilibili.com')) {
    cmd += ` --add-header "Referer: https://www.bilibili.com/"`
    cmd += ` --add-header "Origin: https://www.bilibili.com"`
    if (fs.existsSync(BILIBILI_COOKIES_FILE)) {
      cmd += ` --cookies "${BILIBILI_COOKIES_FILE}"`
      console.log('🍪 使用 B站 Cookies')
    }
  }
  
  
  cmd += ` "${videoUrl}"`
  return cmd
}

// ========== 小红书视频解析器（Playwright 无头浏览器 + Cookie 降级）==========
const XHS_COOKIE_FILE = path.join(__dirname, 'xiaohongshu_cookies.json')

async function getXiaohongshuVideoInfo(videoUrl) {
  // 动态引入 Playwright 模块（避免启动时加载）
  const { resolveXiaohongshuWithPlaywright } = require('./xiaohongshu_playwright')

  // 首次尝试：匿名解析（不需要登录）
  try {
    const result = await resolveXiaohongshuWithPlaywright(videoUrl)
    if (result && result.video_url) {
      console.log(`✅ 小红书解析成功: ${result.title?.substring(0, 50)}`)
      return result
    }
    throw new Error('未找到视频链接')
  } catch (e) {
    // 只有登录跳转错误且存在 Cookie 文件时才重试
    if (e.code === 'LOGIN_REQUIRED' && fs.existsSync(XHS_COOKIE_FILE)) {
      console.log('🍪 匿名访问需要登录，尝试使用 Cookie 重试...')
      try {
        const cookies = JSON.parse(fs.readFileSync(XHS_COOKIE_FILE, 'utf-8'))
        const result = await resolveXiaohongshuWithPlaywright(videoUrl, { cookies })
        if (result && result.video_url) {
          console.log(`✅ 小红书 Cookie 解析成功: ${result.title?.substring(0, 50)}`)
          return result
        }
      } catch (e2) {
        console.error('小红书 Cookie 解析失败:', e2.message)
      }
    }
    console.error('小红书解析失败:', e.message)
    throw new Error('无法解析小红书视频: ' + e.message)
  }
}

// 获取视频信息（主入口：抖音/小红书走专用解析器，其余平台走 yt-dlp）
async function getVideoInfo(videoUrl) {
  console.log(`📥 获取视频信息: ${videoUrl}`)
  
  // 抖音使用专用解析器（三层降级：iesdouyin → API → Playwright）
  if (isDouyinUrl(videoUrl)) {
    return await getDouyinVideoInfo(videoUrl)
  }
  
  // 小红书使用 Playwright 解析器（含 Cookie 登录降级）
  if (isXiaohongshuUrl(videoUrl)) {
    return await getXiaohongshuVideoInfo(videoUrl)
  }
  
  // 其他平台（YouTube、B站等）：使用 yt-dlp 工具解析
  console.log('🔍 使用 yt-dlp 解析')
  const baseCmd = `"${YTDLP_PATH}" --dump-json --skip-download`
  const cmd = buildYtdlpCommand(baseCmd, videoUrl)
  
  try {
    const { stdout } = await execPromise(cmd, { timeout: 60000 })
    const info = JSON.parse(stdout)
    let thumbnail = info.thumbnail || ''
    // YouTube 特殊处理：使用官方缩略图 CDN（更稳定）
    if (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be')) {
      const videoId = extractYouTubeId(videoUrl)
      if (videoId) thumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
    }
    let directUrl = info.url
    // 如果 yt-dlp 返回多格式列表，提取视频流 URL
    if (!directUrl && info.requested_formats) {
      const videoFmt = info.requested_formats.find(f => f.video_ext && f.video_ext !== 'none')
      if (videoFmt) directUrl = videoFmt.url
    }
    return {
      title: info.title,
      duration: info.duration,
      thumbnail: thumbnail,
      uploader: info.uploader,
      description: info.description || '',
      webpage_url: info.webpage_url,
      video_url: directUrl || ''
    }
  } catch (error) {
    console.error('获取视频信息失败:', error.message)
    throw new Error('无法获取视频信息: ' + error.message)
  }
}

// 使用 yt-dlp 提取视频字幕（自动/简体/繁体/英文，VTT 格式）
async function extractSubtitles(videoUrl) {
  console.log(`📝 提取字幕: ${videoUrl}`)
  
  const tempId = Date.now() + '_' + Math.random().toString(36).substring(2, 8)
  const subtitlePath = path.join(tempDir, `${tempId}`)
  
  try {
    const commands = [
      { lang: 'zh-Hans', cmd: `"${YTDLP_PATH}" --write-subs --sub-lang "zh-Hans" --skip-download --sub-format vtt -o "${subtitlePath}"` },
      { lang: 'zh-Hant', cmd: `"${YTDLP_PATH}" --write-subs --sub-lang "zh-Hant" --skip-download --sub-format vtt -o "${subtitlePath}"` },
      { lang: 'en', cmd: `"${YTDLP_PATH}" --write-subs --sub-lang "en" --skip-download --sub-format vtt -o "${subtitlePath}"` },
      { lang: 'auto', cmd: `"${YTDLP_PATH}" --write-auto-subs --sub-lang "zh-Hans" --skip-download --sub-format vtt -o "${subtitlePath}"` }
    ]
    
    let subtitleText = ''
    
    for (const { lang, cmd } of commands) {
      try {
        const fullCmd = buildYtdlpCommand(cmd, videoUrl)
        await execPromise(fullCmd, { timeout: 60000, shell: true })
        
        const possiblePaths = [
          `${subtitlePath}.${lang}.vtt`,
          `${subtitlePath}.vtt`,
          `${subtitlePath}.zh-Hans.vtt`,
          `${subtitlePath}.en.vtt`
        ]
        
        for (const vttPath of possiblePaths) {
          if (fs.existsSync(vttPath)) {
            subtitleText = fs.readFileSync(vttPath, 'utf-8')
            console.log(`✅ 成功提取字幕: ${vttPath}`)
            break
          }
        }
        
        if (subtitleText) break
      } catch (cmdError) {
        continue
      }
    }
    
    const files = fs.readdirSync(tempDir)
    for (const file of files) {
      if (file.includes(tempId)) {
        try {
          fs.unlinkSync(path.join(tempDir, file))
        } catch (e) {}
      }
    }
    
    if (subtitleText) {
      const cleanText = subtitleText
        .replace(/WEBVTT[\s\S]*?\n\n/g, '')
        .replace(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}.*\n/g, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\n+/g, '\n')
        .trim()
      
      return cleanText
    }
    
    console.log('⚠️ 未找到字幕')
    return null
    
  } catch (error) {
    console.error('提取字幕失败:', error)
    try {
      const files = fs.readdirSync(tempDir)
      for (const file of files) {
        if (file.includes(tempId)) {
          fs.unlinkSync(path.join(tempDir, file))
        }
      }
    } catch (e) {}
    return null
  }
}

// 通过 curl 下载视频文件到本地（作为 yt-dlp 的降级方案）
async function downloadVideo(videoUrl, outputPath) {
  console.log(`📥 下载视频: ${videoUrl?.substring(0, 50)}...`)
  const cmd = `curl -L -s -o "${outputPath}" "${videoUrl}" --connect-timeout 30 --max-time 300`
  await execPromise(cmd, { timeout: 310000 })
  console.log(`✅ 视频下载完成: ${outputPath}`)
}

// 从视频中提取音频（双保险：yt-dlp 直接提取 → 下载视频后用 ffmpeg 提取）
// 返回 { audioPath, videoPath }，videoPath 在降级时不为空
async function extractAudio(videoUrl, fallbackUrl) {
  console.log(`🎵 提取音频: ${videoUrl}`)
  
  const tempId = Date.now() + '_' + Math.random().toString(36).substring(2, 8)
  const audioPath = path.join(tempDir, `${tempId}.mp3`)
  let videoPath = ''
  
  const baseCmd = `"${YTDLP_PATH}" -x --audio-format mp3 --audio-quality 0 --no-playlist -o "${audioPath}"`
  const cmd = buildYtdlpCommand(baseCmd, videoUrl)
  
  try {
    await execPromise(cmd, { timeout: 300000 })
    console.log(`✅ 音频下载完成: ${audioPath}`)
    return { audioPath, videoPath }
  } catch (error) {
    console.error('yt-dlp 提取音频失败:', error.message)
    if (fallbackUrl) {
      videoPath = path.join(tempDir, `${tempId}.mp4`)
      try {
        await downloadVideo(fallbackUrl, videoPath)
        const ffmpegCmd = `ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -ab 128k -ar 44100 -f mp3 "${audioPath}" -loglevel error`
        await execPromise(ffmpegCmd, { timeout: 300000 })
        console.log(`✅ 本地音频提取成功: ${audioPath}`)
        return { audioPath, videoPath }
      } catch (dlError) {
        console.error('视频下载或音频提取失败:', dlError.message)
        if (fs.existsSync(videoPath)) {
          try { fs.unlinkSync(videoPath) } catch {}
        }
        return { audioPath: null, videoPath: '' }
      }
    }
    return { audioPath: null, videoPath: '' }
  }
}

// 本地 Whisper 语音转文字（现已弃用，被云端 ASR 替代，保留作降级）
async function transcribeWithWhisper(audioPath, language = 'zh') {
  console.log(`🎙️ 开始语音转文字，语言: ${language}`)
  
  return new Promise((resolve, reject) => {
    const pythonScript = `
import sys
import json
try:
    import whisper
except ImportError:
    print(json.dumps({"error": "Whisper not installed"}))
    sys.exit(1)

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No audio file path provided"}))
        sys.exit(1)
    
    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else None
    
    try:
        # 使用 tiny 模型，更快且内存占用更少
        model = whisper.load_model("tiny")
        result = model.transcribe(audio_path, language=language if language != "auto" else None)
        print(json.dumps({"text": result["text"], "language": result["language"]}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
`
    const pythonProcess = spawn('python3', ['-c', pythonScript, audioPath, language])
    
    let output = ''
    let errorOutput = ''
    
    // 设置超时（5分钟）
    const timeout = setTimeout(() => {
      console.error('Whisper 转写超时，正在终止进程...')
      pythonProcess.kill('SIGTERM')
      reject(new Error('Whisper 转写超时（5分钟）'))
    }, 300000)
    
    pythonProcess.stdout.on('data', (data) => {
      output += data.toString()
    })
    
    pythonProcess.stderr.on('data', (data) => {
      errorOutput += data.toString()
    })
    
    pythonProcess.on('close', (code) => {
      clearTimeout(timeout)
      
      if (code !== 0) {
        console.error('Whisper 转写失败，错误码:', code)
        console.error('错误输出:', errorOutput)
        reject(new Error('语音转文字失败: ' + (errorOutput || '未知错误')))
        return
      }
      
      try {
        const result = JSON.parse(output)
        if (result.error) {
          reject(new Error(result.error))
        } else {
          console.log(`✅ 语音转文字完成，检测到语言: ${result.language}`)
          resolve(result.text)
        }
      } catch (e) {
        console.error('解析 Whisper 输出失败:', e)
        console.error('原始输出:', output)
        reject(new Error('解析转写结果失败'))
      }
    })
  })
}

// 基于标题和描述的关键词匹配，检测视频类型（interview/music/sports/tutorial）
function detectVideoType(title, description, duration) {
  const text = (title + ' ' + (description || '')).toLowerCase()
  
  const interviewKeywords = ['访谈', '对话', '采访', '讨论', '座谈', '圆桌', '嘉宾', '主持', 'talk', 'interview', 'podcast', 'panel', 'discussion']
  const musicKeywords = ['唱', '歌', '音乐', '歌曲', '演唱', 'live', '现场', '录音棚', '专辑', '单曲', 'MV', 'remix', 'cover']
  const sportsKeywords = ['比赛', '进球', '集锦', '世界杯', '欧冠', '英超', '西甲', 'nba', '奥运', '冠军', '决赛', 'vs', '比分', '点球', '红牌', '射门', '足球', '篮球', '体育', '全场', '集锦', '锦集', '高光']
  
  let interviewScore = 0
  let musicScore = 0
  let sportsScore = 0
  
  interviewKeywords.forEach(kw => { if (text.includes(kw)) interviewScore++ })
  musicKeywords.forEach(kw => { if (text.includes(kw)) musicScore++ })
  sportsKeywords.forEach(kw => { if (text.includes(kw)) sportsScore++ })
  
  // 体育赛事优先识别，保持常规转录路径（非音乐模式，不跳过逐字稿）
  if (sportsScore > 0) return 'sports'

  if (duration && duration < 600 && musicScore > 0) musicScore += 0.5

  if (interviewScore > 0 && interviewScore >= musicScore) return 'interview'
  if (musicScore >= 1) return 'music'
  return 'tutorial'
}

// 智能转写路由入口：提取音频后交由云端 API 转写（已跳过本地 Whisper）
async function smartTranscribe(videoUrl, videoTitle, videoDescription, videoDuration, enableSpeakerDiarization, fallbackUrl) {
  const videoType = detectVideoType(videoTitle, videoDescription, videoDuration)
  console.log(`📊 视频类型检测: ${videoType}`)

  // 只提取音频路径供后续转写，不做本地 Whisper
  const { audioPath, videoPath } = await extractAudio(videoUrl, fallbackUrl)
  if (!audioPath) {
    console.error('❌ 音频提取失败')
    return { text: "", method: 'none', videoType, videoPath: '' }
  }
  console.log(`🎵 音频已提取: ${audioPath}`)
  return { text: "", audioPath, method: 'none', videoType, videoPath }
}

// 从视频中间隔抽取关键帧画面（支持 URL 和本地文件），返回 base64 图片数组
async function extractFrames(videoUrl, duration, maxFrames = 8, localPath = '') {
  if (!videoUrl && !localPath) return []
  const tempId = Date.now() + '_' + Math.random().toString(36).substring(2, 8)
  const frameDir = path.join(tempDir, `frames_${tempId}`)
  fs.mkdirSync(frameDir, { recursive: true })

  const interval = Math.max(Math.floor(duration / maxFrames), 10)
  const outputPattern = path.join(frameDir, 'frame_%03d.jpg')

  const inputSource = localPath || videoUrl
  console.log(`🎬 抽帧: ${localPath ? '本地文件' : 'URL'}, interval=${interval}s, ${maxFrames}帧`)

  // -q:v 1 最高质量，-vsync vfr 避免重复帧
  // B站 CDN 需要添加 Referer 防盗链头，否则返回 403
  const refererHeader = (!localPath && videoUrl && videoUrl.includes('bilibili.com'))
    ? '-headers "Referer: https://www.bilibili.com/\r\n" '
    : ''
  const cmd = `ffmpeg -y ${refererHeader}-i "${inputSource}" -vf "fps=1/${interval}" -vframes ${maxFrames} -q:v 1 -vsync vfr "${outputPattern}" -loglevel error`

  try {
    await execPromise(cmd, { timeout: 120000 })
    const files = fs.readdirSync(frameDir).filter(f => f.endsWith('.jpg')).sort()
    console.log(`🎬 抽帧成功: ${files.length} 帧`)
    return files.map(f => {
      const data = fs.readFileSync(path.join(frameDir, f))
      return `data:image/jpeg;base64,${data.toString('base64')}`
    })
  } catch (e) {
    console.warn('⚠️ 抽帧失败:', e.message)
    return []
  } finally {
    if (fs.existsSync(frameDir)) {
      fs.readdirSync(frameDir).forEach(f => {
        try { fs.unlinkSync(path.join(frameDir, f)) } catch {}
      })
      try { fs.rmdirSync(frameDir) } catch {}
    }
  }
}

// 统一本地视频处理管道：提取音频 → Whisper 转写 → 抽帧（用于已下载文件或本地上传）
async function processLocalVideo(localPath, duration) {
  console.log(`📦 处理本地视频: ${localPath}`)

  // 1. 提取音频
  const tempId = Date.now() + '_' + Math.random().toString(36).substring(2, 8)
  const audioPath = path.join(tempDir, `${tempId}.mp3`)
  const ffmpegCmd = `ffmpeg -y -i "${localPath}" -vn -acodec libmp3lame -ab 128k -ar 44100 -f mp3 "${audioPath}" -loglevel error`
  await execPromise(ffmpegCmd, { timeout: 300000 })
  console.log(`✅ 本地音频提取成功: ${audioPath}`)

  // 2. Whisper 转写
  const text = await transcribeWithWhisper(audioPath, 'zh')
  cleanupTempFile(audioPath)

  // 3. 抽帧
  const frames = await extractFrames('', duration, 8, localPath)

  return { text, frames }
}

// 基于场景切换检测的智能抽帧：提取画面切换点的关键帧（比固定间隔更精准）
async function extractSceneFrames(videoPath, maxFrames = 5) {
  const tempId = Date.now() + '_' + Math.random().toString(36).substring(2, 8)
  const frameDir = path.join(tempDir, `scenes_${tempId}`)
  fs.mkdirSync(frameDir, { recursive: true })
  const outputPattern = path.join(frameDir, 'scene_%03d.jpg')

  const cmd = `ffmpeg -i "${videoPath}" -vf "select=gt(scene\\,0.3),showinfo" -vsync vfr -q:v 2 "${outputPattern}" -loglevel error`
  try {
    await execPromise(cmd, { timeout: 120000 })
    const allFiles = fs.readdirSync(frameDir).filter(f => f.endsWith('.jpg')).sort()
    let selected = allFiles
    if (allFiles.length > maxFrames) {
      const step = allFiles.length / maxFrames
      selected = allFiles.filter((_, i) => Math.floor(i % step) === 0).slice(0, maxFrames)
    }
    console.log(`🎬 场景检测抽帧: ${selected.length} 帧 (共 ${allFiles.length} 个场景)`)
    const frames = selected.map(f => {
      const data = fs.readFileSync(path.join(frameDir, f))
      return `data:image/jpeg;base64,${data.toString('base64')}`
    })
    fs.readdirSync(frameDir).forEach(f => { try { fs.unlinkSync(path.join(frameDir, f)) } catch {} })
    try { fs.rmdirSync(frameDir) } catch {}
    return frames
  } catch (e) {
    console.warn('⚠️ 场景检测抽帧失败:', e.message)
    if (fs.existsSync(frameDir)) {
      fs.readdirSync(frameDir).forEach(f => { try { fs.unlinkSync(path.join(frameDir, f)) } catch {} })
      try { fs.rmdirSync(frameDir) } catch {}
    }
    return []
  }
}

// 将音频压缩为 WAV 16kHz 16bit 单声道（云端 ASR 服务要求的输入格式）
async function compressAudio(audioPath) {
  const tempId = Date.now() + '_' + Math.random().toString(36).substring(2, 8)
  const compressedPath = path.join(tempDir, `${tempId}_compressed.wav`)
  const cmd = `ffmpeg -y -i "${audioPath}" -ac 1 -ar 16000 -sample_fmt s16 -f wav "${compressedPath}" -loglevel error`
  try {
    await execPromise(cmd, { timeout: 60000 })
    console.log(`🔊 音频压缩完成: ${compressedPath}`)
    return compressedPath
  } catch (e) {
    console.error('❌ 音频压缩失败:', e.message)
    return null
  }
}

// 使用百炼 fun-asr-flash 云端模型进行语音转文字（代替本地 Whisper）
// 支持超长音频：分段并行转写后合并结果
async function transcribeAudioWithOmni(audioPath, videoTitle = '') {
  // 第一步：压缩音频为 ASR 服务要求的 WAV 格式
  const compressedPath = await compressAudio(audioPath)
  if (!compressedPath) return ''

  // 第二步：获取音频时长（秒），用于分段
  let duration = 0
  try {
    const { stdout } = await execPromise(`ffprobe -i "${compressedPath}" -show_entries format=duration -v quiet -of csv="p=0"`, { timeout: 10000 })
    duration = Math.ceil(parseFloat(stdout.trim()))
  } catch {}
  if (duration <= 0) {
    cleanupTempFile(compressedPath)
    return ''
  }

  // 第三步：按3分钟一段分割音频（fun-asr-flash 单次支持最长5分钟）
  const chunkDuration = 180
  const numChunks = Math.ceil(duration / chunkDuration)
  const chunkDir = path.join(tempDir, `chunks_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`)
  fs.mkdirSync(chunkDir, { recursive: true })

  const splitCmd = `ffmpeg -y -i "${compressedPath}" -f segment -segment_time ${chunkDuration} -c copy "${path.join(chunkDir, 'chunk_%03d.wav')}" -loglevel error`
  try {
    await execPromise(splitCmd, { timeout: 60000 })
  } catch (e) {
    console.error('❌ 音频分割失败:', e.message)
    cleanupTempFile(compressedPath)
    if (fs.existsSync(chunkDir)) { try { fs.rmdirSync(chunkDir, { recursive: true }) } catch {} }
    return ''
  }

  // 第四步：构造标题上下文提示（辅助 ASR 识别领域专有名词）
  const contextHint = videoTitle ? `视频标题：${videoTitle}，根据标题提供的领域信息辅助识别专有名词。` : ''

  const files = fs.readdirSync(chunkDir).filter(f => f.endsWith('.wav')).sort()
  console.log(`🔊 ASR 转写: ${files.length} 段, 共 ${duration}s`)

  // 第五步：并行调用 ASR API 转写所有分段
  const results = await Promise.all(files.map(async (file, i) => {
    const filePath = path.join(chunkDir, file)
    const b64 = fs.readFileSync(filePath).toString('base64')
    const content = [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${b64}` } }]
    if (contextHint) {
      content.push({ type: 'text', text: contextHint })
    }
    const body = JSON.stringify({
      model: BAILIAN_MODEL_ASR,
      input: {
        messages: [{ role: 'user', content }]
      },
      parameters: { format: 'wav', sample_rate: 16000 }
    })
    try {
      const resp = await fetch(`${BAILIAN_DASHSCOPE_URL}/services/aigc/multimodal-generation/generation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BAILIAN_API_KEY}`,
          'X-DashScope-SSE': 'disable'
        },
        body
      })
      if (!resp.ok) { console.error(`❌ ASR 段 ${i+1} 失败: ${resp.status}`); return '' }
      const data = await resp.json()
      const text = (data.output && data.output.text) || ''
      console.log(`✅ ASR 段 ${i+1}/${files.length}: ${text.length}字`)
      return text
    } catch (e) {
      console.error(`❌ ASR 段 ${i+1} 异常:`, e.message)
      return ''
    }
  }))

  // 第六步：合并所有分段转写结果，返回完整逐字稿
  const fullText = results.filter(Boolean).join('\n').trim()
  console.log(`📝 完整逐字稿: ${fullText.length} 字`)

  // 清理临时文件
  cleanupTempFile(compressedPath)
  if (fs.existsSync(chunkDir)) { try { fs.rmdirSync(chunkDir, { recursive: true }) } catch {} }

  return fullText
}

// 通用 AI 模型调用函数：支持纯文本 + 图片多模态，返回解析后的 JSON 对象
async function callAIModel(config, systemPrompt, userPrompt, frames = []) {
  const { apiKey, baseUrl, model, maxTokens = 3000, temperature = 0.7 } = config

  if (!apiKey) {
    throw new Error(`${model} 模型不可用`)
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 180000)

    // 构建消息数组：system prompt + 用户内容（文字 + 可选图片帧）
    const messages = [
      { role: 'system', content: systemPrompt }
    ]

    // 多模态分支：有图片帧时构建图文混合消息
    if (frames.length > 0) {
      const content = [{ type: 'text', text: userPrompt }]
      frames.forEach(frame => {
        content.push({ type: 'image_url', image_url: { url: frame } })
      })
      messages.push({ role: 'user', content })
    }
    // 纯文本分支
    else {
      messages.push({ role: 'user', content: userPrompt })
    }

    // 构建 API 请求体
    const requestBody = {
      model: model,
      messages,
      temperature: temperature,
      max_tokens: maxTokens
    }
    // omni 模型支持 JSON 输出模式，即使同时传图片；VL 模型不支持此参数
    if (frames.length === 0 || model.includes('omni')) {
      requestBody.response_format = { type: 'json_object' }
    }
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '无法读取错误响应')
      console.error(`❌ API 请求失败 (${response.status}), 模型: ${model}, URL: ${baseUrl}`)
      console.error(`❌ 响应体: ${errorBody.substring(0, 1000)}`)
      throw new Error(`API 请求失败: ${response.status}`)
    }

    const data = await response.json()
    let content = data.choices[0]?.message?.content

    if (!content && content !== '') {
      content = JSON.stringify(data.choices[0]?.message || data)
    }

    if (Array.isArray(content)) {
      content = content.find(c => c.type === 'text')?.text || JSON.stringify(content)
    }

    content = (content || '').trim()
    if (content.startsWith('```json')) content = content.substring(7)
    else if (content.startsWith('```')) content = content.substring(3)
    // 移除尾部杂散字符（如单独的 ` 或 ```）
    if (content.endsWith('```')) content = content.substring(0, content.length - 3)
    if (content.endsWith('`')) content = content.substring(0, content.length - 1)
    content = content.trim()

    try {
      const parsed = JSON.parse(content)
      // 检测并展平嵌套 JSON：模型有时把整个分析对象打包成字符串塞进 summary 字段
      // 支持 summary 为 JSON 字符串或直接为对象两种情况
      if (parsed && typeof parsed === 'object') {
        let innerSummary = null
        if (typeof parsed.summary === 'string' && parsed.summary.trim().startsWith('{')) {
          try { innerSummary = JSON.parse(parsed.summary.trim()) } catch {}
        } else if (typeof parsed.summary === 'object' && !Array.isArray(parsed.summary)) {
          innerSummary = parsed.summary
        }
        if (innerSummary && typeof innerSummary === 'object' && !Array.isArray(innerSummary)) {
          for (const key of Object.keys(innerSummary)) {
            if (innerSummary[key] !== null && innerSummary[key] !== undefined && !(Array.isArray(innerSummary[key]) && innerSummary[key].length === 0)) {
              parsed[key] = innerSummary[key]
            }
          }
        }
      }
      return parsed
    } catch (parseError) {
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0])
          // 同样展平嵌套
          if (parsed && typeof parsed === 'object') {
            let innerSummary = null
            if (typeof parsed.summary === 'string' && parsed.summary.trim().startsWith('{')) {
              try { innerSummary = JSON.parse(parsed.summary.trim()) } catch {}
            } else if (typeof parsed.summary === 'object' && !Array.isArray(parsed.summary)) {
              innerSummary = parsed.summary
            }
            if (innerSummary && typeof innerSummary === 'object' && !Array.isArray(innerSummary)) {
              for (const key of Object.keys(innerSummary)) {
                if (innerSummary[key] !== null && innerSummary[key] !== undefined && !(Array.isArray(innerSummary[key]) && innerSummary[key].length === 0)) {
                  parsed[key] = innerSummary[key]
                }
              }
            }
          }
          return parsed
        } catch (e2) {
          // 两次 JSON 解析均失败，返回原始内容
        }
      }
      // Bailian 模型 JSON 截断时用 regex 直接提取 summary 字段值
      let fallbackSummary = ''
      if (content[0] === '{') {
        const m = content.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/)
        if (m) fallbackSummary = m[1]
      }
      return { summary: fallbackSummary || content.substring(0, 500) || '暂无摘要', keyPoints: [], topics: [] }
    }

  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时')
    throw error
  }
}

// 统一数组格式化：将字符串、对象数组或空值统一转为字符串数组（去重 + 序号归一化）
function normalizeStringList(value) {
  // 每项处理：清理噪音标点 + 序号归一化 1) 1、→ 1.，支持行内多处序号
  const cleanItem = (s) => {
    s = String(s)
    // 清理数字序号前的噪音标点（如 "，1)" → "1)"）
    s = s.replace(/^[^\w\d]*(\d+[\)、）])/, '$1')
    // 将 N) N、 N）统一为 N. 格式（全局替换，处理一行内多个序号如 "1)...2)...3)..."）
    s = s.replace(/(\d+)[\)、）]/g, '$1. ')
    // 移除列表标记符号（- * • 等），保留纯文本
    s = s.replace(/^[-*•]\s*/, '')
    return s.trim()
  }

  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return cleanItem(item)
        if (item && typeof item === 'object') return cleanItem(item.text || item.name || item.title || item.point || '')
        return ''
      })
      .filter(Boolean)
  }

  if (typeof value === 'string') {
    // 按换行或数字序号拆分为独立条目，再逐条归一化
    return value
      .split(/\n+|(?:\d+\s*[\)、）])/)
      .map(item => cleanItem(item))
      .filter(Boolean)
  }

  return []
}

// 从摘要中按标点拆分成句子，提取前5条作为关键要点（兜底方案）
function pointsFromSummary(summary, title) {
  const text = String(summary || '').replace(/\s+/g, ' ').trim()
  const sentences = text
    .split(/(?<=[。！？!?；;])\s*/)
    .map(item => item.trim())
    .filter(item => item.length >= 12)

  const points = sentences.slice(0, 5).map(s => {
    // 同样归一化序号格式 1) → 1.
    return s.replace(/(\d+)[\)、）]/g, '$1. ').trim()
  })
  while (points.length < 5) {
    points.push(points.length === 0
      ? `基于有限信息推断，视频《${title || '该视频'}》围绕标题呈现的核心主题展开，需要结合原视频进一步核对细节。`
      : '基于有限信息推断，该视频仍可从主题立意、表达方式、受众反应和内容价值等角度提炼关键结论。')
  }
  return points
}

// 递归展平：检测并解析 JSON 字符串字段（模型有时将对象序列化成字符串返回）
function tryParseField(value, depth = 0) {
  if (depth > 3) return value
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed === 'object') {
        // 如果是对象，提取其 summary/overview 字段，或递归展平
        if (parsed.summary || parsed.overview || parsed.abstract) {
          return tryParseField(parsed.summary || parsed.overview || parsed.abstract, depth + 1)
        }
        return parsed
      }
    } catch {}
  }
  return value
}

// 归一化 AI 模型分析结果：处理嵌套 JSON、缺失字段、垃圾数据，返回结构化分析
function normalizeAnalysisResult(raw, context = {}) {
  const result = raw && typeof raw === 'object' ? raw : {}
  const title = context.title || result.title || '视频'

  // 检测 result.summary 是否包含嵌套 JSON（模型有时把整个分析塞进 summary 字段）
  // 支持 JSON 字符串和直接对象两种形式
  let inner = null
  const rawSummaryField = result.summary || result.overview || result.abstract || ''
  if (typeof rawSummaryField === 'string') {
    try {
      const parsed = JSON.parse(rawSummaryField)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        inner = parsed  // 完整的内层分析对象
      }
    } catch {}
  } else if (rawSummaryField && typeof rawSummaryField === 'object' && !Array.isArray(rawSummaryField)) {
    inner = rawSummaryField  // 已经是对象，直接使用
  }

  // 从内层或外层提取 summary
  const rawSummary = inner ? tryParseField(inner.summary || inner.overview || '') : tryParseField(rawSummaryField)
  const summary = (typeof rawSummary === 'object' ? (rawSummary.summary || rawSummary.overview || '') : String(rawSummary)).trim()

  // 决定使用内层还是外层数据：有内层且内层包含 keyPoints 时优先用内层
  const useInner = inner && Array.isArray(inner.keyPoints)

  let keyPoints = normalizeStringList(result.keyPoints || result.key_points || result.points || result.highlights)
  const hasKeyPointsGarbage = keyPoints.length > 0 && keyPoints.some(k => k.trim().startsWith('{'))
  if (keyPoints.length === 0 || hasKeyPointsGarbage) {
    if (useInner) keyPoints = normalizeStringList(inner.keyPoints)
    // 即使 useInner 不可用，也过滤掉明显是 JSON 碎片的条目（以 { 开头）
    if (hasKeyPointsGarbage) keyPoints = keyPoints.filter(k => !k.trim().startsWith('{'))
  }

  const details = useInner && inner.details
    ? (typeof inner.details === 'object' ? inner.details : {})
    : (result.details && typeof result.details === 'object'
        ? Object.fromEntries(Object.entries(result.details).map(([k, v]) => [k, String(tryParseField(v)).trim()]))
        : {})
  const deepSource = useInner ? inner : result
  const deepAnalysis = deepSource.deepAnalysis || deepSource.deep_analysis
  const cleanedDeep = deepAnalysis && typeof deepAnalysis === 'object'
    ? Object.fromEntries(Object.entries(deepAnalysis).map(([k, v]) => [k, String(tryParseField(v)).trim()]))
    : deepAnalysis

  if (keyPoints.length === 0) {
    keyPoints = normalizeStringList([
      details.mainArgument,
      details.uniqueInsight,
      details.actionAdvice,
      deepAnalysis?.structure,
      deepAnalysis?.argumentQuality,
      deepAnalysis?.uniqueValue,
      deepAnalysis?.limitations
    ])
  }

  if (keyPoints.length === 0) {
    keyPoints = pointsFromSummary(summary, title)
  }

  let topics = normalizeStringList(result.topics || result.tags || result.keywords)
  const hasTopicsGarbage = topics.length > 0 && topics.some(t => t.trim().startsWith('{'))
  if (topics.length === 0 || hasTopicsGarbage) {
    if (useInner && inner.topics) topics = normalizeStringList(inner.topics)
  }
  if (topics.length === 0) {
    topics = keyPoints.slice(0, 6).map(point => point.replace(/[，。！？].*$/, '').slice(0, 18)).filter(Boolean)
  }

  const quotes = normalizeStringList(useInner ? (inner.quotes || result.quotes) : (result.quotes || []))
  const keyTakeaway = String(useInner ? (inner.keyTakeaway || result.keyTakeaway || '') : (result.keyTakeaway || '')).trim()

  // 检测 summary 是否为垃圾内容（仅含标点/极短），若无效则从 keyPoints 拼接
  let finalSummary = summary
  if (finalSummary) {
    const stripped = finalSummary.replace(/[，。！？、；：,\.!\?;:\s"'「」『』【】\[\]\(\)（）]/g, '')
    if (stripped.length < 5) {
      const fallbackParts = []
      if (keyPoints.length > 0) fallbackParts.push(keyPoints.slice(0, 3).join('；'))
      if (topics.length > 0) fallbackParts.push('涉及话题：' + topics.join('、'))
      finalSummary = fallbackParts.length > 0
        ? fallbackParts.join('。')
        : `基于有限信息推断，视频《${title}》为主题内容。当前缺少完整正文，系统已尽量提炼核心信息。`
    }
  }

  return {
    ...result,
    title: result.title || title,
    summary: finalSummary,
    keyPoints: keyPoints.slice(0, 10),
    topics: topics.slice(0, 10),
    details,
    deepAnalysis: cleanedDeep,
    quotes,
    keyTakeaway
  }
}

// 获取模型配置：fastest（豆包免费模型）和 recommended（百炼专业模型，需 VIP）
function getModelConfig(modelType) {
  const modelConfigs = {
    fastest: {
      apiKey: DOUBAO_API_KEY,
      baseUrl: DOUBAO_BASE_URL,
      model: DOUBAO_MODEL,
      maxTokens: 3000,
      temperature: 0.6,
      requiresVip: false,
      systemPrompt: `你是专业视频内容分析师。生成可直接展示的结构化分析。只返回纯 JSON，不要 Markdown。

{
  “summary”: “中文摘要，至少300字。说明主题背景、主要内容、核心观点和价值。”,
  “keyPoints”: [
    “要点1：一个具体观点+为何重要（50-70字）”,
    “要点2：一个具体观点+为何重要（50-70字）”,
    “要点3：一个具体观点+为何重要（50-70字）”,
    “要点4：一个具体观点+为何重要（50-70字）”,
    “要点5：一个具体观点+为何重要（50-70字）”
  ],
  “topics”: [“3到6个主题标签”],
  “details”: {
    “mainArgument”: “核心观点（60字以上）”,
    “uniqueInsight”: “最特别的洞察（60字以上）”,
    “actionAdvice”: “可执行的建议（60字以上）”
  }
}

即使素材有限也要填满所有字段，keyPoints 不能是空数组。`
    },
    recommended: {
      apiKey: BAILIAN_API_KEY,
      baseUrl: BAILIAN_BASE_URL,
      model: BAILIAN_MODEL_PRO,
      maxTokens: 4000, // tongyi-xiaomi-analysis-pro 调整为4000测试（原2000可能不足）
      temperature: 0.75,
      requiresVip: true,
      systemPrompt: `你是资深视频内容分析师、知识提炼专家和批判性思维教练。你的分析要比普通AI深一个层次——不只复述内容，而是解构、连接、提炼底层逻辑。

你的分析必须让读者感觉”看完这个分析比看原视频收获更大”。

只返回纯 JSON，不要 Markdown：

{
  “summary”: “深度摘要，800-1200字。结构：先用1-2句话点明视频的不可替代价值(50-80字)；接着说明为什么这个话题重要，当前共识和争议是什么(100-150字)；然后按逻辑链条分2-3段展开核心内容，每段指出关键论证、支撑证据和隐含假设(400-500字)；再指出视频中未被充分讨论的角度、可进一步探索的方向(150-200字)；最后提炼最值得记住的洞察(50字)。”,

  “keyPoints”: [
    “🎯 核心论点：完整阐述视频的中心论点和论证链条，包括前提→推理→结论(80-120字)”,
    “💡 颠覆认知：指出一个反常识或令人意外的观点/数据，解释为什么大多数人的直觉是错的(80-120字)”,
    “📊 关键证据：提取支撑观点的具体数据、案例、实验或引用，说明其说服力(80-120字)”,
    “🔍 思维模型：识别并解释视频使用的分析框架或思维模型(如第一性原理、系统思维、边际分析等)，说明这个模型为什么有效(80-120字)”,
    “⚡ 行动转化：把知识转化为可落地的行动步骤，说清楚「知道这个之后具体怎么做」(80-120字)”,
    “🔄 知识链接：将本视频的观点与其他领域知识建立非显而易见的连接(80-120字)”,
    “🎯 本质洞察：透过内容表象，揭示最底层的规律或人性洞察(80-120字)”
  ],

  “topics”: [“6到10个精准主题标签，涵盖技术/思维/方法/行业等维度”],

  “details”: {
    “mainArgument”: “核心观点的完整阐述，说清楚主张什么、为什么成立、有什么条件限制(150字以上)”,
    “uniqueInsight”: “本视频最独特或反直觉的一到两个洞察，以及为什么这个洞察有价值(150字以上)”,
    “actionAdvice”: “3条以上具体可执行的建议，每条包含场景+行动+预期效果(150字以上)”,
    “targetAudience”: “最适合哪些人观看？他们分别能获得什么？(80字以上)”,
    “prerequisite”: “理解此视频需要的前置知识或认知基础(50字以上)”,
    “difficultyLevel”: “入门/进阶/专业，并解释判断依据(50字以上)”
  },

  “deepAnalysis”: {
    “structure”: “内容结构深度拆解：开头如何抓住注意力→逻辑如何层层推进→高潮部分如何设计→结尾如何强化记忆。分析叙事策略和节奏控制(200字以上)”,
    “argumentQuality”: “论证质量评估：前提是否经得起推敲、推理过程是否有逻辑跳跃、证据是否充分且来源可靠、是否存在幸存者偏差/确认偏误/因果倒置等认知陷阱(200字以上)”,
    “uniqueValue”: “与其他同类内容的差异分析：这个视频在选题角度/表达方式/深度/信息密度上有什么不可替代的地方(150字以上)”,
    “limitations”: “批判性审视：视频刻意回避或没有涉及的角度、过度简化的复杂问题、可能存在的利益立场偏见(150字以上)”,
    “emotionalArc”: “情感设计分析：视频如何通过故事/数据/对比/悬念等手法引导观众情绪，情绪节奏如何服务于核心信息传递(100字以上)”
  },

  “quotes”: [
    “视频中最有冲击力的一句原话或核心金句，附上为什么这句话有力量”,
    “第二句值得反复思考的话，附上简短的解读角度”,
    “如果视频没有直接金句，提炼一句最能代表本视频精神的总结性语句”
  ],

  “keyTakeaway”: “如果读者只能记住一件事，应该记住什么？用一句话说清楚，要有冲击力(50字以内)”
}

核心要求：
- 摘要必须800字以上，禁止一句话敷衍
- 7条关键要点每条必须80字以上，不能有空泛表述
- 所有字段必须填满，不可留空或写”无”
- 如果素材不足，写”基于有限信息推断：{你的最佳分析}”而不是留空
- 展现批判性思维：不是复述，是解构、质疑、连接
- 让读者感觉”值得为这个分析开VIP”`
    }
  }

  return modelConfigs[modelType]
}

// ========== 全模态视频分析（文字逐字稿 + 视频画面帧）==========
// 使用 omni 多模态模型同时分析音频转写文本和视频截图
async function analyzeWithFrames(title, content, videoUrl, frames, modelType = 'recommended') {
  const config = getModelConfig(modelType)
  if (!config) throw new Error(`未知的模型类型: ${modelType}`)

  const vlModel = modelType === 'fastest' ? BAILIAN_MODEL_OMNI_FLASH : BAILIAN_MODEL_OMNI
  console.log(`🎬 全模态分析: ${frames.length} 帧, 模型=${vlModel}`)

  // 构建视觉模型配置（omni 全模态）
  const vlConfig = {
    apiKey: BAILIAN_API_KEY,
    baseUrl: BAILIAN_BASE_URL,
    model: vlModel,
    maxTokens: modelType === 'fastest' ? 3000 : 8000,
    temperature: 0.7
  }

  // 赛事知识：注入2026世界杯新赛制，防止模型因不了解48队扩军而出错
  const worldCupContext = `【参考资料】2026年美加墨世界杯是首次扩军至48队的赛事（此前为32队）。赛制：
- 12个小组×4队，小组前两名+8个成绩最好的小组第三出线
- 第一轮淘汰赛为1/16决赛（32强→16强），并非1/8决赛
- 第二轮淘汰赛才是1/8决赛（16强→8强）
- 随后依次为1/4决赛、半决赛、决赛
- 如果视频标题或逐字稿中的比赛涉及2026年世界杯淘汰赛，需注意区分轮次名称：首轮淘汰赛应称为"1/16决赛"而非"1/8决赛"`

  // 判断是否有足够的逐字稿内容（>10字符认为是有效稿件）
  const hasTranscript = content && content.trim().length > 10
  const jsonSchema = `{
  "summary": "深度摘要，覆盖主题背景、核心内容和价值洞察（500字以上）",
  "keyPoints": [
    "要点1：具体观点+重要性说明（50字以上）",
    "要点2：具体观点+重要性说明（50字以上）"
  ],
  "topics": ["主题标签1", "主题标签2"],
  "details": {
    "mainArgument": "核心观点阐述（80字以上）",
    "uniqueInsight": "最特别的洞察（80字以上）",
    "actionAdvice": "可执行的建议（80字以上）"
  },
  "deepAnalysis": {
    "structure": "内容结构分析（100字以上）",
    "argumentQuality": "论证质量评估（100字以上）",
    "uniqueValue": "差异分析（100字以上）",
    "limitations": "局限性（50字以上）"
  },
  "quotes": ["提炼的金句或总结句（每条附解读）"],
  "keyTakeaway": "一句话核心记忆点（30字以内）"
}`
  // 有逐字稿时：详细分析 prompt；无逐字稿时：仅基于画面分析，禁止编造
  const systemPrompt = hasTranscript
    ? `你是资深视频内容分析师，拥有视觉理解能力。你会同时收到视频的【完整逐字稿】和【视频画面截图】。
你需要结合两者进行分析：文字提供对话、术语和数据，画面提供图表、表情、实物演示、PPT、场景氛围等视觉信息。

${worldCupContext}

⚠️ 重要原则：该视频是真实的转播/录制内容，不是虚构作品或游戏模拟。画面截图可能因压缩或录制质量显得不够清晰，但这不代表内容是虚构的。禁止在分析中加入"虚构"、"模拟"、"游戏生成"等标签。

分析要求：
1. 优先使用文字内容提取核心观点和论证逻辑
2. 利用画面截图补充视觉信息：图表内容、人物表情、场景变化、实物展示、屏幕录制内容等
3. 如果文字和画面信息有冲突或互补，在分析中明确指出
4. 特别注意画面中的文字信息（PPT、白板、字幕等）
5. 事实核查：以文字内容为准，画面截图仅作辅助验证。不要因画面像素或渲染风格而否定内容的真实性
6. 比分和赛果以文字描述为准
7. 严格依据【参考资料】中的赛制规则识别比赛轮次，不要使用过时的32队赛制去推算
8. ⚠️ 关键限制：只呈现标题、逐字稿、画面中明确出现的信息。如果具体细节（如比赛轮次、球员姓名、比分、时间点等）在素材中没有被提及，不要自行补充或脑补。改用概括性语言（如"比赛中"、"某位球员"）代替具体数字或名称。宁可模糊，不可编造。

只返回纯 JSON，不要 Markdown，严格按以下格式（所有字段必填，不可留空）：
${jsonSchema}`
    : `你是资深视频内容分析师，拥有视觉理解能力。你只能看到【视频画面截图】和标题。
禁止编造具体细节，基于画面内容合理分析。
⚠️ 该视频是真实转播/录制内容，不是虚构或游戏模拟。

${worldCupContext}

⚠️ 关键限制：只呈现画面和标题中明确出现的信息，不脑补具体细节（如比分、球员、时间线）。不知道就用概括性语言。

只返回纯 JSON，不要 Markdown，严格按以下格式：
${jsonSchema}`

  // 拼接用户 prompt（标题 + 链接 + 逐字稿/无稿提示）
  const userPrompt = `视频标题：${title}\n视频链接：${videoUrl}\n\n${hasTranscript ? `【完整逐字稿】\n${content.substring(0, 30000)}` : '【无逐字稿，仅依据画面截图分析】'}`

  // 调用多模态 AI 模型，传入文字 + 画面帧
  const raw = await callAIModel(vlConfig, systemPrompt, userPrompt, frames)
  // 归一化结果后返回
  return normalizeAnalysisResult(raw, { title, videoUrl })
}

// 纯文字模型分析（无画面）：基于逐字稿 + 标题进行深度内容分析
async function analyzeWithModel(title, content, videoUrl, modelType = 'recommended') {
  const config = getModelConfig(modelType)
  if (!config) throw new Error(`未知的模型类型: ${modelType}`)
  const worldCupContext = `【参考资料】2026年世界杯扩军至48队，首轮淘汰赛为1/16决赛（非1/8），第二轮为1/8决赛。`
  const userPrompt = `视频标题：${title}\n视频链接：${videoUrl}\n\n${worldCupContext}\n\n可用内容：\n${content?.substring(0, 24000) || '无正文内容，请基于标题和上下文推断，但必须标注"基于有限信息推断"。'}\n\n⚠️ 关键限制：只呈现可用内容中明确出现的信息，不脑补未提及的具体细节。不知道的用概括性语言。`
  const raw = await callAIModel(config, config.systemPrompt, userPrompt)
  return normalizeAnalysisResult(raw, { title, videoUrl })
}

// 备用分析方案：当既无逐字稿又无画面时，仅基于标题和简介推断
async function analyzeWithoutContent(title, description, videoUrl, modelType = 'recommended') {
  console.log(`使用备用分析方案，模型: ${modelType}`)
  const config = getModelConfig(modelType)
  if (!config) throw new Error(`未知的模型类型: ${modelType}`)
  const systemPrompt = `你只能根据标题和简介推断视频内容。必须明确写“基于有限信息推断”，并返回完整 JSON：summary、keyPoints、topics、details、deepAnalysis、quotes。keyPoints 至少5条，不能空。`
  const userPrompt = `视频标题：${title}\n视频链接：${videoUrl}\n\n视频简介：${description || '无简介'}`
  const raw = await callAIModel(config, systemPrompt, userPrompt)
  return normalizeAnalysisResult(raw, { title, videoUrl })
}

// vision-tool 兜底方案：当无逐字稿但有视觉描述时，将描述作为内容源分析
async function analyzeWithVisionFallback(title, videoUrl, visionDescription, modelType = 'recommended') {
  if (!visionDescription) {
    return analyzeWithoutContent(title, '', videoUrl, modelType)
  }
  const config = getModelConfig(modelType)
  const systemPrompt = `你是资深视频内容分析师。你将收到一段【AI视觉模型对视频画面的详细描述】和视频标题。
请基于这些信息进行深度内容分析，输出结构化JSON。注意：
1. 视觉描述可能包含画面中的文字内容（如截图、PPT、字幕），优先使用这些文字信息
2. 禁止编造视觉描述中没有提及的具体细节
3. 如果信息不足，标注"基于画面信息推断"
只返回纯JSON，不要Markdown，严格按以下格式（所有字段必填，不可留空）：
{
  "summary": "深度摘要，覆盖主题背景、核心内容和价值洞察（300字以上）",
  "keyPoints": ["要点1：具体观点+重要性说明", "要点2：具体观点+重要性说明"],
  "topics": ["主题标签1", "主题标签2"],
  "details": {
    "mainArgument": "核心观点阐述",
    "uniqueInsight": "最特别的洞察",
    "actionAdvice": "可执行的建议"
  },
  "deepAnalysis": {
    "structure": "内容结构分析",
    "argumentQuality": "论证质量评估",
    "uniqueValue": "差异分析",
    "limitations": "局限性"
  },
  "quotes": ["提炼的金句或总结句"],
  "keyTakeaway": "一句话核心记忆点"
}`
  const userPrompt = `视频标题：${title}\n视频链接：${videoUrl}\n\n【AI视觉模型描述】\n${visionDescription}`
  const raw = await callAIModel(config, systemPrompt, userPrompt)
  return normalizeAnalysisResult(raw, { title, videoUrl })
}

// 将秒数格式化为可读的 HH:MM:SS 或 MM:SS 格式
function formatDuration(seconds) {
  if (!seconds) return '未知'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

// ASR 转写后纠错：利用文本模型根据视频标题修正同音错别字（领域知识辅助）
async function correctTranscription(text, videoTitle) {
  if (!text || text.length < 10) return text
  const systemPrompt = '你是一个语音转写纠错助手。根据视频标题提供的上下文，修正文本中的错别字和同音错误。只修正有把握的错误，不要改动无错误的部分。直接输出修正后的文本，不要多余的解释。'
  const userPrompt = `视频标题：${videoTitle}\n\n转写文本：\n${text.substring(0, 24000)}`
  try {
    const resp = await fetch(`${BAILIAN_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BAILIAN_API_KEY}` },
      body: JSON.stringify({ model: BAILIAN_MODEL_FLASH, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
    })
    if (!resp.ok) { console.warn(`⚠️ 转写纠错失败: ${resp.status}`); return text }
    const data = await resp.json()
    const corrected = data.choices[0].message.content.trim()
    if (corrected && corrected.length > text.length * 0.5) return corrected
    return text
  } catch (e) {
    console.warn('⚠️ 转写纠错异常:', e.message)
    return text
  }
}

module.exports = {
  getBeijingTime,
  getVideoInfo,
  getXiaohongshuVideoInfo,
  isXiaohongshuUrl,
  extractSubtitles,
  extractAudio,
  smartTranscribe,
  analyzeWithModel,
  analyzeWithFrames,
  analyzeWithoutContent,
  analyzeWithVisionFallback,
  extractFrames,
  extractSceneFrames,
  transcribeAudioWithOmni,
  correctTranscription,
  formatDuration,
  cleanupTempFile,
  processLocalVideo,
  callVisionTool,
  callVisionToolWithFrames
}
