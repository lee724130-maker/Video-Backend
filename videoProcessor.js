const fs = require('fs')
const path = require('path')
const { exec, spawn } = require('child_process')
const util = require('util')

const execPromise = util.promisify(exec)

// 配置
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp'
const BILIBILI_COOKIES_FILE = path.join(__dirname, 'bilibili_cookies.txt')
const tempDir = path.join(__dirname, 'temp')

// API Keys
const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY
const BAILIAN_BASE_URL = process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const BAILIAN_MODEL_PRO = process.env.BAILIAN_MODEL_PRO || 'tongyi-xiaomi-analysis-pro'
const BAILIAN_MODEL_FLASH = process.env.BAILIAN_MODEL_FLASH || 'tongyi-xiaomi-analysis-flash'
const BAILIAN_MODEL_VL = process.env.BAILIAN_MODEL_VL || 'qwen2.5-vl-72b-instruct'
const BAILIAN_MODEL_VL_LITE = process.env.BAILIAN_MODEL_VL_LITE || 'qwen2.5-vl-7b-instruct'
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com'
const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY
const DOUBAO_BASE_URL = process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
const DOUBAO_MODEL = process.env.DOUBAO_MODEL || 'doubao-lite-32k'

// 获取北京时间
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

// 提取 YouTube ID
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

// 从抖音短链接中提取 video_id
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

  // 短链接 v.douyin.com/xxx → 多次尝试获取 video ID
  // 方法1: 用 redirect follow 获取最终 URL
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

  // 方法2: 从分享短链接 HTML 中提取 canonical URL 或 video ID
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

  // 方法3: 提取短码，让 getDouyinVideoInfo 用 iesdouyin + Playwright 兜底
  const shortCode = urlStr.match(/v\.douyin\.com\/([a-zA-Z0-9]+)/)
  if (shortCode) return shortCode[1]

  throw new Error('无法从抖音链接中提取视频ID')
}

// 从 HTML 中提取 window._ROUTER_DATA JSON
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

