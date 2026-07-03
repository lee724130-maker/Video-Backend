// start-worker.js
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })
const { videoQueue } = require('./queue')
require('./worker')  // 启动 worker

console.log('🚀 Worker 进程已启动')
console.log(`📊 队列名称: ${videoQueue.name}`)

// 优雅关闭
process.on('SIGTERM', async () => {
  console.log('收到 SIGTERM 信号，正在关闭 Worker...')
  await videoQueue.close()
  try { const { closeBrowser } = require('./xiaohongshu_playwright'); await closeBrowser() } catch {}
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('收到 SIGINT 信号，正在关闭 Worker...')
  await videoQueue.close()
  try { const { closeBrowser } = require('./xiaohongshu_playwright'); await closeBrowser() } catch {}
  process.exit(0)
})
