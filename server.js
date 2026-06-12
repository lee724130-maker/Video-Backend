const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const compression = require('compression')
const morgan = require('morgan')
const dotenv = require('dotenv')
const mysql = require('mysql2/promise')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const nodemailer = require('nodemailer')
const multer = require('multer')
const path = require('path')
dotenv.config({ path: path.join(__dirname, '.env') })
const fs = require('fs')
const { exec } = require('child_process')
const util = require('util')
const { videoQueue, serverAdapter } = require('./queue')
const {
  getBeijingTime,
  getVideoInfo,
  extractSubtitles,
  extractAudio,
  smartTranscribe,
  analyzeWithModel,
  analyzeWithoutContent,
  formatDuration,
  cleanupTempFile
} = require('./videoProcessor')

const execPromise = util.promisify(exec)
const payment = require('./payment')

const app = express()
const PORT = process.env.PORT || 3001

// JWT 密钥
const JWT_SECRET = process.env.JWT_SECRET || 'Extract-secret-key-2024'
const JWT_EXPIRES_IN = '7d'

// ========== 多模型 API 配置 ==========
const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY

// yt-dlp 路径
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp'

// 抖音 Cookies 文件路径
const DOUYIN_COOKIES_FILE = path.join(__dirname, 'douyin_cookies.txt')

// VIP 配置
const VIP_CONFIG = {
  basic: { name: 'VIP 会员', price: 12.9, credits: 500, duration: 30 }
}

const VIP_LEVEL_RANK = {
  none: 0,
  basic: 1,
  pro: 2,
  enterprise: 3
}

// ========== 抖音链接检测函数 ==========
function isDouyinUrl(url) {
  if (!url) return false;
  const urlStr = String(url).toLowerCase();
  return urlStr.includes('douyin.com') || urlStr.includes('v.douyin.com');
}

// ========== 头像上传配置 ==========
const uploadDir = path.join(__dirname, 'uploads/avatars')
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const tempDir = path.join(__dirname, 'temp')
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    const filename = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`
    cb(null, filename)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase())
    const mimetype = allowedTypes.test(file.mimetype)
    if (extname && mimetype) {
      return cb(null, true)
    }
    cb(new Error('只支持图片格式'))
  }
})

// ========== 验证码存储 ==========
const verificationCodes = new Map()

const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString()

const getSyncCodeKey = (type, userId, account) => `sync_${type}_${userId}_${account}`

setInterval(() => {
  const now = Date.now()
  for (const [email, data] of verificationCodes.entries()) {
    if (data.expiresAt < now) {
      verificationCodes.delete(email)
    }
  }
}, 30 * 60 * 1000)

// ========== 邮箱配置 ==========
let transporter = null

const initEmailTransporter = () => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('⚠️ 未配置邮箱，验证码将打印到控制台（开发模式）')
    return null
  }
  
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.qq.com',
    port: parseInt(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE !== 'false',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  })
  
  console.log('✅ 邮箱服务已配置')
  return transporter
}

const sendVerificationEmail = async (email, code, type = 'register') => {
  let title = '验证码'
  let description = '您正在操作邮箱验证'
  
  if (type === 'reset') {
    title = '重置密码'
    description = '您正在操作密码重置'
  } else if (type === 'email_change') {
    title = '修改邮箱'
    description = '您正在操作邮箱修改'
  }
  
  if (!transporter) {
    console.log(`📧 [开发模式] ${title}验证码 ${code} 已发送到 ${email}`)
    return { success: true, message: '验证码已生成（开发模式）' }
  }
  
  try {
    await transporter.sendMail({
      from: `"Extract" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Extract ${title}验证码`,
      html: `<!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body>
          <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 24px;">
            <div style="background: linear-gradient(135deg, #5f7cff 0%, #8b5eff 100%); padding: 32px 24px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0;">Extract</h1>
            </div>
            <div style="padding: 32px 28px;">
              <h2>${description}</h2>
              <div style="background: #f0f2ff; border-radius: 20px; padding: 28px; text-align: center;">
                <div style="font-size: 42px; font-weight: 700; letter-spacing: 8px; color: #5f7cff;">${code}</div>
                <p>验证码有效期为 10 分钟</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `
    })
    return { success: true, message: '验证码已发送' }
  } catch (error) {
    console.error('发送邮件失败:', error)
    return { success: false, message: '邮件发送失败，请检查邮箱配置' }
  }
}

// ========== 数据库连接池 ==========
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'videoseek_admin',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z',
  dateStrings: true
})

const DB_NAME = process.env.DB_NAME || 'videoseek_admin'

// ========== 中间件 ==========
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}))
app.use(compression())
app.use(cors({
  origin: true,
  credentials: true
}))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(morgan('dev'))

// 静态文件服务
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// 通知辅助函数
async function addNotification(pool, userId, title, content, type = 'info', link = null) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, title, content, type, link, created_at) VALUES (?, ?, ?, ?, ?, NOW())`,
      [userId, title, content, type, link]
    )
  } catch (e) {
    console.error('添加通知失败:', e.message)
  }
}

// Bull Board 可视化面板
app.use('/admin/queue', serverAdapter.getRouter())

// ========== 辅助函数 ==========
const authenticateAppUser = async (req, res, next) => {
  const authHeader = req.headers.authorization
  if (!authHeader) {
    return res.status(401).json({ code: 401, message: '未提供认证令牌' })
  }
  
  const token = authHeader.split(' ')[1]
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    if (decoded.type !== 'app_user') {
      return res.status(403).json({ code: 403, message: '无效的认证令牌' })
    }
    req.userId = decoded.id
    
    const [users] = await pool.query('SELECT status FROM app_users WHERE id = ? AND deleted_at IS NULL', [decoded.id])
    if (users.length === 0) {
      return res.status(401).json({ code: 401, message: '用户不存在' })
    }
    if (users[0].status === 'banned') {
      return res.status(403).json({ code: 403, message: '账号已被封禁' })
    }
    
    next()
  } catch (error) {
    return res.status(401).json({ code: 401, message: '认证令牌无效或已过期' })
  }
}

const authenticateAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization
  if (!authHeader) {
    return res.status(401).json({ code: 401, message: '未提供认证令牌' })
  }
  
  const token = authHeader.split(' ')[1]
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    if (decoded.type !== 'admin') {
      return res.status(403).json({ code: 403, message: '权限不足' })
    }
    req.adminId = decoded.id
    next()
  } catch (error) {
    return res.status(401).json({ code: 401, message: '认证令牌无效或已过期' })
  }
}

