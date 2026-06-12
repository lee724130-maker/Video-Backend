// queue.js
const Queue = require('bull')
const { createBullBoard } = require('@bull-board/api')
const { BullAdapter } = require('@bull-board/api/bullAdapter')
const { ExpressAdapter } = require('@bull-board/express')

// Redis 配置（如果没有 Redis，可以用内存队列，但不推荐生产环境）
const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || ''
}

// 创建视频解析队列
const videoQueue = new Queue('video-parser', {
  redis: REDIS_CONFIG,
  defaultJobOptions: {
    attempts: 2,           // 失败重试次数
    backoff: 5000,         // 重试间隔 5 秒
    timeout: 600000,       // 单个任务超时 10 分钟
    removeOnComplete: 100, // 保留最近 100 个成功记录
    removeOnFail: 200      // 保留最近 200 个失败记录
  }
})

// 队列事件监听
videoQueue.on('completed', (job, result) => {
  console.log(`✅ 任务 ${job.id} 完成`)
})

videoQueue.on('failed', (job, err) => {
  console.error(`❌ 任务 ${job.id} 失败:`, err.message)
})

videoQueue.on('stalled', (job) => {
  console.warn(`⚠️ 任务 ${job.id} 停滞，将重新处理`)
})

// Bull Board 可视化面板
const serverAdapter = new ExpressAdapter()
serverAdapter.setBasePath('/admin/queue')

createBullBoard({
  queues: [new BullAdapter(videoQueue)],
  serverAdapter: serverAdapter
})

module.exports = { videoQueue, serverAdapter }