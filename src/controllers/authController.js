const jwt = require('jsonwebtoken')
const { User } = require('../models')
const { validationResult } = require('express-validator')
const { Op } = require('sequelize')

// 登录
exports.login = async (req, res) => {
  try {
    console.log('Login request received:', req.body)
    
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array())
      return res.status(400).json({ code: 400, message: errors.array()[0].msg })
    }
    
    const { username, password } = req.body
    
    // 查找用户
    const user = await User.findOne({
      where: {
        [Op.or]: [
          { username: username },
          { email: username },
        ],
      },
    })
    
    console.log('User found:', user ? user.id : 'not found')
    
    if (!user) {
      return res.status(401).json({ code: 401, message: '用户名或密码错误' })
    }
    
    // 验证密码
    const isValidPassword = await user.comparePassword(password)
    console.log('Password valid:', isValidPassword)
    
    if (!isValidPassword) {
      return res.status(401).json({ code: 401, message: '用户名或密码错误' })
    }
    
    // 更新最后登录时间
    await user.update({ last_login_at: new Date() })
    
    // 生成 token
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    )
    
    console.log('Login successful for user:', user.username)
    
    res.json({
      code: 0,
      message: '登录成功',
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          avatar: user.avatar,
          role: user.role,
        },
      },
    })
  } catch (error) {
    console.error('Login error details:', error)
    console.error('Error stack:', error.stack)
    res.status(500).json({ 
      code: 500, 
      message: error.message || '登录失败',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    })
  }
}

// 获取当前用户信息
exports.getMe = async (req, res) => {
  try {
    const user = req.user
    if (!user) {
      return res.status(401).json({ code: 401, message: '未认证' })
    }
    
    res.json({
      code: 0,
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        role: user.role,
        credits_balance: user.credits_balance,
        subscription_plan: user.subscription_plan,
      },
    })
  } catch (error) {
    console.error('Get user error:', error)
    res.status(500).json({ code: 500, message: '获取用户信息失败' })
  }
}