const fs = require('fs')
const path = require('path')
const { exec, spawn } = require('child_process')
const util = require('util')

const execPromise = util.promisify(exec)

// 配置
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp'
const DOUYIN_COOKIES_FILE = path.join(__dirname, 'douyin_cookies.txt')
const BILIBILI_COOKIES_FILE = path.join(__dirname, 'bilibili_cookies.txt')
const tempDir = path.join(__dirname, 'temp')
const amagi = require('@ikenxuan/amagi');

// API Keys
const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY
const BAILIAN_BASE_URL = process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const BAILIAN_MODEL_PRO = process.env.BAILIAN_MODEL_PRO || 'tongyi-xiaomi-analysis-pro'
const BAILIAN_MODEL_FLASH = process.env.BAILIAN_MODEL_FLASH || 'tongyi-xiaomi-analysis-flash'
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

// ========== 抖音专用解析器（已禁用，返回友好错误）==========
async function getDouyinVideoInfo(videoUrl) {
  console.log(`🚫 抖音解析已禁用: ${videoUrl}`);
  throw new Error('抖音视频解析正在维护中，请使用 B站、YouTube 等其他平台链接');
}

// 构建 yt-dlp 命令（仅用于非抖音平台）
function buildYtdlpCommand(baseCmd, videoUrl) {
  let cmd = baseCmd
  cmd += ` --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"`
  
  // YouTube 代理配置
  if (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be')) {
    const proxy = process.env.YOUTUBE_PROXY || ''
    if (proxy) {
      cmd += ` --proxy "${proxy}"`
      console.log('🌐 使用代理访问 YouTube')
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
  
  // 抖音降级备用（已禁用）
  if (isDouyinUrl(videoUrl)) {
    console.log('⚠️ 抖音链接已被拦截，不会进入 yt-dlp 降级分支')
    throw new Error('抖音视频解析正在维护中，请使用其他平台链接')
  }
  
  cmd += ` "${videoUrl}"`
  return cmd
}

// amagi 解析器（已禁用）
async function getDouyinInfoWithAmagi(videoUrl) {
  console.log(`🚫 [amagi] 抖音解析已禁用: ${videoUrl}`);
  throw new Error('抖音视频解析正在维护中，请使用 B站、YouTube 等其他平台链接');
}

// 获取视频信息（主入口：抖音返回维护提示，其他走 yt-dlp）
async function getVideoInfo(videoUrl) {
  console.log(`📥 获取视频信息: ${videoUrl}`)
  
  // ========== 抖音链接拦截 - 返回维护提示 ==========
  if (isDouyinUrl(videoUrl)) {
    console.log('🚫 抖音解析暂时禁用（维护中）');
    throw new Error('抖音视频解析正在维护中，请使用 B站、YouTube 等其他平台链接');
  }
  // ========== 拦截结束 ==========
  
  // 非抖音平台：使用 yt-dlp
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
    return {
      title: info.title,
      duration: info.duration,
      thumbnail: thumbnail,
      uploader: info.uploader,
      description: info.description || '',
      webpage_url: info.webpage_url
    }
  } catch (error) {
    console.error('获取视频信息失败:', error.message)
    throw new Error('无法获取视频信息: ' + error.message)
  }
}

// 提取字幕
async function extractSubtitles(videoUrl) {
  console.log(`📝 提取字幕: ${videoUrl}`)
  
  // 抖音链接拦截
  if (isDouyinUrl(videoUrl)) {
    throw new Error('抖音视频解析正在维护中，请使用其他平台链接')
  }
  
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

// 下载音频
async function extractAudio(videoUrl) {
  console.log(`🎵 提取音频: ${videoUrl}`)
  
  // 抖音链接拦截
  if (isDouyinUrl(videoUrl)) {
    throw new Error('抖音视频解析正在维护中，请使用其他平台链接')
  }
  
  const tempId = Date.now() + '_' + Math.random().toString(36).substring(2, 8)
  const audioPath = path.join(tempDir, `${tempId}.mp3`)
  
  const baseCmd = `"${YTDLP_PATH}" -x --audio-format mp3 --audio-quality 0 --no-playlist -o "${audioPath}"`
  const cmd = buildYtdlpCommand(baseCmd, videoUrl)
  
  try {
    await execPromise(cmd, { timeout: 300000 })
    console.log(`✅ 音频下载完成: ${audioPath}`)
    return audioPath
  } catch (error) {
    console.error('提取音频失败:', error.message)
    return null
  }
}

// Whisper 转写（语音转文字）- 优化版
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

// 视频类型检测
function detectVideoType(title, description, duration) {
  const text = (title + ' ' + (description || '')).toLowerCase()
  
  const interviewKeywords = ['访谈', '对话', '采访', '讨论', '座谈', '圆桌', '嘉宾', '主持', 'talk', 'interview', 'podcast', 'panel', 'discussion']
  const musicKeywords = ['唱', '歌', '音乐', '歌曲', '演唱', 'live', '现场', '录音棚', '专辑', '单曲', 'MV', 'remix', 'cover']
  
  let interviewScore = 0
  let musicScore = 0
  
  interviewKeywords.forEach(kw => { if (text.includes(kw)) interviewScore++ })
  musicKeywords.forEach(kw => { if (text.includes(kw)) musicScore++ })
  
  if (duration && duration < 600) musicScore += 0.5
  
  if (interviewScore > 0 && interviewScore >= musicScore) return 'interview'
  if (musicScore > 0) return 'music'
  return 'tutorial'
}

// 智能转写路由（带降级方案）
async function smartTranscribe(videoUrl, videoTitle, videoDescription, videoDuration, enableSpeakerDiarization) {
  const videoType = detectVideoType(videoTitle, videoDescription, videoDuration)
  console.log(`📊 视频类型检测: ${videoType}`)
  
  // 音乐视频使用音乐模式
  if (videoType === 'music') {
    console.log('🎵 使用 Whisper 音乐模式')
    const audioPath = await extractAudio(videoUrl)
    if (!audioPath) {
      console.error('❌ 音频提取失败')
      return { text: "", method: 'none', videoType }
    }
    try {
      const text = await transcribeWithWhisper(audioPath, 'zh')
      return { text: `[SINGER] ${text}`, utterances: [], method: 'whisper-music', videoType }
    } catch (whisperError) {
      console.error('⚠️ Whisper 转写失败，使用降级方案:', whisperError.message)
      return { text: "无法识别语音内容，请检查视频是否有清晰的对白", method: 'none', videoType }
    } finally {
      if (audioPath) cleanupTempFile(audioPath)
    }
  }
  
  // 默认使用 Whisper
  console.log('🎙️ 使用 Whisper')
  const audioPath = await extractAudio(videoUrl)
  if (!audioPath) {
    console.error('❌ 音频提取失败')
    return { text: "", method: 'none', videoType }
  }
  try {
    const text = await transcribeWithWhisper(audioPath, 'zh')
    return { text, utterances: [], method: 'whisper', videoType }
  } catch (whisperError) {
    console.error('⚠️ Whisper 转写失败，使用降级方案:', whisperError.message)
    return { text: "", method: 'none', videoType }
  } finally {
    if (audioPath) cleanupTempFile(audioPath)
  }
}

// AI 模型调用
async function callAIModel(config, systemPrompt, userPrompt) {
  const { apiKey, baseUrl, model, maxTokens = 3000, temperature = 0.7 } = config
  
  if (!apiKey) {
    throw new Error(`${model} 模型不可用`)
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 120000)

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' }
      }),
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
      if (jsonMatch) return JSON.parse(jsonMatch[0])
      return {
        summary: content.substring(0, 500) || '暂无摘要',
        keyPoints: [],
        topics: []
      }
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

function normalizeAnalysisResult(raw, context = {}) {
  const result = raw && typeof raw === 'object' ? raw : {}
  const title = context.title || result.title || '视频'
  const summary = String(result.summary || result.overview || result.abstract || '').trim()
  let keyPoints = normalizeStringList(result.keyPoints || result.key_points || result.points || result.highlights)
  const details = result.details && typeof result.details === 'object' ? result.details : {}
  const deepAnalysis = result.deepAnalysis || result.deep_analysis

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
    deepAnalysis,
    quotes: normalizeStringList(result.quotes),
    keyTakeaway: result.keyTakeaway || ''
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
      maxTokens: 2000,
      temperature: 0.75,
      requiresVip: true,
      systemPrompt: `你是资深视频内容分析师、知识提炼专家和批判性思维教练。你的分析要比普通AI深一个层次——不只复述内容，而是解构、连接、提炼底层逻辑。

你的分析必须让读者感觉”看完这个分析比看原视频收获更大”。

只返回纯 JSON，不要 Markdown：

{
  “summary”: “深度摘要，800-1200字。结构：1)【核心定位】用1-2句话点明视频的不可替代价值(50-80字)；2)【背景与问题】为什么这个话题重要，当前共识和争议是什么(100-150字)；3)【内容深度解析】按逻辑链条分2-3段展开核心内容，每段指出关键论证、支撑证据和隐含假设(400-500字)；4)【反思与延伸】指出视频中未被充分讨论的角度、可进一步探索的方向(150-200字)；5)【一句话总结】提炼最值得记住的洞察(50字)。”,

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

async function analyzeWithModel(title, content, videoUrl, modelType = 'recommended') {
  const config = getModelConfig(modelType)
  if (!config) throw new Error(`未知的模型类型: ${modelType}`)
  const userPrompt = `视频标题：${title}\n视频链接：${videoUrl}\n\n可用内容：\n${content?.substring(0, 24000) || '无正文内容，请基于标题和上下文推断，但必须标注“基于有限信息推断”。'}`
  const raw = await callAIModel(config, config.systemPrompt, userPrompt)
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
  extractSubtitles,
  extractAudio,
  smartTranscribe,
  analyzeWithModel,
  analyzeWithoutContent,
  formatDuration,
  cleanupTempFile
}
