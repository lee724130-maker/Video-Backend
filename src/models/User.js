const { DataTypes } = require('sequelize')
const { sequelize } = require('../config/database')
const bcrypt = require('bcryptjs')

const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  username: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true,
    validate: {
      len: [3, 50],
    },
  },
  email: {
    type: DataTypes.STRING(100),
    allowNull: false,
    unique: true,
    validate: {
      isEmail: true,
    },
  },
  password: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  avatar: {
    type: DataTypes.STRING(500),
    defaultValue: '',
  },
  role: {
    type: DataTypes.ENUM('admin', 'user', 'viewer'),
    defaultValue: 'user',
  },
  credits_balance: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: '积分余额',
  },
  total_credits_earned: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: '累计获得积分',
  },
  total_credits_spent: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: '累计消耗积分',
  },
  subscription_plan: {
    type: DataTypes.ENUM('free', 'basic', 'premium', 'enterprise'),
    defaultValue: 'free',
  },
  subscription_expire_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('active', 'inactive', 'banned'),
    defaultValue: 'active',
  },
  last_login_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'users',
  hooks: {
    beforeCreate: async (user) => {
      if (user.password) {
        user.password = await bcrypt.hash(user.password, 10)
      }
    },
    beforeUpdate: async (user) => {
      if (user.changed('password')) {
        user.password = await bcrypt.hash(user.password, 10)
      }
    },
  },
})



User.prototype.comparePassword = async function(password) {
  console.log('=== 密码验证调试 ===');
  console.log('1. 输入的密码:', password);
  console.log('2. 存储的哈希:', this.password);
  console.log('3. 哈希长度:', this.password.length);
  console.log('4. 哈希字符:', this.password.split('').map(c => c.charCodeAt(0)));
  
  try {
    const result = await bcrypt.compare(password, this.password);
    console.log('5. bcrypt.compare 结果:', result);
    return result;
  } catch (error) {
    console.error('6. bcrypt.compare 错误:', error);
    return false;
  }
}

module.exports = User