// ========== 根路径 ==========
app.get('/', (req, res) => {
  res.json({
    name: 'Extract API',
    version: '2.0.0',
    status: 'running',
    timestamp: new Date().toISOString()
  })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ========== 管理员任务管理 API ==========
app.get('/api/admin/tasks', authenticateAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const size = parseInt(req.query.size) || 10
  const offset = (page - 1) * size
  const keyword = req.query.keyword || ''
  const sort = req.query.sort || 'created_at'
  const order = req.query.order || 'desc'
  
  try {
    let query = `
      SELECT vt.*, au.username, au.avatar
      FROM video_tasks vt
      LEFT JOIN app_users au ON vt.user_id = au.id
      WHERE vt.deleted_at IS NULL
    `
    let countQuery = `
      SELECT COUNT(*) as total
      FROM video_tasks vt
      LEFT JOIN app_users au ON vt.user_id = au.id
      WHERE vt.deleted_at IS NULL
    `
    const params = []
    
    if (keyword) {
      query += ` AND (au.username LIKE ? OR vt.video_title LIKE ? OR vt.source_url LIKE ?)`
      countQuery += ` AND (au.username LIKE ? OR vt.video_title LIKE ? OR vt.source_url LIKE ?)`
      const likeParam = `%${keyword}%`
      params.push(likeParam, likeParam, likeParam)
    }
    
    query += ` ORDER BY vt.${sort} ${order} LIMIT ? OFFSET ?`
    params.push(size, offset)
    
    const [tasks] = await pool.query(query, params)
    const [countResult] = await pool.query(countQuery, keyword ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`] : [])
    
    res.json({ code: 0, data: { list: tasks, total: countResult[0].total, page, size } })
  } catch (error) {
    console.error('获取任务列表失败:', error)
    res.status(500).json({ code: 500, message: '获取任务列表失败' })
  }
})

app.delete('/api/admin/tasks/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE video_tasks SET deleted_at = NOW() WHERE id = ?', [req.params.id])
    res.json({ code: 0, message: '删除成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: '删除失败' })
  }
})

app.delete('/api/admin/tasks/all', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE video_tasks SET deleted_at = NOW() WHERE deleted_at IS NULL')
    res.json({ code: 0, message: '清空成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: '清空失败' })
  }
})

// ========== 队列统计 API ==========
app.get('/api/admin/queue/stats', authenticateAdmin, async (req, res) => {
  try {
    const [waiting, active, completed, failed] = await Promise.all([
      videoQueue.getWaitingCount(),
      videoQueue.getActiveCount(),
      videoQueue.getCompletedCount(),
      videoQueue.getFailedCount()
    ])
    res.json({ code: 0, data: { waiting, active, completed, failed, total: waiting + active + completed + failed } })
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取队列统计失败' })
  }
})

// ========== 普通用户 API ==========
app.post('/api/app/send-code', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ code: 400, message: '请提供邮箱地址' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ code: 400, message: '邮箱格式不正确' })
  
  try {
    const [existing] = await pool.query('SELECT id FROM app_users WHERE email = ? AND deleted_at IS NULL', [email])
    if (existing.length > 0) return res.status(400).json({ code: 400, message: '该邮箱已注册' })
    
    const existingCode = verificationCodes.get(`register_${email}`)
    if (existingCode && (Date.now() - existingCode.createdAt) < 60000) {
      const remainingSeconds = Math.ceil((60000 - (Date.now() - existingCode.createdAt)) / 1000)
      return res.status(429).json({ code: 429, message: `请 ${remainingSeconds} 秒后再试` })
    }
    
    const code = generateCode()
    verificationCodes.set(`register_${email}`, { code, expiresAt: Date.now() + 10 * 60 * 1000, createdAt: Date.now() })
    const result = await sendVerificationEmail(email, code, 'register')
    res.json(result.success ? { code: 0, message: result.message } : { code: 500, message: result.message })
  } catch (error) {
    res.status(500).json({ code: 500, message: '验证码发送失败' })
  }
})

app.post('/api/app/send-code-for-email', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ code: 400, message: '请提供邮箱地址' })
  
  try {
    const existingCode = verificationCodes.get(`email_${email}`)
    if (existingCode && (Date.now() - existingCode.createdAt) < 60000) {
      const remainingSeconds = Math.ceil((60000 - (Date.now() - existingCode.createdAt)) / 1000)
      return res.status(429).json({ code: 429, message: `请 ${remainingSeconds} 秒后再试` })
    }
    
    const code = generateCode()
    verificationCodes.set(`email_${email}`, { code, expiresAt: Date.now() + 10 * 60 * 1000, createdAt: Date.now() })
    const result = await sendVerificationEmail(email, code, 'email_change')
    res.json(result.success ? { code: 0, message: result.message } : { code: 500, message: result.message })
  } catch (error) {
    res.status(500).json({ code: 500, message: '验证码发送失败' })
  }
})

app.post('/api/app/send-reset-code', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ code: 400, message: '请提供邮箱地址' })
  
  try {
    const [users] = await pool.query('SELECT id FROM app_users WHERE email = ? AND deleted_at IS NULL', [email])
    if (users.length === 0) return res.status(404).json({ code: 404, message: '该邮箱未注册' })
    
    const existingCode = verificationCodes.get(`reset_${email}`)
    if (existingCode && (Date.now() - existingCode.createdAt) < 60000) {
      const remainingSeconds = Math.ceil((60000 - (Date.now() - existingCode.createdAt)) / 1000)
      return res.status(429).json({ code: 429, message: `请 ${remainingSeconds} 秒后再试` })
    }
    
    const code = generateCode()
    verificationCodes.set(`reset_${email}`, { code, expiresAt: Date.now() + 10 * 60 * 1000, createdAt: Date.now() })
    const result = await sendVerificationEmail(email, code, 'reset')
    res.json(result.success ? { code: 0, message: result.message } : { code: 500, message: result.message })
  } catch (error) {
    res.status(500).json({ code: 500, message: '验证码发送失败' })
  }
})

app.post('/api/app/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body
  if (!email || !code || !newPassword) return res.status(400).json({ code: 400, message: '请填写完整信息' })
  if (newPassword.length < 6) return res.status(400).json({ code: 400, message: '密码长度至少为6位' })
  
  try {
    const storedCode = verificationCodes.get(`reset_${email}`)
    if (!storedCode) return res.status(400).json({ code: 400, message: '请先获取验证码' })
    if (storedCode.code !== code) return res.status(400).json({ code: 400, message: '验证码错误' })
    if (storedCode.expiresAt < Date.now()) {
      verificationCodes.delete(`reset_${email}`)
      return res.status(400).json({ code: 400, message: '验证码已过期' })
    }
    
    const [users] = await pool.query('SELECT id FROM app_users WHERE email = ? AND deleted_at IS NULL', [email])
    if (users.length === 0) return res.status(404).json({ code: 404, message: '用户不存在' })
    
    const hashedPassword = await bcrypt.hash(newPassword, 10)
    await pool.query('UPDATE app_users SET password = ?, updated_at = NOW() WHERE email = ?', [hashedPassword, email])
    verificationCodes.delete(`reset_${email}`)
    res.json({ code: 0, message: '密码重置成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: '重置密码失败' })
  }
})

app.post('/api/app/register', async (req, res) => {
  const { username, email, password, code } = req.body
  if (!username || !email || !password || !code) return res.status(400).json({ code: 400, message: '请填写完整信息' })
  if (password.length < 6) return res.status(400).json({ code: 400, message: '密码长度至少为6位' })
  if (username.length < 2) return res.status(400).json({ code: 400, message: '用户名至少2个字符' })
  
  const storedCode = verificationCodes.get(`register_${email}`)
  if (!storedCode) return res.status(400).json({ code: 400, message: '请先获取验证码' })
  if (storedCode.code !== code) return res.status(400).json({ code: 400, message: '验证码错误' })
  if (storedCode.expiresAt < Date.now()) {
    verificationCodes.delete(`register_${email}`)
    return res.status(400).json({ code: 400, message: '验证码已过期' })
  }
  
  try {
    const [existingUsername] = await pool.query('SELECT id FROM app_users WHERE LOWER(username) = LOWER(?) AND deleted_at IS NULL', [username])
    if (existingUsername.length > 0) return res.status(400).json({ code: 400, message: '用户名已被使用' })
    
    const [existingEmail] = await pool.query('SELECT id FROM app_users WHERE email = ? AND deleted_at IS NULL', [email])
    if (existingEmail.length > 0) return res.status(400).json({ code: 400, message: '邮箱已注册' })
    
    const hashedPassword = await bcrypt.hash(password, 10)
    const userUuid = uuidv4()
    const friendlyId = await generateFriendlyId()
    await pool.query(
      `INSERT INTO app_users (uuid, username, email, password, friendly_id, credits_balance, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'active', NOW(), NOW())`,
      [userUuid, username, email, hashedPassword, friendlyId]
    )
    verificationCodes.delete(`register_${email}`)
    
    const [newUsers] = await pool.query(
      `SELECT id, uuid, username, email, avatar, credits_balance, vip_level, vip_expired_at,
              friendly_id, phone, email_verified, phone_verified
       FROM app_users WHERE email = ?`,
      [email]
    )
    const user = newUsers[0]
    const token = jwt.sign({ id: user.id, email, type: 'app_user' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
    res.json({ code: 0, message: '注册成功', data: { token, user } })
  } catch (error) {
    res.status(500).json({ code: 500, message: '注册失败' })
  }
})

app.post('/api/app/login', async (req, res) => {
  const { account, password } = req.body
  if (!account || !password) return res.status(400).json({ code: 400, message: '请填写账号和密码' })
  
  try {
    const isEmail = account.includes('@')
    const queryField = isEmail ? 'email' : 'username'
    const [users] = await pool.query(
      `SELECT id, uuid, username, email, password, avatar, credits_balance, status,
              vip_level, vip_expired_at, friendly_id, phone, email_verified, phone_verified
       FROM app_users WHERE ${queryField} = ? AND deleted_at IS NULL`,
      [account]
    )
    if (users.length === 0) return res.status(401).json({ code: 401, message: '账号或密码错误' })
    
    const user = users[0]
    if (user.status === 'banned') return res.status(403).json({ code: 403, message: '账号已被封禁' })
    
    const isValid = await bcrypt.compare(password, user.password)
    if (!isValid) return res.status(401).json({ code: 401, message: '账号或密码错误' })
    
    if (!user.friendly_id) {
      user.friendly_id = await assignFriendlyId(user.id)
    }

    await pool.query('UPDATE app_users SET last_login_at = NOW() WHERE id = ?', [user.id])
    const token = jwt.sign({ id: user.id, email: user.email, type: 'app_user' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
    res.json({
      code: 0,
      message: '登录成功',
      data: {
        token,
        user: {
          id: user.id,
          uuid: user.uuid,
          username: user.username,
          email: user.email,
          avatar: user.avatar,
          credits_balance: user.credits_balance,
          vip_level: user.vip_level,
          vip_expired_at: user.vip_expired_at,
          friendly_id: user.friendly_id,
          phone: user.phone,
          email_verified: user.email_verified,
          phone_verified: user.phone_verified
        }
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: '登录失败' })
  }
})

// ========== 获取当前用户信息 ==========
app.get('/api/app/me', authenticateAppUser, async (req, res) => {
  try {
    const [users] = await pool.query(
      `SELECT id, uuid, username, email, avatar, credits_balance, total_tasks, 
              status, vip_level, vip_expired_at, friendly_id, 
              phone, email_verified, phone_verified 
       FROM app_users 
       WHERE id = ? AND deleted_at IS NULL`,
      [req.userId]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: '用户不存在' });
    }

    if (!users[0].friendly_id) {
      users[0].friendly_id = await assignFriendlyId(req.userId);
    }
    
    res.json({ code: 0, data: users[0] });
  } catch (error) {
    console.error('获取用户信息失败:', error);
    res.status(500).json({ code: 500, message: '获取用户信息失败' });
  }
});

app.post('/api/app/avatar', authenticateAppUser, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ code: 400, message: '请选择图片' })
  try {
    const avatarUrl = `/uploads/avatars/${req.file.filename}`
    await pool.query('UPDATE app_users SET avatar = ? WHERE id = ?', [avatarUrl, req.userId])
    const [users] = await pool.query('SELECT id, uuid, username, email, avatar, credits_balance, vip_level, vip_expired_at FROM app_users WHERE id = ?', [req.userId])
    res.json({ code: 0, message: '头像上传成功', data: { avatar: avatarUrl, user: users[0] } })
  } catch (error) {
    res.status(500).json({ code: 500, message: '头像上传失败' })
  }
})

app.put('/api/app/username', authenticateAppUser, async (req, res) => {
  const { username } = req.body
  if (!username || username.length < 2) return res.status(400).json({ code: 400, message: '用户名至少2个字符' })
  try {
    const [existing] = await pool.query('SELECT id FROM app_users WHERE LOWER(username) = LOWER(?) AND id != ?', [username, req.userId])
    if (existing.length > 0) return res.status(400).json({ code: 400, message: '用户名已被使用' })
    await pool.query('UPDATE app_users SET username = ? WHERE id = ?', [username, req.userId])
    const [users] = await pool.query('SELECT id, uuid, username, email, avatar, credits_balance, vip_level, vip_expired_at FROM app_users WHERE id = ?', [req.userId])
    res.json({ code: 0, message: '用户名修改成功', data: { user: users[0] } })
  } catch (error) {
    res.status(500).json({ code: 500, message: '修改用户名失败' })
  }
})

app.put('/api/app/password', authenticateAppUser, async (req, res) => {
  const { oldPassword, newPassword } = req.body
  if (!oldPassword || !newPassword) return res.status(400).json({ code: 400, message: '请填写完整信息' })
  if (newPassword.length < 6) return res.status(400).json({ code: 400, message: '新密码至少6位' })
  
  try {
    const [users] = await pool.query('SELECT password FROM app_users WHERE id = ?', [req.userId])
    const isValid = await bcrypt.compare(oldPassword, users[0].password)
    if (!isValid) return res.status(401).json({ code: 401, message: '当前密码错误' })
    const hashedPassword = await bcrypt.hash(newPassword, 10)
    await pool.query('UPDATE app_users SET password = ? WHERE id = ?', [hashedPassword, req.userId])
    res.json({ code: 0, message: '密码修改成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: '修改密码失败' })
  }
})

app.put('/api/app/email', authenticateAppUser, async (req, res) => {
  const { email, code } = req.body
  if (!email || !code) return res.status(400).json({ code: 400, message: '请填写邮箱和验证码' })
  
  try {
    const storedCode = verificationCodes.get(`email_${email}`)
    if (!storedCode) return res.status(400).json({ code: 400, message: '请先获取验证码' })
    if (storedCode.code !== code) return res.status(400).json({ code: 400, message: '验证码错误' })
    if (storedCode.expiresAt < Date.now()) return res.status(400).json({ code: 400, message: '验证码已过期' })
    
    await pool.query('UPDATE app_users SET email = ? WHERE id = ?', [email, req.userId])
    verificationCodes.delete(`email_${email}`)
    const [users] = await pool.query('SELECT id, uuid, username, email, avatar, credits_balance, vip_level, vip_expired_at FROM app_users WHERE id = ?', [req.userId])
    res.json({ code: 0, message: '邮箱修改成功', data: { user: users[0] } })
  } catch (error) {
    res.status(500).json({ code: 500, message: '修改邮箱失败' })
  }
})

// ========== VIP 会员管理 API ==========
app.get('/api/app/vip/info', authenticateAppUser, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT vip_level, vip_expired_at, credits_balance FROM app_users WHERE id = ?', [req.userId])
    const user = users[0]
    const isVipActive = user.vip_level !== 'none' && (!user.vip_expired_at || new Date(user.vip_expired_at) > new Date())
    let remainingDays = 0
    if (isVipActive && user.vip_expired_at) {
      const expireDate = new Date(user.vip_expired_at)
      remainingDays = Math.ceil((expireDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    }
    res.json({ code: 0, data: { vip_level: user.vip_level, vip_expired_at: user.vip_expired_at, is_vip_active: isVipActive, remaining_days: remainingDays, vip_config: VIP_CONFIG[user.vip_level] || null } })
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取会员信息失败' })
  }
})

app.post('/api/app/vip/upgrade', authenticateAppUser, async (req, res) => {
  const { plan, duration = 30 } = req.body
  if (!plan || !['basic'].includes(plan)) return res.status(400).json({ code: 400, message: '请选择有效的会员套餐' })
  
  try {
    const [users] = await pool.query('SELECT vip_level, vip_expired_at FROM app_users WHERE id = ?', [req.userId])
    const user = users[0]
    let newExpiredAt
    if (user.vip_level !== 'none' && user.vip_expired_at && new Date(user.vip_expired_at) > new Date()) {
      newExpiredAt = new Date(user.vip_expired_at)
      newExpiredAt.setDate(newExpiredAt.getDate() + duration)
    } else {
      newExpiredAt = new Date()
      newExpiredAt.setDate(newExpiredAt.getDate() + duration)
    }
    await pool.query('UPDATE app_users SET vip_level = ?, vip_expired_at = ?, vip_updated_at = NOW() WHERE id = ?', [plan, newExpiredAt.toISOString().slice(0, 19).replace('T', ' '), req.userId])
    const [updatedUsers] = await pool.query('SELECT id, uuid, username, email, avatar, credits_balance, status, vip_level, vip_expired_at FROM app_users WHERE id = ?', [req.userId])
    res.json({ code: 0, message: `成功开通 ${plan} 会员`, data: { user: updatedUsers[0] } })
  } catch (error) {
    res.status(500).json({ code: 500, message: '开通失败' })
  }
})

// ========== 支付接口 ==========

// 获取 VIP 套餐列表
app.get('/api/app/vip/plans', authenticateAppUser, async (req, res) => {
  res.json({ code: 0, data: { plans: payment.getVipPlans(), paymentConfigured: payment.isPaymentConfigured() } })
})

// 创建支付订单
app.post('/api/app/vip/create-order', authenticateAppUser, async (req, res) => {
  const { planId, provider = 'wechat' } = req.body
  if (!planId || !payment.getPlan(planId)) {
    return res.status(400).json({ code: 400, message: '请选择有效套餐' })
  }

  try {
    let result
    if (provider === 'alipay') {
      result = await payment.createAlipayOrder(pool, req.userId, planId)
    } else {
      const clientIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip || '127.0.0.1'
      result = await payment.createWechatOrder(pool, req.userId, planId, clientIp)
    }

    if (result.success) {
      res.json({ code: 0, data: result })
    } else {
      res.status(500).json({ code: 500, message: result.message || '创建订单失败' })
    }
  } catch (error) {
    console.error('创建订单失败:', error)
    res.status(500).json({ code: 500, message: error.message || '创建订单失败' })
  }
})

// 微信支付回调（接受原始XML body）
app.post('/api/app/vip/payment-callback/wechat', (req, res, next) => {
  let rawBody = ''
  req.on('data', chunk => { rawBody += chunk })
  req.on('end', async () => {
    req.body = rawBody
    try {
      const callback = payment.verifyWechatCallback(rawBody)
      if (!callback) return res.send('<xml><return_code><![CDATA[FAIL]]></return_code></xml>')
      await payment.activateVip(pool, callback.orderNo, 'wechat', callback.transactionId, callback.amount)
      res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>')
    } catch (error) {
      console.error('微信支付回调失败:', error)
      res.send('<xml><return_code><![CDATA[FAIL]]></return_code></xml>')
    }
  })
})

// 支付宝支付回调（公网接口）
app.post('/api/app/vip/payment-callback/alipay', async (req, res) => {
  try {
    const callback = payment.verifyAlipayCallback(req.body)
    if (!callback) return res.send('failure')
    await payment.activateVip(pool, callback.orderNo, 'alipay', callback.transactionId, callback.amount)
    res.send('success')
  } catch (error) {
    console.error('支付宝回调处理失败:', error)
    res.send('failure')
  }
})

// 查询订单状态
app.get('/api/app/vip/order-status/:orderNo', authenticateAppUser, async (req, res) => {
  try {
    const [orders] = await pool.query(
      'SELECT order_no, plan_id, amount, provider, status, paid_at FROM payment_orders WHERE order_no = ? AND user_id = ?',
      [req.params.orderNo, req.userId]
    )
    if (orders.length === 0) return res.status(404).json({ code: 404, message: '订单不存在' })
    res.json({ code: 0, data: orders[0] })
  } catch (error) {
    res.status(500).json({ code: 500, message: '查询失败' })
  }
})

// 用户联系客服留言（发送到管理员邮箱）
app.post('/api/app/contact', authenticateAppUser, async (req, res) => {
  const { type, message } = req.body
  if (!message || !message.trim()) {
    return res.status(400).json({ code: 400, message: '请填写留言内容' })
  }
  try {
    const [users] = await pool.query('SELECT username, email FROM app_users WHERE id = ?', [req.userId])
    const user = users[0] || { username: '未知用户', email: '' }

    const typeLabels = {
      vip: 'VIP 问题',
      payment: '支付问题',
      parse: '解析问题',
      account: '账号问题',
      other: '其他',
    }

    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.SMTP_USER,
        subject: `[客服留言] ${typeLabels[type] || '其他'} - 用户: ${user.username}`,
        text: `用户: ${user.username} (${user.email})\n类型: ${typeLabels[type] || type}\n\n留言内容:\n${message}`,
      })
    } else {
      console.log(`[客服留言] 用户: ${user.username}, 类型: ${type}, 内容: ${message}`)
    }
    res.json({ code: 0, message: '留言已发送' })
  } catch (error) {
    console.error('客服留言失败:', error)
    res.status(500).json({ code: 500, message: '发送失败，请稍后重试' })
  }
})

// 用户付款后通知管理员（收款码模式）
app.post('/api/app/payment-notify', authenticateAppUser, async (req, res) => {
  const { planLevel, planName, planPrice, payMethod, type = 'vip' } = req.body
  if (!planLevel || !planName || !planPrice) {
    return res.status(400).json({ code: 400, message: '参数不完整' })
  }
  try {
    const [users] = await pool.query(
      'SELECT id, username, email, friendly_id FROM app_users WHERE id = ?',
      [req.userId]
    )
    const user = users[0]
    if (!user) return res.status(404).json({ code: 404, message: '用户不存在' })

    const orderNo = 'EXTRACT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase()
    const transactionId = 'TXN' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 8).toUpperCase()
    const amount = planPrice || 12.9

    await pool.query(
      `INSERT INTO payment_orders (order_no, user_id, plan_id, amount, provider, status, transaction_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, NOW(), NOW())`,
      [orderNo, req.userId, planLevel, amount, payMethod || 'wechat', transactionId]
    )

    const typeLabel = type === 'credits' ? '积分' : 'VIP'
    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.SMTP_USER,
        subject: `[付款通知] 用户 ${user.username} 已付款，待开通 ${planName}`,
        text: [
          `用户ID: ${user.friendly_id || user.id}`,
          `用户名: ${user.username}`,
          `邮箱: ${user.email}`,
          `订单号: ${orderNo}`,
          `交易号: ${transactionId}`,
          `套餐: ${planName}`,
          `金额: ¥${amount}`,
          `支付方式: ${payMethod === 'alipay' ? '支付宝' : '微信支付'}`,
          ``,
          `请在管理后台确认收款后手动开通该 ${typeLabel}。`,
        ].join('\n'),
      })
    } else {
      console.log(`[付款通知] 用户:${user.username} 订单:${orderNo} 交易号:${transactionId} ${planName} ¥${amount}`)
    }

    res.json({ code: 0, message: `已通知管理员，请耐心等待 ${typeLabel} 开通`, data: { orderNo, transactionId } })
  } catch (error) {
    console.error('付款通知失败:', error)
    res.status(500).json({ code: 500, message: '通知失败，请联系管理员' })
  }
})

// 每日签到（赠送30积分）
app.post('/api/app/checkin', authenticateAppUser, async (req, res) => {
  try {
    const [existing] = await pool.query(
      `SELECT id FROM credit_transactions WHERE user_id = ? AND type = 'checkin' AND DATE(created_at) = CURDATE()`,
      [req.userId]
    )
    if (existing.length > 0) {
      return res.json({ code: 0, message: '今日已签到', data: { alreadyCheckedIn: true } })
    }
    await pool.query(
      'UPDATE app_users SET credits_balance = credits_balance + 30 WHERE id = ?',
      [req.userId]
    )
    await pool.query(
      `INSERT INTO credit_transactions (user_id, amount, type, description, created_at) VALUES (?, 30, 'checkin', '每日签到赠送', NOW())`,
      [req.userId]
    )
    await addNotification(pool, req.userId, '每日签到', '已获得 30 积分，今日可正常使用解析功能', 'success')
    res.json({ code: 0, message: '签到成功，已获得 30 积分', data: { alreadyCheckedIn: false, credits: 30 } })
  } catch (error) {
    console.error('签到失败:', error)
    res.status(500).json({ code: 500, message: '签到失败' })
  }
})

// ========== 通知系统 API ==========
app.get('/api/app/notifications', authenticateAppUser, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, title, content, type, link, readed, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.userId]
    )
    const list = rows.map(r => ({ ...r, read: r.readed === 1 }))
    res.json({ code: 0, data: { list } })
  } catch (error) {
    console.error('获取通知失败:', error)
    res.status(500).json({ code: 500, message: '获取通知失败' })
  }
})

app.get('/api/app/notifications/unread-count', authenticateAppUser, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND readed = 0',
      [req.userId]
    )
    res.json({ code: 0, data: { count: rows[0].count } })
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取未读数失败' })
  }
})

app.put('/api/app/notifications/:id/read', authenticateAppUser, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET readed = 1 WHERE id = ? AND user_id = ?',
      [req.params.id, req.userId]
    )
    res.json({ code: 0, message: '已标记为已读' })
  } catch (error) {
    res.status(500).json({ code: 500, message: '标记失败' })
  }
})

app.post('/api/app/notifications/read-all', authenticateAppUser, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET readed = 1 WHERE user_id = ? AND readed = 0',
      [req.userId]
    )
    res.json({ code: 0, message: '全部已读' })
  } catch (error) {
    res.status(500).json({ code: 500, message: '操作失败' })
  }
})

app.delete('/api/app/notifications', authenticateAppUser, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM notifications WHERE user_id = ?',
      [req.userId]
    )
    res.json({ code: 0, message: '已清空' })
  } catch (error) {
    res.status(500).json({ code: 500, message: '清空失败' })
  }
})

// 管理员手动开通VIP（用于支付未配置时）
app.post('/api/admin/users/:id/vip-manual', authenticateAdmin, async (req, res) => {
  const { planId } = req.body
  if (!planId || !payment.getPlan(planId)) {
    return res.status(400).json({ code: 400, message: '请选择有效套餐' })
  }
  try {
    const result = await payment.adminActivateVip(pool, parseInt(req.params.id), planId)
    res.json({ code: 0, message: `已开通 ${result.plan}`, data: result })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message || '开通失败' })
  }
})

// 管理员：获取 VIP 统计数据
app.get('/api/admin/vip/stats', authenticateAdmin, async (req, res) => {
  try {
    const [vipStats] = await pool.query(`
      SELECT 
        vip_level,
        COUNT(*) as count,
        SUM(CASE WHEN vip_expired_at > NOW() THEN 1 ELSE 0 END) as active_count
      FROM app_users 
      WHERE deleted_at IS NULL AND vip_level != 'none'
      GROUP BY vip_level
    `)
    
    const [totalUsers] = await pool.query('SELECT COUNT(*) as total FROM app_users WHERE deleted_at IS NULL')
    const [activeVipCount] = await pool.query(
      "SELECT COUNT(*) as total FROM app_users WHERE deleted_at IS NULL AND vip_level != 'none' AND vip_expired_at > NOW()"
    )
    
    res.json({
      code: 0,
      data: {
        total_users: totalUsers[0].total,
        active_vip_count: activeVipCount[0].total,
        vip_distribution: vipStats
      }
    })
  } catch (error) {
    console.error('获取 VIP 统计失败:', error)
    res.status(500).json({ code: 500, message: '获取统计失败' })
  }
})

// ========== 核心：视频解析 API（队列模式）==========
app.post('/api/app/parse', authenticateAppUser, async (req, res) => {
  const { url, model = 'recommended', language = 'auto' } = req.body
  
  if (!url) {
    return res.status(400).json({ code: 400, message: '请提供视频链接' })
  }

  // ========== 抖音链接拦截 - 返回维护提示 ==========
  if (isDouyinUrl(url)) {
    console.log(`🚫 拦截抖音链接: ${url}`)
    return res.status(400).json({
      code: 400,
      message: '抖音视频解析正在维护中，请使用 B站、YouTube 等其他平台链接',
      data: null
    })
  }
  // ========== 拦截结束 ==========

  try {
    // 1. 检查用户信息和积分
    const [users] = await pool.query(
      'SELECT credits_balance, vip_level, vip_expired_at FROM app_users WHERE id = ? AND deleted_at IS NULL',
      [req.userId]
    )
    
    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: '用户不存在' })
    }
    
    const user = users[0]
    const isVip = user.vip_level !== 'none' && 
      (!user.vip_expired_at || new Date(user.vip_expired_at) > new Date())
    
    // 2. 根据模型确定消耗积分（最快10，推荐20）
    const creditCost = model === 'fastest' ? 10 : 20
    
    if (user.credits_balance < creditCost) {
      return res.status(400).json({ code: 400, message: `积分不足，当前模型需要 ${creditCost} 积分` })
    }

    // 2. 获取视频基本信息
    let videoInfo
    try {
      videoInfo = await getVideoInfo(url)
    } catch (infoError) {
      console.error('获取视频信息失败:', infoError)
      return res.status(400).json({ code: 400, message: infoError.message || '无法获取视频信息，请检查链接是否有效' })
    }

    // 3. 创建任务记录
    const taskUuid = uuidv4()
    const platform = url.includes('youtube') ? 'youtube' : 
                     url.includes('bilibili') ? 'bilibili' : 
                     url.includes('douyin') ? 'douyin' : 
                     url.includes('tiktok') ? 'tiktok' : 
                     url.includes('xiaohongshu') ? 'xiaohongshu' : 'other'
    
    const formattedNow = getBeijingTime()
    
    const [result] = await pool.query(
      `INSERT INTO video_tasks 
       (uuid, user_id, task_type, source_url, source_platform, status, credits_used, video_title, video_duration, created_at, updated_at) 
       VALUES (?, ?, 'summary', ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [taskUuid, req.userId, url, platform, creditCost, videoInfo.title, videoInfo.duration || 0, formattedNow, formattedNow]
    )
    
    const taskId = result.insertId

    // 4. 扣减积分（所有用户都扣）
    await pool.query(
      'UPDATE app_users SET credits_balance = credits_balance - ?, total_tasks = total_tasks + 1 WHERE id = ?',
      [creditCost, req.userId]
    )
    await pool.query(
      `INSERT INTO credit_transactions (user_id, amount, type, description, created_at) 
       VALUES (?, ?, 'consume', ?, NOW())`,
      [req.userId, -creditCost, model === 'fastest' ? '最快模型解析' : '推荐模型解析']
    )

    // 5. 将任务加入队列
    await videoQueue.add('parse-video', {
      taskId,
      userId: req.userId,
      url,
      model,
      language,
      enableSpeakerDiarization: false,
      videoInfo
    }, {
      jobId: `task_${taskId}`,
      priority: isVip ? 1 : 2,
      timeout: 600000  // 10 分钟超时
    })

    console.log(`📋 任务 ${taskId} 已加入队列`)

    res.json({
      code: 0,
      message: '任务已加入解析队列',
      data: {
        task_id: taskId,
        task_uuid: taskUuid,
        status: 'pending',
        queue_position: await videoQueue.getWaitingCount()
      }
    })

  } catch (error) {
    console.error('创建任务失败:', error)
    res.status(500).json({ code: 500, message: error.message || '创建任务失败' })
  }
})

// 查询任务状态
app.get('/api/app/task/status/:taskId', authenticateAppUser, async (req, res) => {
  const taskId = req.params.taskId
  
  try {
    const [tasks] = await pool.query(
      `SELECT id, uuid, status, result_data, error_message, processing_time, created_at, updated_at 
       FROM video_tasks WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      [taskId, req.userId]
    )
    
    if (tasks.length === 0) {
      return res.status(404).json({ code: 404, message: '任务不存在' })
    }
    
    const task = tasks[0]
    
    let queuePosition = null
    if (task.status === 'pending') {
      const waitingJobs = await videoQueue.getWaiting()
      const index = waitingJobs.findIndex(job => job.id === `task_${taskId}`)
      queuePosition = index !== -1 ? index + 1 : null
    }
    
    res.json({
      code: 0,
      data: {
        ...task,
        queue_position: queuePosition,
        result: task.result_data ? JSON.parse(task.result_data) : null
      }
    })
  } catch (error) {
    console.error('获取任务状态失败:', error)
    res.status(500).json({ code: 500, message: '获取任务状态失败' })
  }
})

// 获取任务详情
app.get('/api/app/task/:id', authenticateAppUser, async (req, res) => {
  const taskId = req.params.id
  
  try {
    const [tasks] = await pool.query(
      `SELECT id, uuid, task_type, source_url, source_platform, video_title, video_duration, status, result_data, error_message, credits_used, processing_time, created_at, updated_at 
       FROM video_tasks WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      [taskId, req.userId]
    )
    
    if (tasks.length === 0) {
      return res.status(404).json({ code: 404, message: '任务不存在' })
    }
    
    const task = tasks[0]
    if (task.result_data) {
      task.result_data = JSON.parse(task.result_data)
    }
    
    res.json({ code: 0, data: task })
  } catch (error) {
    console.error('获取任务失败:', error)
    res.status(500).json({ code: 500, message: '获取任务失败' })
  }
})

// 获取用户任务列表
app.get('/api/app/tasks', authenticateAppUser, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const size = parseInt(req.query.size) || 10
  const offset = (page - 1) * size
  
  try {
    const [tasks] = await pool.query(
      `SELECT id, uuid, task_type, source_url, source_platform, video_title, video_duration, status, credits_used, processing_time, created_at, updated_at 
       FROM video_tasks 
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [req.userId, size, offset]
    )
    
    const [countResult] = await pool.query(
      'SELECT COUNT(*) as total FROM video_tasks WHERE user_id = ? AND deleted_at IS NULL',
      [req.userId]
    )
    
    res.json({
      code: 0,
      data: {
        list: tasks,
        total: countResult[0].total,
        page,
        size
      }
    })
  } catch (error) {
    console.error('获取任务列表失败:', error)
    res.status(500).json({ code: 500, message: '获取任务列表失败' })
  }
})

// 删除任务
app.delete('/api/app/tasks/:id', authenticateAppUser, async (req, res) => {
  const taskId = req.params.id
  
  try {
    const [tasks] = await pool.query(
      'SELECT id FROM video_tasks WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [taskId, req.userId]
    )
    
    if (tasks.length === 0) {
      return res.status(404).json({ code: 404, message: '任务不存在' })
    }
    
    await pool.query(
      'UPDATE video_tasks SET deleted_at = NOW() WHERE id = ?',
      [taskId]
    )
    
    res.json({ code: 0, message: '删除成功' })
  } catch (error) {
    console.error('删除任务失败:', error)
    res.status(500).json({ code: 500, message: '删除失败' })
  }
})

app.delete('/api/app/tasks', authenticateAppUser, async (req, res) => {
  try {
    await pool.query(
      'UPDATE video_tasks SET deleted_at = NOW() WHERE user_id = ? AND deleted_at IS NULL',
      [req.userId]
    )
    
    res.json({ code: 0, message: '清空成功' })
  } catch (error) {
    console.error('清空任务失败:', error)
    res.status(500).json({ code: 500, message: '清空失败' })
  }
})

// 思维导图生成
function normalizeMindmapPoints(resultData, title) {
  const points = Array.isArray(resultData?.keyPoints) ? resultData.keyPoints.filter(Boolean) : []
  if (points.length > 0) return points

  if (resultData?.details) {
    const detailPoints = [
      resultData.details.mainArgument,
      resultData.details.uniqueInsight,
      resultData.details.actionAdvice
    ].filter(Boolean)
    if (detailPoints.length > 0) return detailPoints
  }

  if (resultData?.deepAnalysis) {
    const analysisPoints = [
      resultData.deepAnalysis.structure,
      resultData.deepAnalysis.argumentQuality,
      resultData.deepAnalysis.uniqueValue,
      resultData.deepAnalysis.limitations
    ].filter(Boolean)
    if (analysisPoints.length > 0) return analysisPoints
  }

  const summary = String(resultData?.summary || '')
  const sentences = summary
    .split(/(?<=[。！？!?；;])\s*/)
    .map(item => item.trim())
    .filter(item => item.length > 10)

  return sentences.length > 0
    ? sentences.slice(0, 6)
    : [`围绕《${title || '视频'}》的核心主题`, '主要内容与观点', '观看价值与启发']
}

function buildFallbackMindmap(title, points, summary = '') {
  const safeTitle = title || '视频要点'
  const children = points.slice(0, 6).map((point, index) => {
    const cleanPoint = String(point).replace(/^\s*\d+[\.\)、)]\s*/, '').trim()
    const [head, ...rest] = cleanPoint.split(/[：:，,。]/)
    const subText = rest.join('，').trim() || cleanPoint
    const subNodes = subText
      .split(/[；;。]/)
      .map(item => item.trim())
      .filter(item => item.length > 6)
      .slice(0, 3)

    return {
      name: head?.slice(0, 24) || `要点${index + 1}`,
      children: (subNodes.length > 0 ? subNodes : [cleanPoint]).map(item => ({
        name: item.slice(0, 36)
      }))
    }
  })

  if (children.length === 0 && summary) {
    children.push({ name: '智能摘要', children: [{ name: summary.slice(0, 36) }] })
  }

  return { root: safeTitle, children }
}

async function generateMindmap(title, keyPoints, summary) {
  const apiKey = BAILIAN_API_KEY
  const baseUrl = process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const model = process.env.BAILIAN_MODEL_PRO || 'tongyi-xiaomi-analysis-pro'
  if (!apiKey) return null

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: 'system',
          content: '只返回纯 JSON，不要 Markdown。格式：{"root":"标题","children":[{"name":"主题","children":[{"name":"子主题"}]}]}。children 至少 4 个主题，每个主题至少 1 个子主题。'
        },
        {
          role: 'user',
          content: `标题：${title}\n摘要：${summary || '无'}\n关键要点：\n${keyPoints.join('\n')}`
        }
      ],
      temperature: 0.5,
      max_tokens: 2000,
      response_format: { type: 'json_object' }
    })
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`思维导图 API 请求失败: ${response.status}${errorText ? ` ${errorText.substring(0, 120)}` : ''}`)
  }

  const data = await response.json()
  let content = data?.choices?.[0]?.message?.content || ''
  content = content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(content)
  if (!parsed.root || !Array.isArray(parsed.children)) {
    throw new Error('思维导图数据结构不完整')
  }
  return parsed
}

app.post('/api/app/mindmap/:taskId', authenticateAppUser, async (req, res) => {
  const taskId = req.params.taskId
  
  try {
    const [tasks] = await pool.query(
      `SELECT result_data, video_title FROM video_tasks 
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      [taskId, req.userId]
    )
    
    if (tasks.length === 0) {
      return res.status(404).json({ code: 404, message: '任务不存在' })
    }
    
    const task = tasks[0]
    let resultData
    try {
      resultData = typeof task.result_data === 'string' 
        ? JSON.parse(task.result_data) 
        : task.result_data
    } catch (e) {
      resultData = task.result_data
    }
    
    const title = task.video_title || resultData?.title || '视频'
    const summary = resultData?.summary || ''

    const keyPoints = normalizeMindmapPoints(resultData, title)

    let mindmap = null
    try {
      mindmap = await generateMindmap(title, keyPoints, summary)
    } catch (e) {
      console.error('DeepSeek 思维导图生成失败，使用本地构建:', e.message)
    }

    if (!mindmap) {
      mindmap = buildFallbackMindmap(title, keyPoints, summary)
      console.log('使用本地构建的思维导图')
    }

    resultData.mindmap = mindmap
    await pool.query(
      `UPDATE video_tasks SET result_data = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(resultData), taskId]
    )

    res.json({
      code: 0,
      message: '思维导图生成成功',
      data: { mindmap }
    })

  } catch (error) {
    console.error('生成思维导图失败:', error)
    res.status(500).json({ code: 500, message: error.message || '生成失败' })
  }
})

// ========== 管理员 API ==========
app.post('/api/admin/auth/login', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ code: 400, message: '请填写用户名和密码' })
  
  try {
    const [users] = await pool.query('SELECT id, username, email, password, role FROM users WHERE username = ? AND deleted_at IS NULL', [username])
    if (users.length === 0) return res.status(401).json({ code: 401, message: '用户名或密码错误' })
    
    const user = users[0]
    const isValid = await bcrypt.compare(password, user.password)
    if (!isValid) return res.status(401).json({ code: 401, message: '用户名或密码错误' })
    
    const token = jwt.sign({ id: user.id, username, role: user.role, type: 'admin' }, JWT_SECRET, { expiresIn: '12h' })
    res.json({ code: 0, message: '登录成功', data: { token, user: { id: user.id, username: user.username, email: user.email, role: user.role } } })
  } catch (error) {
    res.status(500).json({ code: 500, message: '登录失败' })
  }
})

app.get('/api/admin/auth/me', authenticateAdmin, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT id, username, email, role FROM users WHERE id = ? AND deleted_at IS NULL', [req.adminId])
    res.json({ code: 0, data: users[0] })
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取用户信息失败' })
  }
})

app.get('/api/admin/dashboard/stats', authenticateAdmin, async (req, res) => {
  try {
    const [userCount] = await pool.query('SELECT COUNT(*) as total FROM app_users WHERE deleted_at IS NULL')
    const [taskCount] = await pool.query('SELECT COUNT(*) as total FROM video_tasks WHERE deleted_at IS NULL')
    const [todayTasks] = await pool.query("SELECT COUNT(*) as total FROM video_tasks WHERE DATE(created_at) = CURDATE() AND deleted_at IS NULL")
    const [pendingTasks] = await pool.query("SELECT COUNT(*) as total FROM video_tasks WHERE status = 'pending' AND deleted_at IS NULL")
    const [creditSum] = await pool.query('SELECT SUM(credits_used) as total FROM video_tasks WHERE deleted_at IS NULL')
    res.json({ code: 0, data: { total_users: userCount[0].total, total_tasks: taskCount[0].total, today_tasks: todayTasks[0].total, pending_tasks: pendingTasks[0].total, total_credits_used: creditSum[0].total || 0 } })
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取统计数据失败' })
  }
})

app.get('/api/admin/dashboard/task-trend', authenticateAdmin, async (req, res) => {
  const { period = 'week' } = req.query
  try {
    let sql
    if (period === 'week') {
      sql = `SELECT DATE(created_at) as date, COUNT(*) as count FROM video_tasks WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND deleted_at IS NULL GROUP BY DATE(created_at) ORDER BY date`
    } else {
      sql = `SELECT DATE_FORMAT(created_at, '%Y-%m') as date, COUNT(*) as count FROM video_tasks WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND deleted_at IS NULL GROUP BY DATE_FORMAT(created_at, '%Y-%m') ORDER BY date`
    }
    const [rows] = await pool.query(sql)
    const dates = rows.map(r => r.date)
    const values = rows.map(r => r.count)
    res.json({ code: 0, data: { dates, values } })
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取任务趋势失败' })
  }
})

app.get('/api/admin/dashboard/task-distribution', authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT COALESCE(source_platform, 'other') as name, COUNT(*) as value FROM video_tasks WHERE deleted_at IS NULL GROUP BY COALESCE(source_platform, 'other')`)
    res.json({ code: 0, data: rows })
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取任务分布失败' })
  }
})

app.get('/api/admin/dashboard/recent-tasks', authenticateAdmin, async (req, res) => {
  const limit = parseInt(req.query.limit) || 10
  try {
    const [rows] = await pool.query(`
      SELECT vt.id, vt.uuid, vt.user_id, vt.task_type, vt.source_url, vt.source_platform, vt.video_title, vt.video_duration, vt.status, vt.credits_used, vt.created_at, vt.updated_at, au.username
      FROM video_tasks vt LEFT JOIN app_users au ON vt.user_id = au.id
      WHERE vt.deleted_at IS NULL ORDER BY vt.created_at DESC LIMIT ?
    `, [limit])
    res.json({ code: 0, data: rows })
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取最近任务失败' })
  }
})

// ========== 页面浏览量统计 ==========
app.post('/api/app/track-visit', async (req, res) => {
  try {
    const { visitor_id, page_url, referrer } = req.body
    const userId = req.user?.id || null
    const ip = req.ip || req.connection?.remoteAddress || null
    const ua = req.headers['user-agent'] || null
    await pool.query(
      'INSERT INTO page_visits (user_id, visitor_id, ip_address, page_url, referrer, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, visitor_id || null, ip, page_url || '/', referrer || null, ua]
    )
    res.json({ code: 0 })
  } catch (error) {
    res.json({ code: 0 })
  }
})

app.get('/api/admin/stats/pageviews', authenticateAdmin, async (req, res) => {
  try {
    const period = req.query.period || 'today'
    let dateFilter, groupBy
    if (period === 'today') {
      dateFilter = "DATE(visited_at) = CURDATE()"
      groupBy = "HOUR(visited_at)"
    } else if (period === '7days') {
      dateFilter = "visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)"
      groupBy = "DATE(visited_at)"
    } else {
      dateFilter = "visited_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)"
      groupBy = "DATE(visited_at)"
    }

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM page_visits WHERE ${dateFilter}`)
    const [[{ unique }]] = await pool.query(
      `SELECT COUNT(DISTINCT IF(user_id IS NOT NULL, CONCAT('u', user_id), visitor_id)) as \`unique\` FROM page_visits WHERE ${dateFilter}`
    )

    let trend
    if (period === 'today') {
      ;[trend] = await pool.query(
        `SELECT HOUR(visited_at) as h, COUNT(*) as views,
                COUNT(DISTINCT IF(user_id IS NOT NULL, CONCAT('u', user_id), visitor_id)) as visitors
         FROM page_visits WHERE ${dateFilter}
         GROUP BY HOUR(visited_at) ORDER BY h`
      )
      const byHour = {}
      trend.forEach(r => { byHour[r.h] = { views: r.views, visitors: r.visitors } })
      trend = Array.from({ length: 24 }, (_, i) => ({
        label: i,
        views: byHour[i]?.views || 0,
        visitors: byHour[i]?.visitors || 0
      }))
    } else {
      ;[trend] = await pool.query(
        `SELECT ${groupBy} as label, 
                COUNT(*) as views,
                COUNT(DISTINCT IF(user_id IS NOT NULL, CONCAT('u', user_id), visitor_id)) as visitors
         FROM page_visits WHERE ${dateFilter}
         GROUP BY ${groupBy} ORDER BY label`
      )
    }

    const [topPages] = await pool.query(
      `SELECT page_url, COUNT(*) as views FROM page_visits WHERE ${dateFilter} GROUP BY page_url ORDER BY views DESC LIMIT 10`
    )

    res.json({ code: 0, data: { total_views: total, unique_visitors: unique, trend, topPages } })
  } catch (error) {
    console.error('获取页面统计失败:', error)
    res.status(500).json({ code: 500, message: '获取统计数据失败' })
  }
})

