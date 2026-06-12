const { DataTypes } = require('sequelize')
const { sequelize } = require('../config/database')

const CreditTransaction = sequelize.define('CreditTransaction', {
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
  amount: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: '正数增加，负数减少',
  },
  type: {
    type: DataTypes.ENUM('earn', 'spend'),
    allowNull: false,
  },
  source: {
    type: DataTypes.ENUM('daily_login', 'referral', 'purchase', 'refund', 'admin_adjust', 'task_consume'),
    allowNull: false,
  },
  description: {
    type: DataTypes.STRING(255),
  },
  related_task_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'video_tasks',
      key: 'id',
    },
  },
  balance_after: {
    type: DataTypes.INTEGER,
    comment: '交易后余额',
  },
}, {
  tableName: 'credit_transactions',
})

module.exports = CreditTransaction