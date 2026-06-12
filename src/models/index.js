const { sequelize } = require('../config/database')
const User = require('./User')
const VideoTask = require('./VideoTask')
const CreditTransaction = require('./CreditTransaction')

// 关联关系
User.hasMany(VideoTask, { foreignKey: 'user_id' })
VideoTask.belongsTo(User, { foreignKey: 'user_id' })

User.hasMany(CreditTransaction, { foreignKey: 'user_id' })
CreditTransaction.belongsTo(User, { foreignKey: 'user_id' })

VideoTask.hasOne(CreditTransaction, { foreignKey: 'related_task_id' })
CreditTransaction.belongsTo(VideoTask, { foreignKey: 'related_task_id' })

module.exports = {
  sequelize,
  User,
  VideoTask,
  CreditTransaction,
}