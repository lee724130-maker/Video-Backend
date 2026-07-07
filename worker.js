// 队列消费 Worker：从 Bull 队列中取出视频分析任务并依次处理
const { videoQueue } = require('./queue')
const pool = require('./db')
const fs = require('fs')
// 引入核心视频处理模块的所有分析函数
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
  correctTranscription,
  formatDuration,
  cleanupTempFile
} = require('./videoProcessor')

// 注册队列消费者：每次并发处理1个任务（parse-video 类型）
videoQueue.process('parse-video', 1, async (job) => {
  // 从任务数据中解析参数
  const { taskId, url, model, language, enableSpeakerDiarization, videoInfo } = job.data
  const taskStartTime = Date.now()

  console.log(`🔧 Worker 开始处理任务 ${taskId}: ${url}`)

  try {
    // videoContent: 字幕文本或 smartTranscribe 结果对象
    let videoContent = null
    let contentMethod = 'none'
    let transcript = ''

    // ========== 阶段1: 尝试提取字幕 ==========
    try {
      videoContent = await extractSubtitles(url)
      if (videoContent) contentMethod = 'subtitle'
    } catch (e) {}

    // ========== 阶段2: 字幕失败则提取音频（供云端 ASR 转写）==========
    if (!videoContent) {
      const transcribeResult = await smartTranscribe(url, videoInfo.title, videoInfo.description, videoInfo.duration, enableSpeakerDiarization, videoInfo.video_url)
      videoContent = transcribeResult
      contentMethod = transcribeResult.method
    }

    const localVideoPath = videoContent?.videoPath || ''

    // ========== 阶段3: 视频画面抽帧（本地优先，直链降级）==========
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

    // ========== 阶段4: 云端 ASR 转写（字幕和直接转录都失败时降级使用）==========
    const contentText = videoContent && typeof videoContent === 'object' ? videoContent.text : (videoContent || '')
    if (!contentText && videoContent?.audioPath) {
      console.log('🎙️ 使用 ASR 转写音频...')
      transcript = await transcribeAudioWithOmni(videoContent.audioPath, videoInfo.title)
      if (transcript) {
        console.log('✏️ 转写纠错中...')
        transcript = await correctTranscription(transcript, videoInfo.title)
        contentMethod = 'asr-transcribe'
      } else {
        contentMethod = 'none'
      }
      cleanupTempFile(videoContent.audioPath)
    }

    // 最终传递给分析引擎的文本内容（优先使用 ASR 转写结果）
    const finalContent = transcript || contentText

    // ========== 阶段5: AI 内容分析（全模态→纯文字降级）==========
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

    // 清理本地下载的视频文件（如有）
    if (localVideoPath) {
      try { fs.unlinkSync(localVideoPath) } catch {}
    }

    // 如果标题仍为占位符（解析中...），从摘要中提取前20字作为标题
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

    // ========== 阶段6: 更新数据库任务状态为完成 ==========
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
    // 任务失败：更新数据库状态为 failed，保存错误信息
    console.error(`❌ 任务 ${taskId} 处理失败:`, error)
    await pool.query(
      `UPDATE video_tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`,
      [error.message, getBeijingTime(), taskId]
    )
    throw error
  }
})

console.log('🚀 Worker 进程已启动，等待任务...')