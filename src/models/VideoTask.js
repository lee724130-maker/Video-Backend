const { DataTypes } = require('sequelize')
const { sequelize } = require('../config/database')

const VideoTask = sequelize.define('VideoTask', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id',
    },
  },
  task_type: {
    type: DataTypes.ENUM('summary', 'transcript', 'translate', 'podcast', 'mindmap'),
    allowNull: false,
    comment: '任务类型',
  },
  source_url: {
    type: DataTypes.STRING(500),
    comment: '源视频链接',
  },
  source_platform: {
    type: DataTypes.STRING(50),
    comment: '源平台: youtube, bilibili, tiktok等',
  },
  video_title: {
    type: DataTypes.STRING(500),
    comment: '视频标题',
  },
  video_duration: {
    type: DataTypes.INTEGER,
    comment: '视频时长(秒)',
  },
  file_path: {
    type: DataTypes.STRING(500),
    comment: '上传文件路径',
  },
  file_size: {
    type: DataTypes.INTEGER,
    comment: '文件大小(字节)',
  },
  status: {
    type: DataTypes.ENUM('pending', 'processing', 'completed', 'failed', 'cancelled'),
    defaultValue: 'pending',
  },
  result_data: {
    type: DataTypes.TEXT,
    get() {
      const value = this.getDataValue('result_data')
      return value ? JSON.parse(value) : null
    },
    set(value) {
      this.setDataValue('result_data', JSON.stringify(value))
    },
  },
  error_message: {
    type: DataTypes.TEXT,
  },
  credits_used: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  processing_time: {
    type: DataTypes.INTEGER,
    comment: '处理耗时(秒)',
  },
  priority: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: '优先级 0-9',
  },
}, {
  tableName: 'video_tasks',
})

module.exports = VideoTask