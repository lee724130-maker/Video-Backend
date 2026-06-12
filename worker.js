const { videoQueue } = require('./queue')
const pool = require('./db')
const {
  getBeijingTime,
  getVideoInfo,
  extractSubtitles,
  smartTranscribe,
  analyzeWithModel,
  analyzeWithoutContent,
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
      const transcribeResult = await smartTranscribe(url, videoInfo.title, videoInfo.description, videoInfo.duration, enableSpeakerDiarization)
      videoContent = transcribeResult
      contentMethod = transcribeResult.method
    }

    let analysisResult
    if (videoContent) {
      const contentText = typeof videoContent === 'object' ? videoContent.text : videoContent
      analysisResult = await analyzeWithModel(videoInfo.title, contentText, url, model)
    } else {
      analysisResult = await analyzeWithoutContent(videoInfo.title, videoInfo.description, url, model)
    }

    const resultData = {
      summary: analysisResult.summary,
      keyPoints: analysisResult.keyPoints,
      title: videoInfo.title,
      thumbnail: videoInfo.thumbnail,
      duration: formatDuration(videoInfo.duration),
      topics: analysisResult.topics,
      details: analysisResult.details || {},
      deepAnalysis: analysisResult.deepAnalysis || null,
      quotes: analysisResult.quotes || [],
      modelUsed: model,
      contentMethod: contentMethod,
      language: language,
      dialogues: videoContent?.utterances || [],
      videoType: videoContent?.videoType || 'unknown'
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