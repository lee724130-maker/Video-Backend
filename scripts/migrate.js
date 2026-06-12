/**
 * 数据库迁移脚本
 * 用途：初始化数据库表结构，补齐所有字段和索引，创建默认管理员
 * 用法：cd Video-Backend && node scripts/migrate.js
 * 安全：所有操作均幂等，可重复执行
 */

const mysql = require('mysql2/promise')
const bcrypt = require('bcryptjs')
require('dotenv').config()

const {
  DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME,
  ADMIN_USERNAME = 'admin',
  ADMIN_PASSWORD = 'admin123',
  ADMIN_EMAIL = 'admin@example.com'
} = process.env

let pool

// ========== 辅助函数 ==========

async function columnExists(tableName, columnName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB_NAME, tableName, columnName]
  )
  return rows[0].total > 0
}

async function indexExists(tableName, indexName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [DB_NAME, tableName, indexName]
  )
  return rows[0].total > 0
}

async function uniqueIndexOnColumnExists(tableName, columnName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? AND NON_UNIQUE = 0`,
    [DB_NAME, tableName, columnName]
  )
  return rows[0].total > 0
}

async function ensureColumn(tableName, columnName, definition) {
  if (await columnExists(tableName, columnName)) {
    console.log(`  ⏭️  ${tableName}.${columnName} 已存在`)
    return
  }
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
  console.log(`  ✅ ${tableName}.${columnName} 已补齐`)
}

async function ensureIndex(tableName, indexName, definition) {
  if (await indexExists(tableName, indexName)) {
    console.log(`  ⏭️  ${indexName} 索引已存在`)
    return
  }
  await pool.query(`ALTER TABLE ${tableName} ADD ${definition}`)
  console.log(`  ✅ ${indexName} 索引已补齐`)
}

async function ensureUniqueIndex(tableName, columnName, indexName) {
  if (await uniqueIndexOnColumnExists(tableName, columnName)) {
    console.log(`  ⏭️  ${indexName} 唯一索引已存在`)
    return
  }
  await ensureIndex(tableName, indexName, `UNIQUE KEY ${indexName} (${columnName})`)
}

// ========== 创建表 ==========

async function createAppUsers() {
  console.log('\n📦 创建 app_users 表...')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id INT NOT NULL AUTO_INCREMENT,
      uuid VARCHAR(36) NOT NULL,
      username VARCHAR(50) NOT NULL,
      email VARCHAR(100) DEFAULT NULL,
      password VARCHAR(255) DEFAULT NULL,
      avatar VARCHAR(500) DEFAULT NULL,
      credits_balance INT DEFAULT 10,
      total_credits_earned INT DEFAULT 0,
      total_tasks INT DEFAULT 0,
      status ENUM('active', 'inactive', 'banned') DEFAULT 'active',
      vip_level ENUM('none', 'basic', 'pro', 'enterprise') DEFAULT 'none',
      vip_expired_at DATETIME DEFAULT NULL,
      vip_updated_at DATETIME DEFAULT NULL,
      wx_openid VARCHAR(100) DEFAULT NULL,
      wx_unionid VARCHAR(100) DEFAULT NULL,
      friendly_id VARCHAR(20) DEFAULT NULL,
      phone VARCHAR(20) DEFAULT NULL,
      email_verified BOOLEAN DEFAULT FALSE,
      phone_verified BOOLEAN DEFAULT FALSE,
      last_login_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uk_email (email),
      UNIQUE KEY uk_username (username),
      UNIQUE KEY uk_uuid (uuid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  console.log('  ✅ app_users 表已就绪')
}

async function createUsers() {
  console.log('\n📦 创建 users 表（管理员）...')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT NOT NULL AUTO_INCREMENT,
      username VARCHAR(50) NOT NULL,
      email VARCHAR(100) NOT NULL,
      password VARCHAR(255) NOT NULL,
      avatar VARCHAR(500) DEFAULT '',
      role ENUM('admin','user','viewer') DEFAULT 'user',
      credits_balance INT DEFAULT 0,
      total_credits_earned INT DEFAULT 0,
      total_credits_spent INT DEFAULT 0,
      subscription_plan ENUM('free','basic','premium','enterprise') DEFAULT 'free',
      subscription_expire_at DATETIME DEFAULT NULL,
      status ENUM('active','inactive','banned') DEFAULT 'active',
      last_login_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uk_username (username),
      UNIQUE KEY uk_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  console.log('  ✅ users 表已就绪')
}

async function createCreditTransactions() {
  console.log('\n📦 创建 credit_transactions 表...')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      amount INT NOT NULL,
      type ENUM('consume', 'recharge', 'admin_adjust', 'refund') NOT NULL,
      description VARCHAR(255) DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  console.log('  ✅ credit_transactions 表已就绪')
}

async function createVideoTasks() {
  console.log('\n📦 创建 video_tasks 表...')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_tasks (
      id INT NOT NULL AUTO_INCREMENT,
      uuid VARCHAR(36) DEFAULT NULL,
      user_id INT DEFAULT NULL,
      task_type ENUM('summary','transcript','translate','podcast','mindmap') NOT NULL,
      source_url VARCHAR(500) DEFAULT NULL,
      source_platform VARCHAR(50) DEFAULT NULL,
      video_title VARCHAR(500) DEFAULT NULL,
      video_duration INT DEFAULT NULL,
      file_path VARCHAR(500) DEFAULT NULL,
      file_size INT DEFAULT NULL,
      status ENUM('pending','processing','completed','failed','cancelled') DEFAULT 'pending',
      result_data TEXT,
      error_message TEXT,
      credits_used INT DEFAULT 0,
      processing_time INT DEFAULT NULL,
      priority INT DEFAULT 0,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      deleted_at DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_user_id (user_id),
      KEY idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  console.log('  ✅ video_tasks 表已就绪')
}

// ========== 补齐字段和索引 ==========

async function patchAppUsers() {
  console.log('\n🔧 补齐 app_users 扩展字段...')
  await ensureColumn('app_users', 'wx_openid', 'VARCHAR(100) DEFAULT NULL')
  await ensureColumn('app_users', 'wx_unionid', 'VARCHAR(100) DEFAULT NULL')
  await ensureColumn('app_users', 'friendly_id', 'VARCHAR(20) DEFAULT NULL')
  await ensureColumn('app_users', 'phone', 'VARCHAR(20) DEFAULT NULL')
  await ensureColumn('app_users', 'email_verified', 'BOOLEAN DEFAULT FALSE')
  await ensureColumn('app_users', 'phone_verified', 'BOOLEAN DEFAULT FALSE')
  await ensureUniqueIndex('app_users', 'wx_openid', 'uk_wx_openid')
  await ensureUniqueIndex('app_users', 'friendly_id', 'uk_friendly_id')
  await ensureUniqueIndex('app_users', 'phone', 'uk_phone')
}

async function patchVideoTasks() {
  console.log('\n🔧 补齐 video_tasks 扩展字段...')
  await ensureColumn('video_tasks', 'uuid', 'VARCHAR(36) DEFAULT NULL')
  await ensureColumn('video_tasks', 'task_type', "ENUM('summary','transcript','translate','podcast','mindmap') NOT NULL DEFAULT 'summary'")
  await ensureColumn('video_tasks', 'source_platform', 'VARCHAR(50) DEFAULT NULL')
  await ensureColumn('video_tasks', 'video_duration', 'INT DEFAULT NULL')
  await ensureColumn('video_tasks', 'file_path', 'VARCHAR(500) DEFAULT NULL')
  await ensureColumn('video_tasks', 'file_size', 'INT DEFAULT NULL')
  await ensureColumn('video_tasks', 'processing_time', 'INT DEFAULT NULL')
  await ensureColumn('video_tasks', 'priority', 'INT DEFAULT 0')
  await ensureColumn('video_tasks', 'deleted_at', 'DATETIME DEFAULT NULL')
  await ensureIndex('video_tasks', 'idx_status', 'KEY idx_status (status)')
}

// ========== 初始化数据 ==========

async function createAdminUser() {
  console.log('\n👤 初始化管理员账号...')
  const [admins] = await pool.query(
    'SELECT id FROM users WHERE username = ? AND deleted_at IS NULL',
    [ADMIN_USERNAME]
  )
  if (admins.length > 0) {
    console.log(`  ⏭️  管理员 ${ADMIN_USERNAME} 已存在`)
    return
  }
  const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10)
  await pool.query(
    `INSERT INTO users (username, email, password, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 'active', NOW(), NOW())`,
    [ADMIN_USERNAME, ADMIN_EMAIL, hashedPassword]
  )
  console.log(`  ✅ 管理员 ${ADMIN_USERNAME} 已创建`)
}

async function backfillFriendlyIds() {
  console.log('\n🔢 补齐存量用户 friendly_id...')
  const [users] = await pool.query(
    'SELECT id FROM app_users WHERE friendly_id IS NULL AND deleted_at IS NULL ORDER BY id ASC'
  )
  if (users.length === 0) {
    console.log('  ⏭️  无待补齐用户')
    return
  }
  for (const user of users) {
    const [rows] = await pool.query(
      `SELECT MAX(CAST(SUBSTRING(friendly_id, 6) AS UNSIGNED)) AS max_num
       FROM app_users WHERE friendly_id REGEXP '^USER_[0-9]+$'`
    )
    const nextNum = Math.max(Number(rows[0]?.max_num) || 100000, 100000) + 1
    const friendlyId = `USER_${nextNum}`
    await pool.query('UPDATE app_users SET friendly_id = ? WHERE id = ?', [friendlyId, user.id])
    console.log(`  ✅ 用户 ${user.id} → ${friendlyId}`)
  }
  console.log(`  🎉 已补齐 ${users.length} 个用户的友好ID`)
}

// ========== 主流程 ==========

async function migrate() {
  console.log('🚀 开始数据库迁移...')
  console.log(`   数据库: ${DB_NAME}`)
  console.log(`   主机: ${DB_HOST}:${DB_PORT}`)

  try {
    pool = mysql.createPool({
      host: DB_HOST,
      port: parseInt(DB_PORT) || 3306,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: 5
    })

    // 验证连接
    await pool.query('SELECT 1')
    console.log('✅ 数据库连接成功\n')

    // 创建表
    await createAppUsers()
    await createUsers()
    await createCreditTransactions()
    await createVideoTasks()

    // 补齐字段
    await patchAppUsers()
    await patchVideoTasks()

    // 初始化数据
    await backfillFriendlyIds()
    await createAdminUser()

    console.log('\n🎉 数据库迁移完成！')
    process.exit(0)

  } catch (error) {
    console.error('\n❌ 迁移失败:', error.message)
    console.error(error)
    process.exit(1)
  }
}

migrate()