app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const size = parseInt(req.query.size) || 10
  const offset = (page - 1) * size
  const keyword = req.query.keyword || ''
  
  try {
    if (keyword) {
      const [users] = await pool.query(`
        SELECT id, uuid, username, email, avatar, credits_balance, total_tasks, status, vip_level, vip_expired_at, last_login_at, created_at, updated_at, friendly_id
        FROM app_users
        WHERE deleted_at IS NULL AND (username LIKE ? OR email LIKE ?)
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `, [`%${keyword}%`, `%${keyword}%`, size, offset])
      
      const [countResult] = await pool.query(`
        SELECT COUNT(*) as total 
        FROM app_users 
        WHERE deleted_at IS NULL AND (username LIKE ? OR email LIKE ?)
      `, [`%${keyword}%`, `%${keyword}%`])
      
      return res.json({ code: 0, data: { list: users, total: countResult[0].total, page, size } })
    } else {
      const [users] = await pool.query(`
        SELECT id, uuid, username, email, avatar, credits_balance, total_tasks, status, vip_level, vip_expired_at, last_login_at, created_at, updated_at, friendly_id
        FROM app_users
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `, [size, offset])
      
      const [countResult] = await pool.query(`
        SELECT COUNT(*) as total 
        FROM app_users 
        WHERE deleted_at IS NULL
      `)
      
      return res.json({ code: 0, data: { list: users, total: countResult[0].total, page, size } })
    }
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取用户列表失败' })
  }
})

