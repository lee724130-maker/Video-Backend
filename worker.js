const { videoQueue } = require('./queue')
const pool = require('./db')
const fs = require('fs')
const {
  getBeijingTime,
  getVideoInfo,
  extractSubtitles,
  smartTranscribe,
  analyzeWithModel,
  analyzeWithFrames,
  analyzeWithoutContent,
  extractFrames,
  extractSceneFrames,
  transcribeAudioWithOmni,
  formatDuration,
  cleanupTempFile
} = require('./videoProcessor')

videoQueue.process('parse-video', 1, async (job) => {
  const { taskId, url, model, language, enableSpeakerDiarization, videoInfo } = job.data
  const taskStartTime = Date.now()

  console.log(`🔧 Worker 开始处理任务 ${taskId}: ${url}`)

  try {
    let videoContent = null
    let contentMethod = 'none'
    let transcript = ''

    // 1. 字幕提取
    try {
      videoContent = await extractSubtitles(url)
      if (videoContent) contentMethod = 'subtitle'
    } catch (e) {}

    // 2. 音频提取（跳过本地 Whisper，提取路径供云端转写）
    if (!videoContent) {
      const transcribeResult = await smartTranscribe(url, videoInfo.title, videoInfo.description, videoInfo.duration, enableSpeakerDiarization, videoInfo.video_url)
      videoContent = transcribeResult
      contentMethod = transcribeResult.method
    }

    const localVideoPath = videoContent?.videoPath || ''

    // 3. 场景检测抽帧（有本地视频则从本地，否则从直链）
    let frames = []
    if (localVideoPath) {
      console.log(`🎬 场景检测抽帧: ${localVideoPath}`)
      frames = await extractSceneFrames(localVideoPath, 5)
    } else if (videoInfo.video_url) {
      console.log(`🎬 从直链抽帧: ${videoInfo.video_url?.substring(0, 50)}...`)
      frames = await extractFrames(videoInfo.video_url, videoInfo.duration, 8)
    } else {
      console.log(`⏭️ 跳过抽帧: 无视频来源`)
    }
    console.log(`🎬 抽帧结果: ${frames.length} 帧`)

    // 4. 云端音频转写（当字幕和转录都未提供内容时）
    const contentText = videoContent && typeof videoContent === 'object' ? videoContent.text : (videoContent || '')
    if (!contentText && videoContent?.audioPath) {
      console.log('🎙️ 使用 ASR 转写音频...')
      transcript = await transcribeAudioWithOmni(videoContent.audioPath)
      contentMethod = transcript ? 'asr-transcribe' : 'none'
      cleanupTempFile(videoContent.audioPath)
    }

    const finalContent = transcript || contentText

    // 5. 分析
    let analysisResult
    if (frames.length > 0) {
      try {
        analysisResult = await analyzeWithFrames(videoInfo.title, finalContent, url, frames, model)
      } catch (e) {
        console.warn('⚠️ 全模态分析失败，回退到文字分析:', e.message)
        analysisResult = await analyzeWithModel(videoInfo.title, finalContent, url, model)
      }
    } else {
      analysisResult = await analyzeWithModel(videoInfo.title, finalContent, url, model)
    }

    if (localVideoPath) {
      try { fs.unlinkSync(localVideoPath) } catch {}
    }

    // 如果标题仍为占位符，从摘要中提取前20字作为标题
    let finalTitle = videoInfo.title
    if (finalTitle === '解析中...' || finalTitle === '解析中…' || finalTitle === '未知视频' || !finalTitle) {
      const extracted = (analysisResult.summary || '').replace(/^[""']+/, '').substring(0, 40).trim()
      finalTitle = extracted || '视频分析'
    }

    const resultData = {
      summary: analysisResult.summary,
      keyPoints: analysisResult.keyPoints,
      title: finalTitle,
      thumbnail: videoInfo.thumbnail,
      duration: formatDuration(videoInfo.duration),
      video_url: videoInfo.video_url || '',
      topics: analysisResult.topics,
      details: analysisResult.details || {},
      deepAnalysis: analysisResult.deepAnalysis || null,
      quotes: analysisResult.quotes || [],
      language: language,
      modelUsed: model,
      dialogues: videoContent?.utterances || [],
      webpage_url: videoInfo.webpage_url || '',
      source_url: job.data.url || ''
    }

    const processingTime = Math.floor((Date.now() - taskStartTime) / 1000)
    await pool.query(
      `UPDATE video_tasks 
       SET status = 'completed', result_data = ?, video_title = ?, 
           video_duration = ?, processing_time = ?, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(resultData), finalTitle, videoInfo.duration || 0, processingTime, getBeijingTime(), taskId]
    )

    console.log(`✅ 任务 ${taskId} 处理完成，耗时 ${processingTime} 秒`)
    return { taskId, status: 'completed', result: resultData }

  } catch (error) {
    console.error(`❌ 任务 ${taskId} 处理失败:`, error)
    await pool.query(
      `UPDATE video_tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`,
      [error.message, getBeijingTime(), taskId]
    )
    throw error
  }
})

console.log('🚀 Worker 进程已启动，等待任务...')