// ========== 抖音解析器（基于 iesdouyin.com 分享页）==========
async function getDouyinVideoInfo(videoUrl) {
  console.log(`📱 解析抖音视频: ${videoUrl}`)

  const videoId = await resolveDouyinVideoId(videoUrl)
  let html = ''
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

  const data = extractRouterData(html)

  if (data) {
    const loaderData = data.loaderData
    const videoKey = Object.keys(loaderData).find(k => k !== 'video_layout' && loaderData[k]?.videoInfoRes)
    const item = videoKey ? loaderData[videoKey].videoInfoRes.item_list?.[0] : undefined
    if (item) {
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

  // Fallback: use Douyin Web API directly
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

  // Fallback: Playwright 浏览器解析
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

// 构建 yt-dlp 命令
function buildYtdlpCommand(baseCmd, videoUrl) {
  let cmd = baseCmd
  cmd += ` --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"`
  
  // YouTube 配置
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

  // B站专用请求头
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

// ========== 小红书解析器（基于 Playwright）==========
const XHS_COOKIE_FILE = path.join(__dirname, 'xiaohongshu_cookies.json')

async function getXiaohongshuVideoInfo(videoUrl) {
  const { resolveXiaohongshuWithPlaywright } = require('./xiaohongshu_playwright')

  // 首次：匿名解析
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

// 获取视频信息（主入口：抖音走Playwright，小红书走Playwright，其他走 yt-dlp）
async function getVideoInfo(videoUrl) {
  console.log(`📥 获取视频信息: ${videoUrl}`)
  
  // 抖音使用专用解析器
  if (isDouyinUrl(videoUrl)) {
    return await getDouyinVideoInfo(videoUrl)
  }
  
  // 小红书使用 Playwright 解析器
  if (isXiaohongshuUrl(videoUrl)) {
    return await getXiaohongshuVideoInfo(videoUrl)
  }
  
  // 其他平台：使用 yt-dlp
  console.log('🔍 使用 yt-dlp 解析')
  const baseCmd = `"${YTDLP_PATH}" --dump-json --skip-download`
  const cmd = buildYtdlpCommand(baseCmd, videoUrl)
  
  try {
    const { stdout } = await execPromise(cmd, { timeout: 60000 })
    const info = JSON.parse(stdout)
    let thumbnail = info.thumbnail || ''
    if (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be')) {
      const videoId = extractYouTubeId(videoUrl)
      if (videoId) thumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
    }
    let directUrl = info.url
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

// 提取字幕
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

// 下载视频文件到本地
async function downloadVideo(videoUrl, outputPath) {
  console.log(`📥 下载视频: ${videoUrl?.substring(0, 50)}...`)
  const cmd = `curl -L -s -o "${outputPath}" "${videoUrl}" --connect-timeout 30 --max-time 300`
  await execPromise(cmd, { timeout: 310000 })
  console.log(`✅ 视频下载完成: ${outputPath}`)
}

// 下载音频（yt-dlp 优先，失败则下载完整视频后从本地提取）
// 返回 { audioPath, videoPath }，videoPath 可能为空
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

// Whisper 转写（语音转文字）- 优化版
async function transcribeWithWhisper(audioPath, language = 'zh', modelName = 'tiny') {
  console.log(`🎙️ 开始语音转文字，模型=${modelName}, 语言: ${language}`)

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
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Missing arguments"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    model_name = sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 else None

    try:
        model = whisper.load_model(model_name)
        result = model.transcribe(audio_path, language=language if language != "auto" else None)
        print(json.dumps({"text": result["text"], "language": result["language"]}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
`
    const pythonProcess = spawn('python3', ['-c', pythonScript, audioPath, modelName, language])

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

      // 先检查 stdout 中是否有错误信息，再检查退出码
      let errorFromOutput = ''
      try {
        const parsed = JSON.parse(output)
        if (parsed.error) errorFromOutput = parsed.error
      } catch {}

      if (code !== 0) {
        const errMsg = errorFromOutput || errorOutput || '未知错误'
        console.error(`Whisper ${modelName} 转写失败: ${errMsg}`)
        reject(new Error(`语音转文字失败: ${errMsg}`))
        return
      }

      if (errorFromOutput) {
        reject(new Error(errorFromOutput))
        return
      }

      try {
        const result = JSON.parse(output)
        console.log(`✅ 语音转文字完成(模型=${modelName})，检测到语言: ${result.language}`)
        resolve(result.text)
      } catch (e) {
        console.error('解析 Whisper 输出失败:', e)
        console.error('原始输出:', output)
        reject(new Error('解析转写结果失败'))
      }
    })
  })
}

// 视频类型检测
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
  
  // 体育赛事优先识别，走默认转录路径（非音乐模式）
  if (sportsScore > 0) return 'sports'

  if (duration && duration < 600 && musicScore > 0) musicScore += 0.5

  if (interviewScore > 0 && interviewScore >= musicScore) return 'interview'
  if (musicScore >= 1) return 'music'
  return 'tutorial'
}

// 智能转写路由（带降级方案）
async function smartTranscribe(videoUrl, videoTitle, videoDescription, videoDuration, enableSpeakerDiarization, fallbackUrl) {
  const videoType = detectVideoType(videoTitle, videoDescription, videoDuration)
  console.log(`📊 视频类型检测: ${videoType}`)
  
  // 音乐视频使用音乐模式
  if (videoType === 'music') {
    console.log('🎵 使用 Whisper 音乐模式')
    const { audioPath, videoPath } = await extractAudio(videoUrl, fallbackUrl)
    if (!audioPath) {
      console.error('❌ 音频提取失败')
      return { text: "", method: 'none', videoType, videoPath: '' }
    }
    try {
      const text = await transcribeWithWhisper(audioPath, 'zh')
      return { text: `[SINGER] ${text}`, utterances: [], method: 'whisper-music', videoType, videoPath }
    } catch (whisperError) {
      console.error('⚠️ Whisper 转写失败，使用降级方案:', whisperError.message)
      return { text: "无法识别语音内容，请检查视频是否有清晰的对白", method: 'none', videoType, videoPath: '' }
    } finally {
      if (audioPath) cleanupTempFile(audioPath)
    }
  }
  
  // 默认使用 Whisper
  console.log('🎙️ 使用 Whisper')
  const { audioPath, videoPath } = await extractAudio(videoUrl, fallbackUrl)
  if (!audioPath) {
    console.error('❌ 音频提取失败')
    return { text: "", method: 'none', videoType, videoPath: '' }
  }
  try {
    // 先尝试 tiny 模型
    const text = await transcribeWithWhisper(audioPath, 'zh', 'tiny')
    return { text, utterances: [], method: 'whisper', videoType, videoPath }
  } catch (whisperError) {
    console.warn(`⚠️ tiny 模型失败: ${whisperError.message}，尝试 base 模型...`)
    try {
      const text = await transcribeWithWhisper(audioPath, 'zh', 'base')
      return { text, utterances: [], method: 'whisper', videoType, videoPath }
    } catch (baseError) {
      console.error('⚠️ base 模型也失败，使用降级方案:', baseError.message)
      return { text: "", method: 'none', videoType, videoPath: '' }
    }
  } finally {
    if (audioPath) cleanupTempFile(audioPath)
  }
}

// 抽帧（视频画面截图），优先使用本地视频文件
async function extractFrames(videoUrl, duration, maxFrames = 8, localPath = '') {
  if (!videoUrl && !localPath) return []
  const tempId = Date.now() + '_' + Math.random().toString(36).substring(2, 8)
  const frameDir = path.join(tempDir, `frames_${tempId}`)
  fs.mkdirSync(frameDir, { recursive: true })

  const interval = Math.max(Math.floor(duration / maxFrames), 10)
  const outputPattern = path.join(frameDir, 'frame_%03d.jpg')

  const inputSource = localPath || videoUrl
  console.log(`🎬 抽帧: ${localPath ? '本地文件' : 'URL'}, interval=${interval}s, ${maxFrames}帧`)

  const cmd = `ffmpeg -y -i "${inputSource}" -vf "fps=1/${interval}" -vframes ${maxFrames} -q:v 2 "${outputPattern}" -loglevel error`

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

// 统一本地视频处理管道（用于已下载的视频文件或本地上传）
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

// AI 模型调用
async function callAIModel(config, systemPrompt, userPrompt, frames = []) {
  const { apiKey, baseUrl, model, maxTokens = 3000, temperature = 0.7 } = config

  if (!apiKey) {
    throw new Error(`${model} 模型不可用`)
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 180000)

    const messages = [
      { role: 'system', content: systemPrompt }
    ]

    if (frames.length > 0) {
      const content = [{ type: 'text', text: userPrompt }]
      frames.forEach(frame => {
        content.push({ type: 'image_url', image_url: { url: frame } })
      })
      messages.push({ role: 'user', content })
    } else {
      messages.push({ role: 'user', content: userPrompt })
    }

    const requestBody = {
      model: model,
      messages,
      temperature: temperature,
      max_tokens: maxTokens
    }
    // 文本请求启用 JSON 模式，VL 模型不支持此参数
    if (frames.length === 0) {
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
    let content = data.choices[0].message.content
    
    content = content.trim()
    if (content.startsWith('```json')) content = content.substring(7)
    else if (content.startsWith('```')) content = content.substring(3)
    if (content.endsWith('```')) content = content.substring(0, content.length - 3)
    content = content.trim()
    
      try {
        return JSON.parse(content)
      } catch (parseError) {
        const jsonMatch = content.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          try {
            return JSON.parse(jsonMatch[0])
          } catch (e2) {
            // 两次 JSON 解析均失败，返回原始内容
          }
        }
        return { summary: content.substring(0, 500) || '暂无摘要', keyPoints: [], topics: [] }
      }
    
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时')
    throw error
  }
}

// 统一数组格式（字符串/对象/空值 → 字符串数组）
function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') return item.text || item.name || item.title || item.point || ''
        return ''
      })
      .map(item => String(item).replace(/^\s*(\d+[\.\)、)]|[-*•])\s*/, '').trim())
      .filter(Boolean)
  }

  if (typeof value === 'string') {
    return value
      .split(/\n+|(?:\d+[\.\)、)]\s*)/)
      .map(item => item.trim())
      .filter(Boolean)
  }

  return []
}

