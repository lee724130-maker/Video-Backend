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

    try {
      videoContent = await extractSubtitles(url)
      if (videoContent) contentMethod = 'subtitle'
    } catch (e) {}

    if (!videoContent) {
      const transcribeResult = await smartTranscribe(url, videoInfo.title, videoInfo.description, videoInfo.duration, enableSpeakerDiarization, videoInfo.video_url)
      videoContent = transcribeResult
      contentMethod = transcribeResult.method
    }

    const contentText = videoContent && typeof videoContent === 'object' ? videoContent.text : (videoContent || '')

    let analysisResult
    const localVideoPath = videoContent?.videoPath || ''

    let frames = []
    if (localVideoPath) {
      console.log(`🎬 从本地文件抽帧: ${localVideoPath}`)
      frames = await extractFrames('', videoInfo.duration, 8, localVideoPath)
      console.log(`🎬 抽帧结果: ${frames.length} 帧`)
    } else if (videoInfo.video_url) {
      console.log(`🎬 从直链抽帧: ${videoInfo.video_url?.substring(0, 50)}...`)
      frames = await extractFrames(videoInfo.video_url, videoInfo.duration, 8)
      console.log(`🎬 抽帧结果: ${frames.length} 帧`)
    } else {
      console.log(`⏭️ 跳过抽帧: 无视频来源`)
    }

    if (frames.length > 0) {
      try {
        analysisResult = await analyzeWithFrames(videoInfo.title, contentText, url, frames, model)
      } catch (e) {
        console.warn('⚠️ 双通道分析失败，回退到文字分析:', e.message)
        analysisResult = await analyzeWithModel(videoInfo.title, contentText, url, model)
      }
    } else {
      analysisResult = await analyzeWithModel(videoInfo.title, contentText, url, model)
    }

    if (localVideoPath) {
      try { fs.unlinkSync(localVideoPath) } catch {}
    }

    const resultData = {
      summary: analysisResult.summary,
      keyPoints: analysisResult.keyPoints,
      title: videoInfo.title,
      thumbnail: videoInfo.thumbnail,
      duration: formatDuration(videoInfo.duration),
      video_url: videoInfo.video_url || '',
      topics: analysisResult.topics,
      details: analysisResult.details || {},
      deepAnalysis: analysisResult.deepAnalysis || null,
      quotes: analysisResult.quotes || [],
      modelUsed: model,
      contentMethod: contentMethod,
      language: language,
      dialogues: videoContent?.utterances || [],
      videoType: videoContent?.videoType || 'unknown',
      webpage_url: videoInfo.webpage_url || '',
      source_url: job.data.url || ''
    }

    const processingTime = Math.floor((Date.now() - taskStartTime) / 1000)
    await pool.query(
      `UPDATE video_tasks 
       SET status = 'completed', result_data = ?, video_title = ?, 
           video_duration = ?, processing_time = ?, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(resultData), videoInfo.title, videoInfo.duration || 0, processingTime, getBeijingTime(), taskId]
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