app.post('/api/admin/users', authenticateAdmin, async (req, res) => {
  const { username, email, password, credits } = req.body
  if (!username || !email || !password) return res.status(400).json({ code: 400, message: '请填写完整信息' })
  if (password.length < 6) return res.status(400).json({ code: 400, message: '密码长度至少为6位' })
  
  try {
    const [existingUsername] = await pool.query('SELECT id FROM app_users WHERE LOWER(username) = LOWER(?)', [username])
    if (existingUsername.length > 0) return res.status(400).json({ code: 400, message: '用户名已存在' })
    const [existingEmail] = await pool.query('SELECT id FROM app_users WHERE email = ?', [email])
    if (existingEmail.length > 0) return res.status(400).json({ code: 400, message: '邮箱已存在' })
    
    const hashedPassword = await bcrypt.hash(password, 10)
    const userUuid = uuidv4()
    const initialCredits = credits || 0
    const friendlyId = await generateFriendlyId()
    await pool.query(
      `INSERT INTO app_users (uuid, username, email, password, friendly_id, credits_balance, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
      [userUuid, username, email, hashedPassword, friendlyId, initialCredits]
    )
    res.json({ code: 0, message: '用户创建成功', data: { friendly_id: friendlyId } })
  } catch (error) {
    res.status(500).json({ code: 500, message: '创建用户失败' })
  }
})

app.put('/api/admin/users/:id', authenticateAdmin, async (req, res) => {
  const userId = req.params.id
  const { username, email, credits_balance, vip_level, vip_expired_at } = req.body
  
  try {
    let updateQuery = 'UPDATE app_users SET username = ?, email = ?, credits_balance = ?, updated_at = NOW()'
    let params = [username, email, credits_balance]
    if (vip_level !== undefined) {
      updateQuery += ', vip_level = ?, vip_updated_at = NOW()'
      params.push(vip_level)
      if (vip_expired_at !== undefined) {
        updateQuery += ', vip_expired_at = ?'
        params.push(vip_expired_at)
      }
    }
    updateQuery += ' WHERE id = ? AND deleted_at IS NULL'
    params.push(userId)
    await pool.query(updateQuery, params)
    res.json({ code: 0, message: '用户信息已更新' })
  } catch (error) {
    res.status(500).json({ code: 500, message: '更新用户失败' })
  }
})

app.post('/api/admin/users/:id/credits', authenticateAdmin, async (req, res) => {
  const userId = req.params.id
  const { amount, remark } = req.body
  if (amount === undefined) return res.status(400).json({ code: 400, message: '请填写调整数量' })
  
  try {
    await pool.query('UPDATE app_users SET credits_balance = credits_balance + ? WHERE id = ?', [amount, userId])
    await pool.query(`INSERT INTO credit_transactions (user_id, amount, type, description, created_at) VALUES (?, ?, 'admin_adjust', ?, NOW())`, [userId, amount, remark || '管理员调整'])
    res.json({ code: 0, message: '积分调整成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: '调整积分失败' })
  }
})

app.get('/api/admin/credits', authenticateAdmin, async (req, res) => {
  const { page = 1, size = 20, user_id } = req.query
  const offset = (parseInt(page) - 1) * parseInt(size)
  try {
    let whereClause = ''
    let params = []
    if (user_id) {
      whereClause = 'WHERE ct.user_id = ?'
      params.push(parseInt(user_id))
    }
    const [countResult] = await pool.query(`SELECT COUNT(*) AS total FROM credit_transactions ct ${whereClause}`, params)
    const total = countResult[0].total
    const [rows] = await pool.query(
      `SELECT ct.*, au.username, au.friendly_id 
       FROM credit_transactions ct 
       LEFT JOIN app_users au ON ct.user_id = au.id 
       ${whereClause} 
       ORDER BY ct.id DESC 
       LIMIT ? OFFSET ?`,
      [...params, parseInt(size), offset]
    )
    res.json({ code: 0, data: { list: rows, total, page: parseInt(page), size: parseInt(size) } })
  } catch (error) {
    res.status(500).json({ code: 500, message: '查询积分记录失败' })
  }
})

app.post('/api/admin/users/:id/vip', authenticateAdmin, async (req, res) => {
  const userId = req.params.id
  const { vip_level, duration_days } = req.body
  if (!vip_level || !['basic'].includes(vip_level)) return res.status(400).json({ code: 400, message: '请选择有效的会员等级' })
  
  try {
    const [users] = await pool.query('SELECT vip_expired_at FROM app_users WHERE id = ?', [userId])
    let newExpiredAt
    if (users[0].vip_expired_at && new Date(users[0].vip_expired_at) > new Date()) {
      newExpiredAt = new Date(users[0].vip_expired_at)
      newExpiredAt.setDate(newExpiredAt.getDate() + (duration_days || 30))
    } else {
      newExpiredAt = new Date()
      newExpiredAt.setDate(newExpiredAt.getDate() + (duration_days || 30))
    }
    await pool.query('UPDATE app_users SET vip_level = ?, vip_expired_at = ?, vip_updated_at = NOW() WHERE id = ?', [vip_level, newExpiredAt.toISOString().slice(0, 19).replace('T', ' '), userId])
    res.json({ code: 0, message: 'VIP会员设置成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: '设置VIP失败' })
  }
})

app.post('/api/admin/users/:id/block', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE app_users SET status = ? WHERE id = ?', ['banned', req.params.id])
    res.json({ code: 0, message: '用户已封禁' })
  } catch (error) {
    res.status(500).json({ code: 500, message: '封禁用户失败' })
  }
})

app.post('/api/admin/users/:id/unblock', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE app_users SET status = ? WHERE id = ?', ['active', req.params.id])
    res.json({ code: 0, message: '用户已解封' })
  } catch (error) {
    res.status(500).json({ code: 500, message: '解封用户失败' })
  }
})

app.delete('/api/admin/users/:id', authenticateAdmin, async (req, res) => {
  const userId = req.params.id
  
  try {
    // 先检查用户是否存在
    const [users] = await pool.query('SELECT id, username, wx_openid FROM app_users WHERE id = ?', [userId])
    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: '用户不存在' })
    }
    
    console.log(`🗑️ 管理员正在彻底删除用户: ${users[0].username} (ID: ${userId})`)
    
    // 1. 删除该用户的所有任务记录
    await pool.query('DELETE FROM video_tasks WHERE user_id = ?', [userId])
    
    // 2. 删除该用户的积分交易记录
    await pool.query('DELETE FROM credit_transactions WHERE user_id = ?', [userId])
    
    // 3. 最后删除用户本身
    await pool.query('DELETE FROM app_users WHERE id = ?', [userId])
    
    res.json({ code: 0, message: '用户已彻底删除' })
  } catch (error) {
    console.error('删除用户失败:', error)
    res.status(500).json({ code: 500, message: '删除用户失败' })
  }
})

// 管理员：移除用户VIP
app.post('/api/admin/users/:id/remove-vip', authenticateAdmin, async (req, res) => {
  const userId = req.params.id
  
  try {
    // 检查用户是否存在
    const [users] = await pool.query('SELECT id, vip_level FROM app_users WHERE id = ? AND deleted_at IS NULL', [userId])
    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: '用户不存在' })
    }
    
    const user = users[0]
    if (user.vip_level === 'none') {
      return res.status(400).json({ code: 400, message: '该用户不是VIP会员' })
    }
    
    // 移除VIP：设置为 none，清空过期时间
    await pool.query(
      'UPDATE app_users SET vip_level = "none", vip_expired_at = NULL, vip_updated_at = NOW() WHERE id = ?',
      [userId]
    )
    
    console.log(`✅ 管理员移除了用户 ${userId} 的VIP会员`)
    
    res.json({
      code: 0,
      message: 'VIP已移除，用户已恢复为普通用户'
    })
  } catch (error) {
    console.error('移除VIP失败:', error)
    res.status(500).json({ code: 500, message: '移除VIP失败' })
  }
})

// 封禁用户
app.post('/api/admin/users/:id/block', authenticateAdmin, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT id, status FROM app_users WHERE id = ? AND deleted_at IS NULL', [req.params.id])
    if (users.length === 0) return res.status(404).json({ code: 404, message: '用户不存在' })
    if (users[0].status === 'banned') return res.status(400).json({ code: 400, message: '该用户已被封禁' })
    await pool.query('UPDATE app_users SET status = "banned", updated_at = NOW() WHERE id = ?', [req.params.id])
    console.log(`✅ 管理员封禁了用户 ${req.params.id}`)
    res.json({ code: 0, message: '用户已封禁' })
  } catch (error) {
    console.error('封禁用户失败:', error)
    res.status(500).json({ code: 500, message: '封禁失败' })
  }
})

// 解封用户
app.post('/api/admin/users/:id/unblock', authenticateAdmin, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT id, status FROM app_users WHERE id = ? AND deleted_at IS NULL', [req.params.id])
    if (users.length === 0) return res.status(404).json({ code: 404, message: '用户不存在' })
    if (users[0].status === 'active') return res.status(400).json({ code: 400, message: '该用户当前未被封禁' })
    await pool.query('UPDATE app_users SET status = "active", updated_at = NOW() WHERE id = ?', [req.params.id])
    console.log(`✅ 管理员解封了用户 ${req.params.id}`)
    res.json({ code: 0, message: '用户已解封' })
  } catch (error) {
    console.error('解封用户失败:', error)
    res.status(500).json({ code: 500, message: '解封失败' })
  }
})

// ========== 订单管理 ==========
app.get('/api/admin/orders', authenticateAdmin, async (req, res) => {
  const { page = 1, size = 20, status, provider } = req.query
  const offset = (parseInt(page) - 1) * parseInt(size)
  try {
    let where = []
    let params = []
    if (status) { where.push('po.status = ?'); params.push(status) }
    if (provider) { where.push('po.provider = ?'); params.push(provider) }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const [countResult] = await pool.query(`SELECT COUNT(*) AS total FROM payment_orders po ${whereClause}`, params)
    const total = countResult[0].total
    const [rows] = await pool.query(
      `SELECT po.*, au.username, au.friendly_id
       FROM payment_orders po
       LEFT JOIN app_users au ON po.user_id = au.id
       ${whereClause}
       ORDER BY po.id DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(size), offset]
    )
    res.json({ code: 0, data: { list: rows, total, page: parseInt(page), size: parseInt(size) } })
  } catch (error) {
    console.error('获取订单列表失败:', error)
    res.status(500).json({ code: 500, message: '获取订单列表失败' })
  }
})