function pointsFromSummary(summary, title) {
  const text = String(summary || '').replace(/\s+/g, ' ').trim()
  const sentences = text
    .split(/(?<=[。！？!?；;])\s*/)
    .map(item => item.trim())
    .filter(item => item.length >= 12)

  const points = sentences.slice(0, 5)
  while (points.length < 5) {
    points.push(points.length === 0
      ? `基于有限信息推断，视频《${title || '该视频'}》围绕标题呈现的核心主题展开，需要结合原视频进一步核对细节。`
      : '基于有限信息推断，该视频仍可从主题立意、表达方式、受众反应和内容价值等角度提炼关键结论。')
  }
  return points
}

// 统一编号格式：1）→ 1.  2）→ 2.  等
function normalizeNumbering(text) {
  if (typeof text !== 'string') return text
  return text.replace(/(\d+)[）)]/g, '$1.')
}

// 递归展平 JSON 字符串字段：如果字段值是 JSON 字符串，解析并提取
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

function normalizeAnalysisResult(raw, context = {}) {
  const result = raw && typeof raw === 'object' ? raw : {}
  const title = context.title || result.title || '视频'
  // 递归展平 summary，防止双层 JSON
  const rawSummary = tryParseField(result.summary || result.overview || result.abstract || '')
  const summary = (typeof rawSummary === 'object' ? (rawSummary.summary || rawSummary.overview || '') : String(rawSummary)).trim()
  let keyPoints = normalizeStringList(result.keyPoints || result.key_points || result.points || result.highlights).map(kp => normalizeNumbering(kp))
  const details = result.details && typeof result.details === 'object'
    ? Object.fromEntries(Object.entries(result.details).map(([k, v]) => [k, normalizeNumbering(String(tryParseField(v)).trim())]))
    : {}
  const deepAnalysis = result.deepAnalysis || result.deep_analysis
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
  if (topics.length === 0) {
    topics = keyPoints.slice(0, 6).map(point => point.replace(/[，。！？].*$/, '').slice(0, 18)).filter(Boolean)
  }

  return {
    ...result,
    title: result.title || title,
    summary: summary || `基于有限信息推断，视频《${title}》围绕标题与可获取素材展开。当前缺少完整正文，系统已尽量提炼核心主题、可能观点和观看价值，建议结合原视频继续核对细节。`,
    keyPoints: keyPoints.slice(0, 10),
    topics: topics.slice(0, 10),
    details,
    deepAnalysis: cleanedDeep,
    quotes: normalizeStringList(result.quotes),
    keyTakeaway: String(result.keyTakeaway || '').trim()
  }
}

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
      maxTokens: 2000, // tongyi-xiaomi-analysis-pro 上限 2000
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

