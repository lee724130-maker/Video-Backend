const { VideoTask, User } = require('../models')
const { Op } = require('sequelize')

// 获取任务列表
exports.getTaskList = async (req, res) => {
  try {
    const {
      page = 1,
      pageSize = 20,
      type,
      status,
      user_id,
      startDate,
      endDate,
    } = req.query
    
    const where = {}
    
    if (type) where.task_type = type
    if (status) where.status = status
    if (user_id) where.user_id = user_id
    
    if (startDate && endDate) {
      where.created_at = {
        [Op.between]: [new Date(startDate), new Date(endDate)],
      }
    }
    
    const { count, rows } = await VideoTask.findAndCountAll({
      where,
      include: [
        {
          model: User,
          attributes: ['id', 'username', 'email'],
        },
      ],
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
    console.error('Get task list error:', error)
    res.status(500).json({ code: 500, message: '获取任务列表失败' })
  }
}

// 获取任务详情
exports.getTaskDetail = async (req, res) => {
  try {
    const { id } = req.params
    
    const task = await VideoTask.findByPk(id, {
      include: [
        {
          model: User,
          attributes: ['id', 'username', 'email', 'credits_balance'],
        },
      ],
    })
    
    if (!task) {
      return res.status(404).json({ code: 404, message: '任务不存在' })
    }
    
    res.json({
      code: 0,
      data: task,
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取任务详情失败' })
  }
}

// 重试任务
exports.retryTask = async (req, res) => {
  try {
    const { id } = req.params
    
    const task = await VideoTask.findByPk(id)
    if (!task) {
      return res.status(404).json({ code: 404, message: '任务不存在' })
    }
    
    if (task.status !== 'failed') {
      return res.status(400).json({ code: 400, message: '只有失败的任务才能重试' })
    }
    
    await task.update({
      status: 'pending',
      error_message: null,
    })
    
    res.json({
      code: 0,
      message: '已加入重试队列',
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: '重试任务失败' })
  }
}

// 取消任务
exports.cancelTask = async (req, res) => {
  try {
    const { id } = req.params
    
    const task = await VideoTask.findByPk(id)
    if (!task) {
      return res.status(404).json({ code: 404, message: '任务不存在' })
    }
    
    if (task.status !== 'pending') {
      return res.status(400).json({ code: 400, message: '只有等待中的任务才能取消' })
    }
    
    await task.update({ status: 'cancelled' })
    
    res.json({
      code: 0,
      message: '任务已取消',
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: '取消任务失败' })
  }
}

// 获取任务统计
exports.getTaskStatistics = async (req, res) => {
  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    
    const [totalTasks, todayTasks, pendingTasks, processingTasks, failedTasks] = await Promise.all([
      VideoTask.count(),
      VideoTask.count({ where: { created_at: { [Op.gte]: today } } }),
      VideoTask.count({ where: { status: 'pending' } }),
      VideoTask.count({ where: { status: 'processing' } }),
      VideoTask.count({ where: { status: 'failed' } }),
    ])
    
    const tasksByType = await VideoTask.findAll({
      attributes: ['task_type', [require('sequelize').fn('COUNT', '*'), 'count']],
      group: ['task_type'],
    })
    
    res.json({
      code: 0,
      data: {
        total_tasks: totalTasks,
        today_tasks: todayTasks,
        pending_tasks: pendingTasks,
        processing_tasks: processingTasks,
        failed_tasks: failedTasks,
        tasks_by_type: tasksByType,
      },
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取任务统计失败' })
  }
}