// ========== 订单确认（管理员确认付款后开通VIP/积分）==========
app.post('/api/admin/orders/:orderNo/confirm', authenticateAdmin, async (req, res) => {
  try {
    const [orders] = await pool.query(
      'SELECT * FROM payment_orders WHERE order_no = ? AND status = ?',
      [req.params.orderNo, 'pending']
    )
    if (orders.length === 0) {
      return res.status(404).json({ code: 404, message: '订单不存在或已处理' })
    }
    const order = orders[0]
    const [users] = await pool.query(
      'SELECT * FROM app_users WHERE id = ? AND deleted_at IS NULL',
      [order.user_id]
    )
    if (users.length === 0) return res.status(404).json({ code: 404, message: '用户不存在' })

    // 判断订单类型：plan_id 以 credits_ 开头为积分订单
    if (order.plan_id && order.plan_id.startsWith('credits_')) {
      // 积分订单：根据 plan_id 确定积分数
      const creditAmount = parseInt(order.plan_id.replace('credits_', '')) || 0
      if (creditAmount <= 0) return res.status(400).json({ code: 400, message: '无效的积分数量' })
      await pool.query(
        `UPDATE payment_orders SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE order_no = ?`,
        [order.order_no]
      )
      await pool.query(
        'UPDATE app_users SET credits_balance = credits_balance + ? WHERE id = ?',
        [creditAmount, order.user_id]
      )
      await pool.query(
        `INSERT INTO credit_transactions (user_id, amount, type, description, created_at) VALUES (?, ?, 'recharge', '购买积分', NOW())`,
        [order.user_id, creditAmount]
      )
      await addNotification(pool, order.user_id, '积分到账', `您购买的 ${creditAmount} 积分已到账`, 'success')
      console.log(`✅ 积分订单 ${order.order_no} 已确认，用户 ${order.user_id} +${creditAmount} 积分`)
      return res.json({ code: 0, message: `订单已确认，已添加 ${creditAmount} 积分` })
    }

    // VIP 订单：原有逻辑
    const days = order.amount >= 80 ? 365 : 30
    const user = users[0]
    const now = new Date()
    let baseDate = now
    if (user.vip_expired_at && new Date(user.vip_expired_at) > now) {
      baseDate = new Date(user.vip_expired_at)
    }
    const expiredAt = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000)
    await pool.query(
      `UPDATE payment_orders SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE order_no = ?`,
      [order.order_no]
    )
    await pool.query(
      `UPDATE app_users SET vip_level = ?, vip_expired_at = ?, vip_updated_at = NOW(), updated_at = NOW() WHERE id = ?`,
      ['basic', expiredAt.toISOString().slice(0, 19).replace('T', ' '), order.user_id]
    )
    await pool.query(
      'UPDATE app_users SET credits_balance = credits_balance + 500 WHERE id = ?',
      [order.user_id]
    )
    await pool.query(
      `INSERT INTO credit_transactions (user_id, amount, type, description, created_at) VALUES (?, 500, 'recharge', '开通VIP赠送积分', NOW())`,
      [order.user_id]
    )
    const planLabel = days === 365 ? '年付' : '月付'
    await addNotification(pool, order.user_id, 'VIP已开通', `您购买的 VIP ${planLabel}（${days}天）已开通，赠送 500 积分已到账`, 'success', 'https://abc.leesystem.xyz/vip')
    console.log(`✅ 订单 ${order.order_no} 已确认，用户 ${order.user_id} VIP已开通至 ${expiredAt.toISOString()}`)
    res.json({ code: 0, message: `订单已确认，VIP已开通（${days}天）` })
  } catch (error) {
    console.error('确认订单失败:', error)
    res.status(500).json({ code: 500, message: '确认订单失败' })
  }
})

// 更新订单状态（退款/取消）
app.put('/api/admin/orders/:orderNo/status', authenticateAdmin, async (req, res) => {
  const { status } = req.body
  if (!['refunded', 'cancelled'].includes(status)) {
    return res.status(400).json({ code: 400, message: '无效的状态值' })
  }
  try {
    const [orders] = await pool.query(
      'SELECT * FROM payment_orders WHERE order_no = ?',
      [req.params.orderNo]
    )
    if (orders.length === 0) return res.status(404).json({ code: 404, message: '订单不存在' })
    const order = orders[0]
    if (status === 'refunded') {
      if (order.plan_id && order.plan_id.startsWith('credits_')) {
        // 纯积分订单：只扣除购买的积分数
        const creditAmount = parseInt(order.plan_id.replace('credits_', '')) || 0
        await pool.query(
          'UPDATE app_users SET credits_balance = GREATEST(credits_balance - ?, 0), updated_at = NOW() WHERE id = ?',
          [creditAmount, order.user_id]
        )
        await pool.query(
          `INSERT INTO credit_transactions (user_id, amount, type, description, created_at) VALUES (?, ?, 'deduct', '退款扣除购买积分', NOW())`,
          [order.user_id, -creditAmount]
        )
        console.log(`⛔ 积分订单 ${order.order_no} 已退款，用户 ${order.user_id} -${creditAmount} 积分`)
      } else {
        // VIP订单：收回VIP + 扣除赠送的500积分
        await pool.query(
          `UPDATE app_users SET vip_level = NULL, vip_expired_at = NULL, credits_balance = GREATEST(credits_balance - 500, 0), updated_at = NOW() WHERE id = ?`,
          [order.user_id]
        )
        await pool.query(
          `INSERT INTO credit_transactions (user_id, amount, type, description, created_at) VALUES (?, -500, 'deduct', '退款扣除赠送积分', NOW())`,
          [order.user_id]
        )
        console.log(`⛔ 订单 ${order.order_no} 已退款，用户 ${order.user_id} VIP已收回`)
      }
    }
    await pool.query(
      `UPDATE payment_orders SET status = ?, updated_at = NOW() WHERE order_no = ?`,
      [status, req.params.orderNo]
    )
    const refundMsg = order.plan_id && order.plan_id.startsWith('credits_') ? '退款，积分已扣除' : '退款，VIP已收回'
    res.json({ code: 0, message: `订单已${status === 'refunded' ? refundMsg : '取消'}` })
  } catch (error) {
    console.error('更新订单状态失败:', error)
    res.status(500).json({ code: 500, message: '更新订单状态失败' })
  }
})