// 双通道分析（文字+画面）
async function analyzeWithFrames(title, content, videoUrl, frames, modelType = 'recommended') {
  const config = getModelConfig(modelType)
  if (!config) throw new Error(`未知的模型类型: ${modelType}`)
  
  const vlModel = modelType === 'fastest' ? BAILIAN_MODEL_VL_LITE : BAILIAN_MODEL_VL
  console.log(`🎬 双通道分析: ${frames.length} 帧, 模型=${vlModel}`)

  const vlConfig = {
    apiKey: BAILIAN_API_KEY,
    baseUrl: BAILIAN_BASE_URL,
    model: vlModel,
    maxTokens: modelType === 'fastest' ? 2000 : 6000,
    temperature: 0.7
  }

  const hasContent = content && content.length > 10
  const noContentWarning = hasContent ? '' : `
⚠️ 重要限制：当前【没有可用的文字内容】（字幕/语音转写全部失败），你只能依据视频标题和画面截图分析。
- 禁止编造具体数字、比分、时间、人名等无法从画面直接确认的细节
- 如果画面中看不到记分牌或具体比分，请标注"（基于画面推断）"
- 分析可以基于画面内容合理推测，但必须在分析中明确标注"（画面推测）"
- 宁可写得简短诚实，也不要编造虚假细节`

  const systemPrompt = `你是资深视频内容分析师，拥有视觉理解能力。你会同时收到视频的【文字内容（字幕/语音转写）】和【视频画面截图】。
你需要结合两者进行分析：文字提供对话、术语和数据，画面提供图表、表情、实物演示、PPT、场景氛围等视觉信息。${noContentWarning}

分析要求：
1. 优先使用文字内容提取核心观点和论证逻辑
2. 利用画面截图补充视觉信息：图表内容、人物表情、场景变化、实物展示、屏幕录制内容等
3. 如果文字和画面信息有冲突或互补，在分析中明确指出
4. 特别注意画面中的文字信息（PPT、白板、字幕等）
5. ⛔ 事实核查：当文字内容提到具体比分、进球、红牌、点球等具体事实时，必须检查画面截图是否能佐证。如果画面无法佐证，请标注"（待核实）"
6. 📊 比分和赛果必须交叉验证：文字描述的比分/结果需要与画面中的记分牌或庆祝画面比对，不一致时以画面为准并标注差异

只返回纯 JSON，不要 Markdown，格式与 text-only 分析完全一致。`

  const userPrompt = `视频标题：${title}\n视频链接：${videoUrl}\n\n【文字内容（字幕/语音转写）】\n${content?.substring(0, 24000) || '无文字内容'}\n\n【视频画面截图说明】\n以下每张截图按时间顺序排列，请分析其中的视觉信息并与文字内容结合。`

  const raw = await callAIModel(vlConfig, systemPrompt, userPrompt, frames)
  return normalizeAnalysisResult(raw, { title, videoUrl })
}

