const jwt = require('jsonwebtoken')
const { User } = require('../models')

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    
    if (!token) {
      return res.status(401).json({ code: 401, message: '未提供认证令牌' })
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.findByPk(decoded.id)
    
    if (!user) {
      return res.status(401).json({ code: 401, message: '用户不存在' })
    }
    
    if (user.status !== 'active') {
      return res.status(403).json({ code: 403, message: '账号已被禁用' })
    }
    
    req.user = user
    next()
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ code: 401, message: '无效的认证令牌' })
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ code: 401, message: '认证令牌已过期' })
    }
    return res.status(500).json({ code: 500, message: '认证失败' })
  }
}

const adminMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ code: 403, message: '需要管理员权限' })
  }
  next()
}

module.exports = { authMiddleware, adminMiddleware }