// ========== 系统设置 ==========
app.get('/api/admin/settings', authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT config_key, config_value FROM system_configs')
    const settings = {}
    rows.forEach(r => { settings[r.config_key] = r.config_value })
    res.json({ code: 0, data: settings })
  } catch (error) {
    console.error('获取系统设置失败:', error)
    res.status(500).json({ code: 500, message: '获取系统设置失败' })
  }
})

app.put('/api/admin/settings', authenticateAdmin, async (req, res) => {
  const settings = req.body
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ code: 400, message: '请提供有效的设置数据' })
  }
  try {
    for (const [key, value] of Object.entries(settings)) {
      await pool.query(
        `INSERT INTO system_configs (config_key, config_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE config_value = ?, updated_at = NOW()`,
        [key, String(value), String(value)]
      )
    }
    res.json({ code: 0, message: '系统设置已保存' })
  } catch (error) {
    console.error('保存系统设置失败:', error)
    res.status(500).json({ code: 500, message: '保存系统设置失败' })
  }
})

// ========== 生成友好ID的函数 ==========
async function generateFriendlyId() {
  const [rows] = await pool.query(
    `SELECT MAX(CAST(SUBSTRING(friendly_id, 6) AS UNSIGNED)) AS max_num
     FROM app_users
     WHERE friendly_id REGEXP '^USER_[0-9]+$'`
  );
  
  const nextNum = Math.max(Number(rows[0]?.max_num) || 100000, 100000) + 1;
  return `USER_${nextNum}`;
}

async function assignFriendlyId(userId) {
  const friendlyId = await generateFriendlyId();
  await pool.query(
    'UPDATE app_users SET friendly_id = ? WHERE id = ? AND friendly_id IS NULL',
    [friendlyId, userId]
  );
  return friendlyId;
}

async function backfillFriendlyIds() {
  const [users] = await pool.query(
    'SELECT id FROM app_users WHERE friendly_id IS NULL AND deleted_at IS NULL ORDER BY id ASC'
  );

  for (const user of users) {
    const friendlyId = await assignFriendlyId(user.id);
    console.log(`✅ 为用户 ${user.id} 补齐友好ID: ${friendlyId}`);
  }

  if (users.length > 0) {
    console.log(`✅ 已补齐 ${users.length} 个用户的友好ID`);
  }
}

async function columnExists(tableName, columnName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB_NAME, tableName, columnName]
  );
  return rows[0].total > 0;
}

async function indexExists(tableName, indexName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [DB_NAME, tableName, indexName]
  );
  return rows[0].total > 0;
}

async function uniqueIndexOnColumnExists(tableName, columnName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? AND NON_UNIQUE = 0`,
    [DB_NAME, tableName, columnName]
  );
  return rows[0].total > 0;
}

async function ensureColumn(tableName, columnName, definition) {
  if (await columnExists(tableName, columnName)) return;
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  console.log(`✅ ${tableName}.${columnName} 字段已补齐`);
}

async function ensureIndex(tableName, indexName, definition) {
  if (await indexExists(tableName, indexName)) return;
  await pool.query(`ALTER TABLE ${tableName} ADD ${definition}`);
  console.log(`✅ ${tableName}.${indexName} 索引已补齐`);
}

async function ensureUniqueIndex(tableName, columnName, indexName) {
  if (await uniqueIndexOnColumnExists(tableName, columnName)) return;
  await ensureIndex(tableName, indexName, `UNIQUE KEY ${indexName} (${columnName})`);
}

async function ensureAppUsersExtensions() {
  await ensureColumn('app_users', 'wx_openid', 'VARCHAR(100) DEFAULT NULL');
  await ensureColumn('app_users', 'wx_unionid', 'VARCHAR(100) DEFAULT NULL');
  await ensureColumn('app_users', 'friendly_id', 'VARCHAR(20) DEFAULT NULL');
  await ensureColumn('app_users', 'phone', 'VARCHAR(20) DEFAULT NULL');
  await ensureColumn('app_users', 'email_verified', 'BOOLEAN DEFAULT FALSE');
  await ensureColumn('app_users', 'phone_verified', 'BOOLEAN DEFAULT FALSE');
  await ensureUniqueIndex('app_users', 'wx_openid', 'uk_wx_openid');
  await ensureUniqueIndex('app_users', 'friendly_id', 'uk_friendly_id');
  await ensureUniqueIndex('app_users', 'phone', 'uk_phone');
}

async function ensureVideoTasksExtensions() {
  await ensureColumn('video_tasks', 'uuid', 'VARCHAR(36) DEFAULT NULL');
  await ensureColumn('video_tasks', 'task_type', "ENUM('summary','transcript','translate','podcast','mindmap') NOT NULL DEFAULT 'summary'");
  await ensureColumn('video_tasks', 'source_platform', 'VARCHAR(50) DEFAULT NULL');
  await ensureColumn('video_tasks', 'video_duration', 'INT DEFAULT NULL');
  await ensureColumn('video_tasks', 'file_path', 'VARCHAR(500) DEFAULT NULL');
  await ensureColumn('video_tasks', 'file_size', 'INT DEFAULT NULL');
  await ensureColumn('video_tasks', 'processing_time', 'INT DEFAULT NULL');
  await ensureColumn('video_tasks', 'priority', 'INT DEFAULT 0');
  await ensureColumn('video_tasks', 'deleted_at', 'DATETIME DEFAULT NULL');
  await ensureIndex('video_tasks', 'idx_status', 'KEY idx_status (status)');
}

async function ensureAdminUser() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT NOT NULL AUTO_INCREMENT,
      username VARCHAR(50) NOT NULL,
      email VARCHAR(100) NOT NULL,
      password VARCHAR(255) NOT NULL,
      avatar VARCHAR(500) DEFAULT '',
      role ENUM('admin','user','viewer') DEFAULT 'user',
      credits_balance INT DEFAULT 0,
      total_credits_earned INT DEFAULT 0,
      total_credits_spent INT DEFAULT 0,
      subscription_plan ENUM('free','basic','premium','enterprise') DEFAULT 'free',
      subscription_expire_at DATETIME DEFAULT NULL,
      status ENUM('active','inactive','banned') DEFAULT 'active',
      last_login_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uk_username (username),
      UNIQUE KEY uk_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const [admins] = await pool.query(
    'SELECT id FROM users WHERE username = ? AND deleted_at IS NULL',
    [adminUsername]
  );

  if (admins.length === 0) {
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    await pool.query(
      `INSERT INTO users (username, email, password, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', 'active', NOW(), NOW())`,
      [adminUsername, adminEmail, hashedPassword]
    );
    console.log(`✅ 管理员账号 ${adminUsername} 已创建`);
  }
}

// ========== 微信小程序登录（优化版：支持头像昵称 + friendly_id）==========
app.post('/api/app/wx-login', async (req, res) => {
  const { code, nickName, avatarUrl, email, phone } = req.body;
  
  if (!code) {
    return res.status(400).json({ code: 400, message: '缺少登录凭证 code' });
  }
  
  const WX_APPID = process.env.WX_APPID;
  const WX_SECRET = process.env.WX_SECRET;
  
  if (!WX_APPID || !WX_SECRET) {
    console.error('❌ 微信小程序配置缺失');
    return res.status(500).json({ code: 500, message: '服务器配置错误' });
  }
  
  try {
    // 1. 调用微信接口获取 openId
    const response = await fetch(
      `https://api.weixin.qq.com/sns/jscode2session?appid=${WX_APPID}&secret=${WX_SECRET}&js_code=${code}&grant_type=authorization_code`
    );
    const wxData = await response.json();
    
    if (wxData.errcode) {
      console.error('微信接口错误:', wxData);
      return res.status(400).json({ code: 400, message: wxData.errmsg || '微信登录失败' });
    }
    
    const openId = wxData.openid;
    const unionId = wxData.unionid || null;
    
    // ========== 新增：先检查是否已有用户通过邮箱关联 ==========
    let user = null;
    let isNewUser = false;
    
    // 1.1 如果传入了邮箱，先查找是否已有该邮箱的用户
    if (email) {
      const [emailUsers] = await pool.query(
        'SELECT id, uuid, username, email, avatar, credits_balance, status, vip_level, vip_expired_at, friendly_id, wx_openid FROM app_users WHERE email = ? AND deleted_at IS NULL',
        [email]
      );
      
      if (emailUsers.length > 0) {
        // 找到已有用户，关联微信信息
        user = emailUsers[0];
        
        // 更新用户的微信 openId（关联小程序）
        await pool.query(
          'UPDATE app_users SET wx_openid = ?, wx_unionid = ?, updated_at = NOW() WHERE id = ?',
          [openId, unionId, user.id]
        );
        
        console.log(`✅ 小程序关联到已有用户: ${user.username} (ID: ${user.id}), 邮箱: ${email}`);
      }
    }
    
    // 1.2 如果没有通过邮箱找到，再通过微信 openId 查找
    if (!user) {
      const [wxUsers] = await pool.query(
        'SELECT id, uuid, username, email, avatar, credits_balance, status, vip_level, vip_expired_at, friendly_id FROM app_users WHERE wx_openid = ? AND deleted_at IS NULL',
        [openId]
      );
      
      if (wxUsers.length > 0) {
        user = wxUsers[0];
        console.log(`✅ 微信用户已存在: ${user.username} (ID: ${user.id})`);
      }
    }
    
    // 2. 如果都没找到，创建新用户
    if (!user) {
      isNewUser = true;
      const userUuid = uuidv4();
      const friendlyId = await generateFriendlyId();
      
      const finalUsername = nickName || `用户${friendlyId}`;
      const finalAvatar = avatarUrl || 'https://thirdwx.qlogo.cn/mmopen/vi_32/POgEwh4mIHO4nibH0KlMECNjjGxQUq24ZEaGT4poC6icRiccVGKSyXwibcPq4BWmiaIGuG1icwxaQX6grC9VemZoJ8rg/132';
      
      const insertResult = await pool.query(
        `INSERT INTO app_users 
         (uuid, username, wx_openid, wx_unionid, avatar, friendly_id, credits_balance, status, created_at, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, 10, 'active', NOW(), NOW())`,
        [userUuid, finalUsername, openId, unionId, finalAvatar, friendlyId]
      );
      
      const [newUsers] = await pool.query(
        'SELECT id, uuid, username, email, avatar, credits_balance, status, vip_level, vip_expired_at, friendly_id FROM app_users WHERE id = ?',
        [insertResult[0].insertId]
      );
      user = newUsers[0];
      console.log(`✅ 创建新用户，友好ID: ${friendlyId}`);
    }
    
    // 3. 检查封禁状态
    if (user.status === 'banned') {
      return res.status(403).json({ code: 403, message: '账号已被封禁' });
    }
    
    // 4. 生成 JWT token
    const token = jwt.sign(
      { id: user.id, type: 'app_user', wx: true },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    
    // 5. 返回用户信息
    res.json({
      code: 0,
      message: isNewUser ? '注册并登录成功' : '登录成功',
      data: {
        token,
        user: {
          id: user.id,
          uuid: user.uuid,
          username: user.username,
          email: user.email,
          avatar: user.avatar,
          credits_balance: user.credits_balance,
          vip_level: user.vip_level,
          vip_expired_at: user.vip_expired_at,
          friendly_id: user.friendly_id,
          is_new: isNewUser
        }
      }
    });
    
  } catch (error) {
    console.error('微信登录失败:', error);
    res.status(500).json({ code: 500, message: '登录失败，请稍后重试' });
  }
});

// ========== 小程序绑定邮箱 ==========

// 1. 发送邮箱验证码（绑定邮箱用）
app.post('/api/app/send-bind-email-code', authenticateAppUser, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ code: 400, message: '请提供邮箱地址' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ code: 400, message: '邮箱格式不正确' });
  }
  
  try {
    // 检查邮箱是否已被其他用户绑定
    const [existing] = await pool.query(
      'SELECT id FROM app_users WHERE email = ? AND id != ? AND deleted_at IS NULL',
      [email, req.userId]
    );
    if (existing.length > 0) {
      return res.status(400).json({ code: 400, message: '该邮箱已被其他用户绑定' });
    }
    
    // 检查是否频繁发送
    const existingCode = verificationCodes.get(`bind_email_${req.userId}_${email}`);
    if (existingCode && (Date.now() - existingCode.createdAt) < 60000) {
      const remainingSeconds = Math.ceil((60000 - (Date.now() - existingCode.createdAt)) / 1000);
      return res.status(429).json({ code: 429, message: `请 ${remainingSeconds} 秒后再试` });
    }
    
    const code = generateCode();
    verificationCodes.set(`bind_email_${req.userId}_${email}`, {
      code,
      email,
      expiresAt: Date.now() + 10 * 60 * 1000,
      createdAt: Date.now()
    });
    
    const result = await sendVerificationEmail(email, code, 'email_change');
    res.json(result.success ? { code: 0, message: '验证码已发送' } : { code: 500, message: result.message });
  } catch (error) {
    console.error('发送验证码失败:', error);
    res.status(500).json({ code: 500, message: '发送失败' });
  }
});