async function analyzeWithModel(title, content, videoUrl, modelType = 'recommended') {
  const config = getModelConfig(modelType)
  if (!config) throw new Error(`未知的模型类型: ${modelType}`)
  const hasContent = content && content.length > 10
  let systemPrompt = config.systemPrompt
  if (!hasContent) {
    systemPrompt = `你只能根据标题和信息推断视频内容。必须明确写“基于有限信息推断”。\n\n重要限制：没有可用的文字内容（字幕/语音转写失败），禁止编造具体数字、比分、人名等无法确认的细节。\n\n格式要求与标准分析完全一致：返回完整 JSON，包含 summary、keyPoints、topics、details、deepAnalysis、quotes。\n- keyPoints 至少3条，每条标注"（基于有限信息）"\n- 宁可简短诚实，不要编造虚假信息`
  }
  const userPrompt = `视频标题：${title}\n视频链接：${videoUrl}\n\n可用内容：\n${content?.substring(0, 24000) || '无正文内容，请基于标题和上下文推断，但必须标注“基于有限信息推断”。'}`
  const raw = await callAIModel(config, systemPrompt, userPrompt)
  return normalizeAnalysisResult(raw, { title, videoUrl })
}

async function analyzeWithoutContent(title, description, videoUrl, modelType = 'recommended') {
  console.log(`使用备用分析方案，模型: ${modelType}`)
  const config = getModelConfig(modelType)
  if (!config) throw new Error(`未知的模型类型: ${modelType}`)
  const systemPrompt = `你只能根据标题和简介推断视频内容。必须明确写“基于有限信息推断”，并返回完整 JSON：summary、keyPoints、topics、details、deepAnalysis、quotes。keyPoints 至少5条，不能空。`
  const userPrompt = `视频标题：${title}\n视频链接：${videoUrl}\n\n视频简介：${description || '无简介'}`
  const raw = await callAIModel(config, systemPrompt, userPrompt)
  return normalizeAnalysisResult(raw, { title, videoUrl })
}

function formatDuration(seconds) {
  if (!seconds) return '未知'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${minutes}:${String(secs).padStart(2, '0')}`
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
  extractFrames,
  formatDuration,
  cleanupTempFile,
  processLocalVideo
}
