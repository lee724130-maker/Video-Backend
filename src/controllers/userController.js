const { User, CreditTransaction, VideoTask } = require('../models')
const { Op } = require('sequelize')

// 获取用户列表
exports.getUserList = async (req, res) => {
  try {
    const {
      page = 1,
      pageSize = 20,
      keyword,
      status,
      subscription_plan,
      startDate,
      endDate,
    } = req.query
    
    const where = {}
    
    if (keyword) {
      where[Op.or] = [
        { username: { [Op.like]: `%${keyword}%` } },
        { email: { [Op.like]: `%${keyword}%` } },
      ]
    }
    
    if (status) where.status = status
    if (subscription_plan) where.subscription_plan = subscription_plan
    
    if (startDate && endDate) {
      where.created_at = {
        [Op.between]: [new Date(startDate), new Date(endDate)],
      }
    }
    
    const { count, rows } = await User.findAndCountAll({
      where,
      attributes: { exclude: ['password'] },
      order: [['created_at', 'DESC']],
      limit: parseInt(pageSize),
      offset: (parseInt(page) - 1) * parseInt(pageSize),
    })
    
    res.json({
      code: 0,
      data: {
        list: rows,
        total: count,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
      },
    })
  } catch (error) {
    console.error('Get user list error:', error)
    res.status(500).json({ code: 500, message: '获取用户列表失败' })
  }
}

// 获取用户详情
exports.getUserDetail = async (req, res) => {
  try {
    const { id } = req.params
    
    const user = await User.findByPk(id, {
      attributes: { exclude: ['password'] },
      include: [
        {
          model: CreditTransaction,
          limit: 10,
          order: [['created_at', 'DESC']],
        },
      ],
    })
    
    if (!user) {
      return res.status(404).json({ code: 404, message: '用户不存在' })
    }
    
    res.json({
      code: 0,
      data: user,
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取用户详情失败' })
  }
}

// 更新用户
exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params
    const { username, email, role, subscription_plan, status } = req.body
    
    const user = await User.findByPk(id)
    if (!user) {
      return res.status(404).json({ code: 404, message: '用户不存在' })
    }
    
    await user.update({
      username,
      email,
      role,
      subscription_plan,
      status,
    })
    
    res.json({
      code: 0,
      message: '更新成功',
      data: user,
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: '更新用户失败' })
  }
}

// 调整用户积分
exports.adjustCredits = async (req, res) => {
  const t = await require('../models').sequelize.transaction()
  
  try {
    const { id } = req.params
    const { amount, remark } = req.body
    
    const user = await User.findByPk(id, { transaction: t })
    if (!user) {
      await t.rollback()
      return res.status(404).json({ code: 404, message: '用户不存在' })
    }
    
    const newBalance = user.credits_balance + amount
    
    // 创建积分交易记录
    await CreditTransaction.create({
      user_id: user.id,
      amount: amount,
      type: amount > 0 ? 'earn' : 'spend',
      source: 'admin_adjust',
      description: remark || `管理员调整积分: ${amount > 0 ? '+' : ''}${amount}`,
      balance_after: newBalance,
    }, { transaction: t })
    
    // 更新用户积分
    await user.update({
      credits_balance: newBalance,
      total_credits_earned: amount > 0 ? user.total_credits_earned + amount : user.total_credits_earned,
      total_credits_spent: amount < 0 ? user.total_credits_spent + Math.abs(amount) : user.total_credits_spent,
    }, { transaction: t })
    
    await t.commit()
    
    res.json({
      code: 0,
      message: '积分调整成功',
      data: { credits_balance: newBalance },
    })
  } catch (error) {
    await t.rollback()
    console.error('Adjust credits error:', error)
    res.status(500).json({ code: 500, message: '调整积分失败' })
  }
}

// 封禁用户
exports.blockUser = async (req, res) => {
  try {
    const { id } = req.params
    
    const user = await User.findByPk(id)
    if (!user) {
      return res.status(404).json({ code: 404, message: '用户不存在' })
    }
    
    await user.update({ status: 'banned' })
    
    res.json({
      code: 0,
      message: '封禁成功',
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: '封禁用户失败' })
  }
}