// 2. 绑定邮箱
app.post('/api/app/bind-email', authenticateAppUser, async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ code: 400, message: '请填写邮箱和验证码' });
  }
  
  try {
    const storedCode = verificationCodes.get(`bind_email_${req.userId}_${email}`);
    if (!storedCode) {
      return res.status(400).json({ code: 400, message: '请先获取验证码' });
    }
    if (storedCode.code !== code) {
      return res.status(400).json({ code: 400, message: '验证码错误' });
    }
    if (storedCode.expiresAt < Date.now()) {
      verificationCodes.delete(`bind_email_${req.userId}_${email}`);
      return res.status(400).json({ code: 400, message: '验证码已过期' });
    }
    
    // 检查邮箱是否已被其他用户绑定
    const [existing] = await pool.query(
      'SELECT id FROM app_users WHERE email = ? AND id != ? AND deleted_at IS NULL',
      [email, req.userId]
    );
    if (existing.length > 0) {
      return res.status(400).json({ code: 400, message: '该邮箱已被其他用户绑定' });
    }
    
    // 绑定邮箱
    await pool.query(
      'UPDATE app_users SET email = ?, email_verified = TRUE, updated_at = NOW() WHERE id = ?',
      [email, req.userId]
    );
    
    verificationCodes.delete(`bind_email_${req.userId}_${email}`);
    
    // 返回更新后的用户信息
    const [users] = await pool.query(
      'SELECT id, uuid, username, email, avatar, credits_balance, status, vip_level, vip_expired_at, friendly_id, email_verified FROM app_users WHERE id = ?',
      [req.userId]
    );
    
    res.json({ code: 0, message: '邮箱绑定成功', data: { user: users[0] } });
  } catch (error) {
    console.error('绑定邮箱失败:', error);
    res.status(500).json({ code: 500, message: '绑定失败' });
  }
});

// 3. 解绑邮箱
app.post('/api/app/unbind-email', authenticateAppUser, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT email FROM app_users WHERE id = ?', [req.userId]);
    if (!users[0].email) {
      return res.status(400).json({ code: 400, message: '未绑定邮箱' });
    }
    
    await pool.query(
      'UPDATE app_users SET email = NULL, email_verified = FALSE, updated_at = NOW() WHERE id = ?',
      [req.userId]
    );
    
    res.json({ code: 0, message: '邮箱解绑成功' });
  } catch (error) {
    console.error('解绑邮箱失败:', error);
    res.status(500).json({ code: 500, message: '解绑失败' });
  }
});

// ========== 短信服务（阿里云） ==========
const SMS_ACCESS_KEY = process.env.SMS_ACCESS_KEY || ''
const SMS_ACCESS_SECRET = process.env.SMS_ACCESS_SECRET || ''
const SMS_SIGN_NAME = process.env.SMS_SIGN_NAME || 'Extract'        // 短信签名
const SMS_TEMPLATE_CODE = process.env.SMS_TEMPLATE_CODE || 'SMS_123456789'  // 短信模板CODE

