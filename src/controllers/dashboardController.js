const { User, VideoTask, CreditTransaction } = require('../models')
const { Op } = require('sequelize')

// 获取仪表盘统计数据
exports.getStats = async (req, res) => {
  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    
    const [totalUsers, todayTasks, pendingTasks, totalCreditsUsed] = await Promise.all([
      User.count(),
      VideoTask.count({ where: { created_at: { [Op.gte]: today } } }),
      VideoTask.count({ where: { status: 'pending' } }),
      CreditTransaction.sum('amount', { where: { type: 'spend' } }),
    ])
    
    res.json({
      code: 0,
      data: {
        total_users: totalUsers,
        today_tasks: todayTasks,
        pending_tasks: pendingTasks,
        total_credits_used: totalCreditsUsed || 0,
      }
    })
  } catch (error) {
    console.error('获取统计数据失败:', error)
    res.status(500).json({ code: 500, message: '获取统计数据失败' })
  }
}

// 获取任务趋势
exports.getTaskTrend = async (req, res) => {
  try {
    const { period = 'week' } = req.query
    const now = new Date()
    let dates = []
    let values = []
    
    if (period === 'week') {
      // 近7天
      for (let i = 6; i >= 0; i--) {
        const date = new Date(now)
        date.setDate(now.getDate() - i)
        date.setHours(0, 0, 0, 0)
        const nextDate = new Date(date)
        nextDate.setDate(date.getDate() + 1)
        
        const count = await VideoTask.count({
          where: {
            created_at: {
              [Op.gte]: date,
              [Op.lt]: nextDate
            }
          }
        })
        dates.push(`${date.getMonth() + 1}/${date.getDate()}`)
        values.push(count)
      }
    } else {
      // 近30天
      for (let i = 29; i >= 0; i--) {
        const date = new Date(now)
        date.setDate(now.getDate() - i)
        date.setHours(0, 0, 0, 0)
        const nextDate = new Date(date)
        nextDate.setDate(date.getDate() + 1)
        
        const count = await VideoTask.count({
          where: {
            created_at: {
              [Op.gte]: date,
              [Op.lt]: nextDate
            }
          }
        })
        dates.push(`${date.getMonth() + 1}/${date.getDate()}`)
        values.push(count)
      }
    }
    
    res.json({
      code: 0,
      data: {
        dates,
        values
      }
    })
  } catch (error) {
    console.error('获取任务趋势失败:', error)
    res.status(500).json({ code: 500, message: '获取任务趋势失败' })
  }
}

// 获取任务分布
exports.getTaskDistribution = async (req, res) => {
  try {
    const distribution = await VideoTask.findAll({
      attributes: [
        'task_type',
        [require('sequelize').fn('COUNT', '*'), 'count']
      ],
      group: ['task_type']
    })
    
    const typeNames = {
      summary: '视频总结',
      transcript: '视频转录',
      translate: '翻译',
      podcast: '播客生成',
      mindmap: '思维导图'
    }
    
    const data = distribution.map(item => ({
      name: typeNames[item.task_type] || item.task_type,
      value: parseInt(item.dataValues.count)
    }))
    
    res.json({
      code: 0,
      data
    })
  } catch (error) {
    console.error('获取任务分布失败:', error)
    res.status(500).json({ code: 500, message: '获取任务分布失败' })
  }
}

// 获取最近任务
exports.getRecentTasks = async (req, res) => {
  try {
    const { limit = 10 } = req.query
    
    const tasks = await VideoTask.findAll({
      include: [
        {
          model: User,
          attributes: ['id', 'username', 'email']
        }
      ],
      order: [['created_at', 'DESC']],
      limit: parseInt(limit)
    })
    
    res.json({
      code: 0,
      data: tasks
    })
  } catch (error) {
    console.error('获取最近任务失败:', error)
    res.status(500).json({ code: 500, message: '获取最近任务失败' })
  }
}