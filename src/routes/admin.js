const express = require('express')
const { body } = require('express-validator')
const { authMiddleware, adminMiddleware } = require('../middleware/auth')
const authController = require('../controllers/authController')
const userController = require('../controllers/userController')
const taskController = require('../controllers/taskController')
const dashboardController = require('../controllers/dashboardController')  // 添加这行

const router = express.Router()

// ==================== 认证路由 ====================
router.post('/auth/login', [
  body('username').notEmpty().withMessage('用户名不能为空'),
  body('password').notEmpty().withMessage('密码不能为空'),
], authController.login)

router.get('/auth/me', authMiddleware, authController.getMe)

// ==================== Dashboard 路由 ====================
router.get('/dashboard/stats', authMiddleware, adminMiddleware, dashboardController.getStats)
router.get('/dashboard/task-trend', authMiddleware, adminMiddleware, dashboardController.getTaskTrend)
router.get('/dashboard/task-distribution', authMiddleware, adminMiddleware, dashboardController.getTaskDistribution)
router.get('/dashboard/recent-tasks', authMiddleware, adminMiddleware, dashboardController.getRecentTasks)

// ==================== 用户管理路由 ====================
router.get('/users', authMiddleware, adminMiddleware, userController.getUserList)
router.get('/users/:id', authMiddleware, adminMiddleware, userController.getUserDetail)
router.put('/users/:id', authMiddleware, adminMiddleware, userController.updateUser)
router.post('/users/:id/credits', authMiddleware, adminMiddleware, userController.adjustCredits)
router.post('/users/:id/block', authMiddleware, adminMiddleware, userController.blockUser)

// ==================== 任务管理路由 ====================
router.get('/tasks', authMiddleware, adminMiddleware, taskController.getTaskList)
router.get('/tasks/:id', authMiddleware, adminMiddleware, taskController.getTaskDetail)
router.post('/tasks/:id/retry', authMiddleware, adminMiddleware, taskController.retryTask)
router.post('/tasks/:id/cancel', authMiddleware, adminMiddleware, taskController.cancelTask)
router.get('/tasks/statistics', authMiddleware, adminMiddleware, taskController.getTaskStatistics)

module.exports = router