const sendPhoneCodeSms = async (phone, code) => {
  // 未配置SMS时回退到开发模式
  if (!SMS_ACCESS_KEY || !SMS_ACCESS_SECRET) {
    console.log(`📱 [开发模式] 手机验证码 ${code} 已发送到 ${phone}`)
    return { success: true, devMode: true }
  }

  try {
    // 阿里云 SMS API v2.0 签名
    const crypto = require('crypto')
    const timestamp = new Date().toISOString()
    const nonce = Math.random().toString(36).substring(2, 15)

    const params = {
      AccessKeyId: SMS_ACCESS_KEY,
      Action: 'SendSms',
      Format: 'JSON',
      PhoneNumbers: phone,
      SignName: SMS_SIGN_NAME,
      TemplateCode: SMS_TEMPLATE_CODE,
      TemplateParam: JSON.stringify({ code }),
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: nonce,
      SignatureVersion: '1.0',
      Timestamp: timestamp,
      Version: '2017-05-25'
    }

    // 排序并构造签名字符串
    const sortedKeys = Object.keys(params).sort()
    const canonicalizedQuery = sortedKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&')
    const stringToSign = `POST&${encodeURIComponent('/')}&${encodeURIComponent(canonicalizedQuery)}`
    const signature = crypto.createHmac('sha1', `${SMS_ACCESS_SECRET}&`).update(stringToSign).digest('base64')

    const queryString = `Signature=${encodeURIComponent(signature)}&${canonicalizedQuery}`

    const response = await fetch(`https://dysmsapi.aliyuncs.com/?${queryString}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })

    const data = await response.json()
    if (data.Code === 'OK') {
      console.log(`📱 短信验证码已发送到 ${phone}`)
      return { success: true }
    } else {
      console.error('短信发送失败:', data.Message)
      return { success: false, message: data.Message || '短信发送失败' }
    }
  } catch (error) {
    console.error('短信接口异常:', error.message)
    return { success: false, message: '短信服务异常，请稍后重试' }
  }
}

// ========== 小程序绑定手机号 ==========

// 1. 发送手机验证码
app.post('/api/app/send-phone-code', authenticateAppUser, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ code: 400, message: '请提供手机号' });
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ code: 400, message: '手机号格式不正确' });
  }
  
  try {
    // 检查手机号是否已被其他用户绑定
    const [existing] = await pool.query(
      'SELECT id FROM app_users WHERE phone = ? AND id != ? AND deleted_at IS NULL',
      [phone, req.userId]
    );
    if (existing.length > 0) {
      return res.status(400).json({ code: 400, message: '该手机号已被其他用户绑定' });
    }
    
    // 检查是否频繁发送
    const existingCode = verificationCodes.get(`bind_phone_${req.userId}_${phone}`);
    if (existingCode && (Date.now() - existingCode.createdAt) < 60000) {
      const remainingSeconds = Math.ceil((60000 - (Date.now() - existingCode.createdAt)) / 1000);
      return res.status(429).json({ code: 429, message: `请 ${remainingSeconds} 秒后再试` });
    }
    
    const code = generateCode();
    verificationCodes.set(`bind_phone_${req.userId}_${phone}`, {
      code,
      phone,
      expiresAt: Date.now() + 10 * 60 * 1000,
      createdAt: Date.now()
    });
    
    // 发送短信
    const smsResult = await sendPhoneCodeSms(phone, code);
    if (!smsResult.success) {
      return res.status(500).json({ code: 500, message: smsResult.message || '发送失败' });
    }

    res.json({ code: 0, message: smsResult.devMode ? '验证码已发送（开发模式，请查看控制台）' : '验证码已发送' });
  } catch (error) {
    console.error('发送验证码失败:', error);
    res.status(500).json({ code: 500, message: '发送失败' });
  }
});

// 2. 绑定手机号
app.post('/api/app/bind-phone', authenticateAppUser, async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) {
    return res.status(400).json({ code: 400, message: '请填写手机号和验证码' });
  }
  
  try {
    const storedCode = verificationCodes.get(`bind_phone_${req.userId}_${phone}`);
    if (!storedCode) {
      return res.status(400).json({ code: 400, message: '请先获取验证码' });
    }
    if (storedCode.code !== code) {
      return res.status(400).json({ code: 400, message: '验证码错误' });
    }
    if (storedCode.expiresAt < Date.now()) {
      verificationCodes.delete(`bind_phone_${req.userId}_${phone}`);
      return res.status(400).json({ code: 400, message: '验证码已过期' });
    }
    
    // 检查手机号是否已被其他用户绑定
    const [existing] = await pool.query(
      'SELECT id FROM app_users WHERE phone = ? AND id != ? AND deleted_at IS NULL',
      [phone, req.userId]
    );
    if (existing.length > 0) {
      return res.status(400).json({ code: 400, message: '该手机号已被其他用户绑定' });
    }
    
    // 绑定手机号
    await pool.query(
      'UPDATE app_users SET phone = ?, phone_verified = TRUE, updated_at = NOW() WHERE id = ?',
      [phone, req.userId]
    );
    
    verificationCodes.delete(`bind_phone_${req.userId}_${phone}`);
    
    // 返回更新后的用户信息
    const [users] = await pool.query(
      'SELECT id, uuid, username, email, avatar, credits_balance, status, vip_level, vip_expired_at, friendly_id, phone, email_verified, phone_verified FROM app_users WHERE id = ?',
      [req.userId]
    );
    
    res.json({ code: 0, message: '手机号绑定成功', data: { user: users[0] } });
  } catch (error) {
    console.error('绑定手机号失败:', error);
    res.status(500).json({ code: 500, message: '绑定失败' });
  }
});

// 3. 解绑手机号
app.post('/api/app/unbind-phone', authenticateAppUser, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT phone FROM app_users WHERE id = ?', [req.userId]);
    if (!users[0].phone) {
      return res.status(400).json({ code: 400, message: '未绑定手机号' });
    }
    
    await pool.query(
      'UPDATE app_users SET phone = NULL, phone_verified = FALSE, updated_at = NOW() WHERE id = ?',
      [req.userId]
    );
    
    res.json({ code: 0, message: '手机号解绑成功' });
  } catch (error) {
    console.error('解绑手机号失败:', error);
    res.status(500).json({ code: 500, message: '解绑失败' });
  }
});

// ========== 跨平台 VIP 同步 ==========
const getVipTimestamp = (vipExpiredAt) => {
  if (!vipExpiredAt) return Number.MAX_SAFE_INTEGER;
  const time = new Date(vipExpiredAt).getTime();
  return Number.isNaN(time) ? 0 : time;
};

const isActiveVip = (user) => {
  if (!user || user.vip_level === 'none') return false;
  return getVipTimestamp(user.vip_expired_at) > Date.now();
};

const shouldApplyVipSync = (source, current) => {
  const sourceRank = VIP_LEVEL_RANK[source.vip_level] || 0;
  const currentRank = isActiveVip(current) ? (VIP_LEVEL_RANK[current.vip_level] || 0) : 0;
  if (sourceRank > currentRank) return true;
  if (sourceRank < currentRank) return false;
  return getVipTimestamp(source.vip_expired_at) > getVipTimestamp(current.vip_expired_at);
};

const getPublicUser = async (userId) => {
  const [users] = await pool.query(
    `SELECT id, uuid, username, email, avatar, credits_balance, total_tasks,
            status, vip_level, vip_expired_at, friendly_id,
            phone, email_verified, phone_verified
     FROM app_users
     WHERE id = ? AND deleted_at IS NULL`,
    [userId]
  );
  return users[0] || null;
};

const findBestVipSource = async (field, value, currentUserId) => {
  if (!['email', 'phone'].includes(field)) {
    throw new Error('Invalid sync field');
  }

  const [users] = await pool.query(
    `SELECT id, username, vip_level, vip_expired_at
     FROM app_users
     WHERE ${field} = ? AND id != ? AND deleted_at IS NULL`,
    [value, currentUserId]
  );

  return users
    .filter(isActiveVip)
    .sort((a, b) => {
      const rankDiff = (VIP_LEVEL_RANK[b.vip_level] || 0) - (VIP_LEVEL_RANK[a.vip_level] || 0);
      if (rankDiff !== 0) return rankDiff;
      return getVipTimestamp(b.vip_expired_at) - getVipTimestamp(a.vip_expired_at);
    })[0] || null;
};

const syncVipFromSource = async (req, field, value) => {
  const source = await findBestVipSource(field, value, req.userId);
  if (!source) {
    return { status: 404, body: { code: 404, message: '未找到可同步的有效VIP权益' } };
  }

  const current = await getPublicUser(req.userId);
  if (!current) {
    return { status: 404, body: { code: 404, message: '用户不存在' } };
  }

  if (!shouldApplyVipSync(source, current)) {
    return {
      status: 200,
      body: {
        code: 0,
        message: '当前账号VIP权益已不低于可同步权益',
        data: { synced: false, user: current }
      }
    };
  }

  await pool.query(
    'UPDATE app_users SET vip_level = ?, vip_expired_at = ?, vip_updated_at = NOW(), updated_at = NOW() WHERE id = ?',
    [source.vip_level, source.vip_expired_at, req.userId]
  );

  const user = await getPublicUser(req.userId);
  return {
    status: 200,
    body: {
      code: 0,
      message: 'VIP权益同步成功',
      data: {
        synced: true,
        source_user_id: source.id,
        user
      }
    }
  };
};

const syncVipToTarget = async (req, field, value) => {
  if (!['email', 'phone'].includes(field)) {
    throw new Error('Invalid sync field');
  }

  const source = await getPublicUser(req.userId);
  if (!source) {
    return { status: 404, body: { code: 404, message: '用户不存在' } };
  }

  if (!isActiveVip(source)) {
    return { status: 400, body: { code: 400, message: '当前小程序账号没有可同步的有效VIP权益' } };
  }

  const [targets] = await pool.query(
    `SELECT id, username, vip_level, vip_expired_at
     FROM app_users
     WHERE ${field} = ? AND id != ? AND deleted_at IS NULL`,
    [value, req.userId]
  );

  if (targets.length === 0) {
    return { status: 404, body: { code: 404, message: '未找到对应的网页端账号' } };
  }

  const target = targets[0];
  if (!shouldApplyVipSync(source, target)) {
    return {
      status: 200,
      body: {
        code: 0,
        message: '网页端账号VIP权益已不低于当前小程序账号',
        data: { synced: false, target_user_id: target.id, user: source }
      }
    };
  }

  await pool.query(
    'UPDATE app_users SET vip_level = ?, vip_expired_at = ?, vip_updated_at = NOW(), updated_at = NOW() WHERE id = ?',
    [source.vip_level, source.vip_expired_at, target.id]
  );

  return {
    status: 200,
    body: {
      code: 0,
      message: 'VIP权益已同步到网页端账号',
      data: { synced: true, target_user_id: target.id, user: source }
    }
  };
};

app.post('/api/app/send-sync-email-code', authenticateAppUser, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ code: 400, message: '请提供邮箱地址' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ code: 400, message: '邮箱格式不正确' });
  }

  try {
    const key = getSyncCodeKey('email', req.userId, email);
    const existingCode = verificationCodes.get(key);
    if (existingCode && (Date.now() - existingCode.createdAt) < 60000) {
      const remainingSeconds = Math.ceil((60000 - (Date.now() - existingCode.createdAt)) / 1000);
      return res.status(429).json({ code: 429, message: `请 ${remainingSeconds} 秒后再试` });
    }

    const code = generateCode();
    verificationCodes.set(key, {
      code,
      email,
      expiresAt: Date.now() + 10 * 60 * 1000,
      createdAt: Date.now()
    });

    const result = await sendVerificationEmail(email, code, 'email_change');
    res.json(result.success ? { code: 0, message: '验证码已发送' } : { code: 500, message: result.message });
  } catch (error) {
    console.error('发送VIP同步邮箱验证码失败:', error);
    res.status(500).json({ code: 500, message: '发送失败' });
  }
});

app.post('/api/app/sync-vip-by-email', authenticateAppUser, async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ code: 400, message: '请填写邮箱和验证码' });

  try {
    const key = getSyncCodeKey('email', req.userId, email);
    const storedCode = verificationCodes.get(key);
    if (!storedCode) return res.status(400).json({ code: 400, message: '请先获取验证码' });
    if (storedCode.code !== code) return res.status(400).json({ code: 400, message: '验证码错误' });
    if (storedCode.expiresAt < Date.now()) {
      verificationCodes.delete(key);
      return res.status(400).json({ code: 400, message: '验证码已过期' });
    }

    const result = await syncVipFromSource(req, 'email', email);
    if (result.status !== 200 || !result.body.data) {
      verificationCodes.delete(key);
      return res.status(result.status).json(result.body);
    }
    
    // 同步成功后，将邮箱绑定到当前小程序账号（如果还未绑定）
    const [currentUser] = await pool.query(
      'SELECT email, email_verified FROM app_users WHERE id = ?',
      [req.userId]
    );
    
    // ✅ 检查邮箱是否已被其他用户占用
    const [existingEmailUser] = await pool.query(
      'SELECT id FROM app_users WHERE email = ? AND id != ? AND deleted_at IS NULL',
      [email, req.userId]
    );
    
    if (!currentUser[0].email && existingEmailUser.length === 0) {
      // 只有邮箱未被占用时才自动绑定
      await pool.query(
        'UPDATE app_users SET email = ?, email_verified = TRUE, updated_at = NOW() WHERE id = ?',
        [email, req.userId]
      );
      console.log(`✅ 小程序用户 ${req.userId} 自动绑定邮箱: ${email}`);
    } else if (existingEmailUser.length > 0) {
      console.log(`⚠️ 邮箱 ${email} 已被用户 ${existingEmailUser[0].id} 绑定，跳过自动绑定`);
    }
    
    verificationCodes.delete(key);
    const latestUser = await getPublicUser(req.userId);
    if (result.body.data) result.body.data.user = latestUser;
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('通过邮箱同步VIP失败:', error);
    res.status(500).json({ code: 500, message: error.message || '同步失败' });
  }
});

app.post('/api/app/send-sync-phone-code', authenticateAppUser, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ code: 400, message: '请提供手机号' });
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ code: 400, message: '手机号格式不正确' });
  }

  try {
    const key = getSyncCodeKey('phone', req.userId, phone);
    const existingCode = verificationCodes.get(key);
    if (existingCode && (Date.now() - existingCode.createdAt) < 60000) {
      const remainingSeconds = Math.ceil((60000 - (Date.now() - existingCode.createdAt)) / 1000);
      return res.status(429).json({ code: 429, message: `请 ${remainingSeconds} 秒后再试` });
    }

    const code = generateCode();
    verificationCodes.set(key, {
      code,
      phone,
      expiresAt: Date.now() + 10 * 60 * 1000,
      createdAt: Date.now()
    });

    const smsResult = await sendPhoneCodeSms(phone, code);
    if (!smsResult.success) {
      return res.status(500).json({ code: 500, message: smsResult.message || '发送失败' });
    }
    res.json({ code: 0, message: smsResult.devMode ? '验证码已发送（开发模式，请查看控制台）' : '验证码已发送' });
  } catch (error) {
    console.error('发送VIP同步手机验证码失败:', error);
    res.status(500).json({ code: 500, message: '发送失败' });
  }
});

app.post('/api/app/sync-vip-by-phone', authenticateAppUser, async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ code: 400, message: '请填写手机号和验证码' });

  try {
    const key = getSyncCodeKey('phone', req.userId, phone);
    const storedCode = verificationCodes.get(key);
    if (!storedCode) return res.status(400).json({ code: 400, message: '请先获取验证码' });
    if (storedCode.code !== code) return res.status(400).json({ code: 400, message: '验证码错误' });
    if (storedCode.expiresAt < Date.now()) {
      verificationCodes.delete(key);
      return res.status(400).json({ code: 400, message: '验证码已过期' });
    }

    const result = await syncVipFromSource(req, 'phone', phone);
    if (result.status !== 200 || !result.body.data) {
      verificationCodes.delete(key);
      return res.status(result.status).json(result.body);
    }
    
    // 同步成功后，将手机号绑定到当前小程序账号（如果还未绑定）
    const [currentUser] = await pool.query(
      'SELECT phone, phone_verified FROM app_users WHERE id = ?',
      [req.userId]
    );
    
    const [existingPhoneUser] = await pool.query(
      'SELECT id FROM app_users WHERE phone = ? AND id != ? AND deleted_at IS NULL',
      [phone, req.userId]
    );
    
    if (!currentUser[0].phone && existingPhoneUser.length === 0) {
      await pool.query(
        'UPDATE app_users SET phone = ?, phone_verified = TRUE, updated_at = NOW() WHERE id = ?',
        [phone, req.userId]
      );
      console.log(`✅ 小程序用户 ${req.userId} 自动绑定手机号: ${phone}`);
    } else if (existingPhoneUser.length > 0) {
      console.log(`⚠️ 手机号 ${phone} 已被用户 ${existingPhoneUser[0].id} 绑定，跳过自动绑定`);
    }
    
    verificationCodes.delete(key);
    const latestUser = await getPublicUser(req.userId);
    if (result.body.data) result.body.data.user = latestUser;
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('通过手机号同步VIP失败:', error);
    res.status(500).json({ code: 500, message: '同步失败' });
  }
});

app.post('/api/app/sync-vip-to-email', authenticateAppUser, async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ code: 400, message: '请填写邮箱和验证码' });

  try {
    const key = getSyncCodeKey('email', req.userId, email);
    const storedCode = verificationCodes.get(key);
    if (!storedCode) return res.status(400).json({ code: 400, message: '请先获取验证码' });
    if (storedCode.code !== code) return res.status(400).json({ code: 400, message: '验证码错误' });
    if (storedCode.expiresAt < Date.now()) {
      verificationCodes.delete(key);
      return res.status(400).json({ code: 400, message: '验证码已过期' });
    }

    const result = await syncVipToTarget(req, 'email', email);
    verificationCodes.delete(key);
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('同步VIP到邮箱账号失败:', error);
    res.status(500).json({ code: 500, message: error.message || '同步失败' });
  }
});

app.post('/api/app/sync-vip-to-phone', authenticateAppUser, async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ code: 400, message: '请填写手机号和验证码' });

  try {
    const key = getSyncCodeKey('phone', req.userId, phone);
    const storedCode = verificationCodes.get(key);
    if (!storedCode) return res.status(400).json({ code: 400, message: '请先获取验证码' });
    if (storedCode.code !== code) return res.status(400).json({ code: 400, message: '验证码错误' });
    if (storedCode.expiresAt < Date.now()) {
      verificationCodes.delete(key);
      return res.status(400).json({ code: 400, message: '验证码已过期' });
    }

    const result = await syncVipToTarget(req, 'phone', phone);
    verificationCodes.delete(key);
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('同步VIP到手机号账号失败:', error);
    res.status(500).json({ code: 500, message: error.message || '同步失败' });
  }
});

// ========== 数据库初始化 ==========
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id INT NOT NULL AUTO_INCREMENT,
        uuid VARCHAR(36) NOT NULL,
        username VARCHAR(50) NOT NULL,
        email VARCHAR(100) DEFAULT NULL,
        password VARCHAR(255) DEFAULT NULL,
        avatar VARCHAR(500) DEFAULT NULL,
        credits_balance INT DEFAULT 0,
        total_credits_earned INT DEFAULT 0,
        total_tasks INT DEFAULT 0,
        status ENUM('active', 'inactive', 'banned') DEFAULT 'active',
        vip_level ENUM('none', 'basic', 'pro', 'enterprise') DEFAULT 'none',
        vip_expired_at DATETIME DEFAULT NULL,
        vip_updated_at DATETIME DEFAULT NULL,
        wx_openid VARCHAR(100) DEFAULT NULL,
        wx_unionid VARCHAR(100) DEFAULT NULL,
        friendly_id VARCHAR(20) DEFAULT NULL,
        phone VARCHAR(20) DEFAULT NULL,
        email_verified BOOLEAN DEFAULT FALSE,
        phone_verified BOOLEAN DEFAULT FALSE,
        last_login_at DATETIME DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at DATETIME DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uk_email (email),
        UNIQUE KEY uk_username (username),
        UNIQUE KEY uk_uuid (uuid),
        UNIQUE KEY uk_wx_openid (wx_openid),
        UNIQUE KEY uk_friendly_id (friendly_id),
        UNIQUE KEY uk_phone (phone)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    console.log('✅ app_users 表已就绪')
    await ensureAppUsersExtensions()
    await backfillFriendlyIds()
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        amount INT NOT NULL,
        type ENUM('consume', 'recharge', 'admin_adjust', 'refund') NOT NULL,
        description VARCHAR(255) DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    console.log('✅ credit_transactions 表已就绪')

    // 修正ENUM：添加 checkin 类型
    try {
      await pool.query(`ALTER TABLE credit_transactions MODIFY COLUMN type ENUM('consume','recharge','admin_adjust','refund','checkin') NOT NULL`)
      console.log('✅ credit_transactions ENUM 已更新（添加 checkin）')
    } catch (e) {
      console.log('ℹ️  credit_transactions ENUM 可能已包含 checkin')
    }

    // 修正新用户默认积分从10改为0
    await pool.query(`ALTER TABLE app_users ALTER COLUMN credits_balance SET DEFAULT 0`)
    await pool.query(`UPDATE app_users SET credits_balance = 0 WHERE credits_balance IS NULL`)
    console.log('✅ 已修正默认积分为0')

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_orders (
        id INT NOT NULL AUTO_INCREMENT,
        order_no VARCHAR(64) NOT NULL,
        user_id INT NOT NULL,
        plan_id VARCHAR(20) NOT NULL,
        amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        provider ENUM('wechat','alipay','admin') NOT NULL DEFAULT 'wechat',
        status ENUM('pending','paid','refunded','cancelled') NOT NULL DEFAULT 'pending',
        transaction_id VARCHAR(64) DEFAULT NULL,
        paid_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uk_order_no (order_no),
        KEY idx_user_id (user_id),
        KEY idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    console.log('✅ payment_orders 表已就绪')
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS video_tasks (
        id INT NOT NULL AUTO_INCREMENT,
        uuid VARCHAR(36) DEFAULT NULL,
        user_id INT DEFAULT NULL,
        task_type ENUM('summary','transcript','translate','podcast','mindmap') NOT NULL,
        source_url VARCHAR(500) DEFAULT NULL,
        source_platform VARCHAR(50) DEFAULT NULL,
        video_title VARCHAR(500) DEFAULT NULL,
        video_duration INT DEFAULT NULL,
        file_path VARCHAR(500) DEFAULT NULL,
        file_size INT DEFAULT NULL,
        status ENUM('pending','processing','completed','failed','cancelled') DEFAULT 'pending',
        result_data TEXT,
        error_message TEXT,
        credits_used INT DEFAULT 0,
        processing_time INT DEFAULT NULL,
        priority INT DEFAULT 0,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        deleted_at DATETIME DEFAULT NULL,
        PRIMARY KEY (id),
        KEY idx_user_id (user_id),
        KEY idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await ensureVideoTasksExtensions()
    await ensureAdminUser()
    console.log('✅ video_tasks 表已就绪')

    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_configs (
        id INT NOT NULL AUTO_INCREMENT,
        config_key VARCHAR(100) NOT NULL,
        config_value TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_config_key (config_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    console.log('✅ system_configs 表已就绪')

    await pool.query(`
      CREATE TABLE IF NOT EXISTS page_visits (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT DEFAULT NULL,
        visitor_id VARCHAR(64) DEFAULT NULL,
        ip_address VARCHAR(45) DEFAULT NULL,
        page_url VARCHAR(500) DEFAULT NULL,
        referrer VARCHAR(500) DEFAULT NULL,
        user_agent VARCHAR(500) DEFAULT NULL,
        visited_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_visited_at (visited_at),
        KEY idx_user_id (user_id),
        KEY idx_visitor_id (visitor_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    console.log('✅ page_visits 表已就绪')
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        title VARCHAR(200) NOT NULL,
        content TEXT,
        type ENUM('info','success','warning','error') DEFAULT 'info',
        link VARCHAR(500) DEFAULT NULL,
        readed TINYINT(1) DEFAULT 0,
        created_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        KEY idx_user_id (user_id),
        KEY idx_user_read (user_id, readed)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    console.log('✅ notifications 表已就绪')
    console.log('🎉 数据库初始化完成！')
  } catch (error) {
    console.error('数据库初始化失败:', error)
  }
}

// ========== 启动服务器 ==========
async function startServer() {
  await initDatabase()
  initEmailTransporter()
  
  console.log('✅ 阿里云百炼 API Key', BAILIAN_API_KEY ? '已配置' : '未配置')
  console.log('✅ DeepSeek API Key', DEEPSEEK_API_KEY ? '已配置' : '未配置')
  console.log('✅ 豆包 API Key', DOUBAO_API_KEY ? '已配置' : '未配置')
  
  try {
    await execPromise(`"${YTDLP_PATH}" --version`, { timeout: 5000 })
    console.log('✅ yt-dlp 已就绪')
  } catch (error) {
    console.log('⚠️ yt-dlp 未找到')
  }
  
  if (fs.existsSync(DOUYIN_COOKIES_FILE)) {
    console.log('🍪 抖音 Cookies 文件已找到')
  } else {
    console.log('⚠️ 未找到抖音 Cookies 文件')
  }
  
  app.listen(PORT, () => {
    console.log(`=================================`)
    console.log(`🚀 Extract API Server running on port ${PORT}`)
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`)
    console.log(`🔗 Health: http://localhost:${PORT}/health`)
    console.log(`🔗 用户端 API: http://localhost:${PORT}/api/app/`)
    console.log(`🔗 管理端 API: http://localhost:${PORT}/api/admin/`)
    console.log(`🔗 队列监控: http://localhost:${PORT}/admin/queue`)
    console.log(`=================================`)
    console.log(`📋 可用模型:`)
    console.log(`   ⚡ 最快: 豆包 (Doubao)`)
    console.log(`   ⭐ 推荐: 阿里云百炼 (tongyi-xiaomi-analysis-pro)`)
    console.log(`=================================`)
  })
}

startServer()
