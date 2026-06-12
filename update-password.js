const mysql = require('mysql2/promise')
const bcrypt = require('bcryptjs')

async function updatePassword() {
  // 生成正确的哈希（60字符）
  const correctHash = await bcrypt.hash('admin123', 10)
  console.log('正确的哈希值:', correctHash)
  console.log('哈希长度:', correctHash.length)
  console.log('')
  
  // 连接数据库
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '123456', // 改成你的 MySQL 密码
    database: 'videoseek_admin'
  })
  
  // 直接使用脚本更新，避免手动复制的问题
  await connection.execute(
    'UPDATE users SET password = ? WHERE username = ?',
    [correctHash, 'admin']
  )
  
  console.log('✅ 密码已更新')
  
  // 验证
  const [rows] = await connection.execute(
    'SELECT id, username, LENGTH(password) as pwd_len, password FROM users WHERE username = ?',
    ['admin']
  )
  
  console.log('\n验证结果:')
  console.log('用户名:', rows[0].username)
  console.log('密码长度:', rows[0].pwd_len)
  console.log('密码哈希:', rows[0].password)
  console.log('')
  
  if (rows[0].pwd_len === 60) {
    console.log('✅ 密码长度正确（60字符）')
    
    // 测试验证
    const isValid = await bcrypt.compare('admin123', rows[0].password)
    console.log('密码验证测试:', isValid ? '✅ 通过' : '❌ 失败')
  } else {
    console.log('❌ 密码长度还是', rows[0].pwd_len, '字符，应该是60')
  }
  
  await connection.end()
  process.exit(0)
}

updatePassword()