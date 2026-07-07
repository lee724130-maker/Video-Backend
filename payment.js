/**
 * 支付模块 — 支持三种模式（优先级从高到低）：
 *   1. API 模式：微信/支付宝商户号 → 统一下单 + 回调
 *   2. 收款码模式：展示个人收款码，用户付款后联系管理员确认
 *   3. 开发模式：未配置支付 → 提示联系管理员手动开通
 */
const crypto = require('crypto')

// ========== 微信/支付宝商户配置 ==========

// --- API 模式（商户号配置）---
const WECHAT_APPID = process.env.WECHAT_APPID || ''
const WECHAT_MCH_ID = process.env.WECHAT_MCH_ID || ''
const WECHAT_API_KEY = process.env.WECHAT_API_KEY || ''
const WECHAT_NOTIFY_URL = process.env.WECHAT_NOTIFY_URL || ''

const ALIPAY_APP_ID = process.env.ALIPAY_APP_ID || ''
const ALIPAY_PRIVATE_KEY = process.env.ALIPAY_PRIVATE_KEY || ''
const ALIPAY_PUBLIC_KEY = process.env.ALIPAY_PUBLIC_KEY || ''
const ALIPAY_NOTIFY_URL = process.env.ALIPAY_NOTIFY_URL || ''

// --- 收款码模式（个人微信/支付宝收款码图片 URL）---
const WECHAT_QR_URL = process.env.WECHAT_QR_URL || ''
const ALIPAY_QR_URL = process.env.ALIPAY_QR_URL || ''
const PAYMENT_INSTRUCTIONS = process.env.PAYMENT_INSTRUCTIONS || '请扫描二维码付款，完成后联系管理员确认开通'

// 检测是否已配置商户 API 模式
function isApiMode() {
  return !!(WECHAT_APPID && WECHAT_MCH_ID && WECHAT_API_KEY) ||
         !!(ALIPAY_APP_ID && ALIPAY_PRIVATE_KEY && process.env.ALIPAY_API_READY === 'true')
}

// 检测是否已配置收款码模式（API 模式优先）
function isQrMode() {
  return !isApiMode() && !!(WECHAT_QR_URL || ALIPAY_QR_URL)
}

// ========== VIP/积分套餐价格配置 ==========
const VIP_PLANS = {
  basic: { name: 'VIP 会员', price: 12.9, days: 30, credits: 500, level: 'basic' },
  yearly: { name: 'VIP 年费', price: 88, days: 365, credits: 5000, level: 'yearly' }
}

const ALL_PLANS = {
  basic: { name: 'VIP 会员', price: 12.9, days: 30, credits: 500, level: 'basic' },
  yearly: { name: 'VIP 年费', price: 88, days: 365, credits: 5000, level: 'yearly' },
  credits_10: { name: '10积分', price: 1, days: 0, credits: 10, level: 'credits_10' },
  credits_150: { name: '150积分', price: 10, days: 0, credits: 150, level: 'credits_150' },
  credits_500: { name: '500积分', price: 30, days: 0, credits: 500, level: 'credits_500' }
}

function getVipPlans() {
  return Object.entries(VIP_PLANS).map(([key, plan]) => ({
    id: key,
    ...plan
  }))
}

function getVipPlan(planId) {
  return VIP_PLANS[planId] || null
}

function getPlan(planId) {
  return ALL_PLANS[planId] || null
}

// ========== 微信支付下单（JSAPI/小程序支付 API + 收款码 + 开发模式三路降级）==========
async function createWechatOrder(pool, userId, planId, clientIp = '127.0.0.1') {
  const plan = getPlan(planId)
  if (!plan) throw new Error('无效的套餐')

  const outTradeNo = `WX${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`
  const totalFee = Math.round(plan.price * 100) // 微信支付用分

  // 在数据库中创建微信支付订单（状态: pending）
  await pool.query(
    `INSERT INTO payment_orders (order_no, user_id, plan_id, amount, provider, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'wechat', 'pending', NOW(), NOW())`,
    [outTradeNo, userId, planId, plan.price]
  )

  // 收款码模式：返回收款码图片 URL，用户扫码后联系管理员确认
  if (isQrMode() && WECHAT_QR_URL) {
    return { success: true, mode: 'qr', orderNo: outTradeNo, qrUrl: WECHAT_QR_URL, amount: plan.price, planName: plan.name, instructions: PAYMENT_INSTRUCTIONS }
  }

  // 开发模式：无商户配置时提示联系管理员
  if (!isApiMode() || !WECHAT_APPID || !WECHAT_MCH_ID || !WECHAT_API_KEY) {
    return { success: true, mode: 'dev', orderNo: outTradeNo, message: '支付服务未配置，请联系管理员手动开通VIP' }
  }

  // API 模式：调用微信支付统一下单接口
  const nonceStr = Math.random().toString(36).substring(2, 17)
  const params = {
    appid: WECHAT_APPID,
    mch_id: WECHAT_MCH_ID,
    nonce_str: nonceStr,
    body: `Extract ${plan.name}`,
    out_trade_no: outTradeNo,
    total_fee: totalFee,
    spbill_create_ip: clientIp,
    notify_url: WECHAT_NOTIFY_URL,
    trade_type: 'JSAPI'
  }

  // 签名
  params.sign = wechatSign(params, WECHAT_API_KEY)

  const xmlBody = objToXml(params)
  const response = await fetch('https://api.mch.weixin.qq.com/pay/unifiedorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xmlBody
  })

  const resultXml = await response.text()
  const result = xmlToObj(resultXml)

  if (result.return_code !== 'SUCCESS' || result.result_code !== 'SUCCESS') {
    throw new Error(result.err_code_des || result.return_msg || '微信支付下单失败')
  }

  // 返回小程序/JSAPI 支付所需的 prepay_id 和签名参数
  const payParams = {
    appId: WECHAT_APPID,
    timeStamp: String(Math.floor(Date.now() / 1000)),
    nonceStr: Math.random().toString(36).substring(2, 17),
    package: `prepay_id=${result.prepay_id}`,
    signType: 'MD5'
  }
  payParams.paySign = wechatSign(payParams, WECHAT_API_KEY)

  return {
    success: true,
    orderNo: outTradeNo,
    prepayId: result.prepay_id,
    payParams
  }
}

// ========== 支付宝支付下单（电脑网站支付/H5 + 收款码 + 开发模式降级）==========
async function createAlipayOrder(pool, userId, planId) {
  const plan = getPlan(planId)
  if (!plan) throw new Error('无效的套餐')

  const outTradeNo = `ALI${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`

  // 在数据库中创建支付宝订单（状态: pending）
  await pool.query(
    `INSERT INTO payment_orders (order_no, user_id, plan_id, amount, provider, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'alipay', 'pending', NOW(), NOW())`,
    [outTradeNo, userId, planId, plan.price]
  )

  // 收款码模式：返回支付宝收款码图片 URL
  if (isQrMode() && ALIPAY_QR_URL) {
    return { success: true, mode: 'qr', orderNo: outTradeNo, qrUrl: ALIPAY_QR_URL, amount: plan.price, planName: plan.name, instructions: PAYMENT_INSTRUCTIONS }
  }

  // 开发模式
  if (!isApiMode() || !ALIPAY_APP_ID || !ALIPAY_PRIVATE_KEY) {
    return { success: true, mode: 'dev', orderNo: outTradeNo, message: '支付服务未配置，请联系管理员手动开通VIP' }
  }

  // API 模式：构造支付宝页面支付参数（含 RSA2 签名）
  const bizContent = {
    out_trade_no: outTradeNo,
    product_code: 'FAST_INSTANT_TRADE_PAY',
    subject: `Extract ${plan.name}`,
    total_amount: plan.price.toFixed(2),
    timeout_express: '15m'
  }

  const params = {
    app_id: ALIPAY_APP_ID,
    method: 'alipay.trade.page.pay',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().replace(/T/, ' ').replace(/\..*/, ''),
    version: '1.0',
    return_url: 'https://abc.leesystem.xyz/vip',
    notify_url: ALIPAY_NOTIFY_URL,
    biz_content: JSON.stringify(bizContent)
  }

  params.sign = alipaySign(params, ALIPAY_PRIVATE_KEY)

  const queryString = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  return {
    success: true,
    orderNo: outTradeNo,
    paymentUrl: `https://openapi.alipay.com/gateway.do?${queryString}`
  }
}

// ========== 验证微信支付回调（解析 XML + 验签）==========
function verifyWechatCallback(xmlData) {
  const data = xmlToObj(xmlData)
  if (!data || data.return_code !== 'SUCCESS') return null

  // 验签
  const receivedSign = data.sign
  delete data.sign
  const calculatedSign = wechatSign(data, WECHAT_API_KEY)

  if (receivedSign !== calculatedSign) {
    console.error('微信支付回调验签失败')
    return null
  }

  return {
    orderNo: data.out_trade_no,
    transactionId: data.transaction_id,
    amount: parseFloat(data.total_fee) / 100,
    paidAt: data.time_end
  }
}

// ========== 验证支付宝回调（参数验签）==========
function verifyAlipayCallback(params) {
  const sign = params.sign
  delete params.sign
  delete params.sign_type

  const calculatedSign = alipaySign(params, ALIPAY_PRIVATE_KEY)

  if (sign !== calculatedSign) {
    console.error('支付宝回调验签失败')
    return null
  }

  return {
    orderNo: params.out_trade_no,
    transactionId: params.trade_no,
    amount: parseFloat(params.total_amount),
    paidAt: params.gmt_payment
  }
}

// ========== 激活 VIP/积分（回调或管理员确认后执行）==========
async function activateVip(pool, orderNo, provider, transactionId, amount) {
  // 查询订单
  const [orders] = await pool.query(
    'SELECT * FROM payment_orders WHERE order_no = ? AND status = ?',
    [orderNo, 'pending']
  )
  if (orders.length === 0) {
    console.error(`订单不存在或已处理: ${orderNo}`)
    return false
  }

  const order = orders[0]
  const plan = getPlan(order.plan_id)
  if (!plan) {
    console.error(`无效套餐: ${order.plan_id}`)
    return false
  }

  // 更新订单状态
  await pool.query(
    `UPDATE payment_orders SET status = 'paid', transaction_id = ?, paid_at = NOW(), updated_at = NOW()
     WHERE order_no = ?`,
    [transactionId, orderNo]
  )

  // 激活 VIP：如有现有 VIP 则在原到期时间上延长；积分套餐则仅加积分
  const [users] = await pool.query(
    'SELECT vip_level, vip_expired_at, credits_balance FROM app_users WHERE id = ? AND deleted_at IS NULL',
    [order.user_id]
  )
  if (users.length === 0) return false

  const user = users[0]
  const now = new Date()

  if (plan.days > 0) {
    // VIP 套餐：延长 VIP 有效期 + 赠送积分
    let baseDate = now
    if (user.vip_expired_at && new Date(user.vip_expired_at) > now) {
      baseDate = new Date(user.vip_expired_at)
    }
    const expiredAt = new Date(baseDate.getTime() + plan.days * 24 * 60 * 60 * 1000)

    await pool.query(
      `UPDATE app_users
       SET vip_level = ?, vip_expired_at = ?, vip_updated_at = NOW(),
           credits_balance = credits_balance + ?, updated_at = NOW()
       WHERE id = ?`,
      [plan.level, expiredAt, plan.credits, order.user_id]
    )
  } else {
    // 积分套餐：仅加积分
    await pool.query(
      `UPDATE app_users
       SET credits_balance = credits_balance + ?, updated_at = NOW()
       WHERE id = ?`,
      [plan.credits, order.user_id]
    )
  }

  // 记录积分交易
  await pool.query(
    `INSERT INTO credit_transactions (user_id, amount, type, description, created_at)
     VALUES (?, ?, 'recharge', ?, NOW())`,
    [order.user_id, plan.credits, `购买${plan.name}赠送${plan.credits}积分`]
  )

  console.log(`✅ VIP已激活: 用户${order.user_id}, ${plan.name}, 到期${expiredAt.toISOString()}`)
  return true
}

// ========== 管理员手动开通 VIP（开发模式/未配置支付时使用）==========
async function adminActivateVip(pool, userId, planId) {
  const plan = getVipPlan(planId)
  if (!plan) throw new Error('无效的套餐')

  const outTradeNo = `ADMIN${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`

  await pool.query(
    `INSERT INTO payment_orders (order_no, user_id, plan_id, amount, provider, status, transaction_id, paid_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'admin', 'paid', ?, NOW(), NOW(), NOW())`,
    [outTradeNo, userId, planId, plan.price, outTradeNo]
  )

  await activateVip(pool, outTradeNo, 'admin', outTradeNo, plan.price)
  return { success: true, orderNo: outTradeNo, plan: plan.name }
}

// ========== 辅助函数：微信签名/支付宝签名/XML 互转 ==========
function wechatSign(params, apiKey) {
  const sortedKeys = Object.keys(params).filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== '').sort()
  const stringA = sortedKeys.map(k => `${k}=${params[k]}`).join('&')
  const stringSignTemp = `${stringA}&key=${apiKey}`
  return crypto.createHash('md5').update(stringSignTemp, 'utf8').digest('hex').toUpperCase()
}

function alipaySign(params, privateKey) {
  const sortedKeys = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== '').sort()
  const content = sortedKeys.map(k => `${k}=${params[k]}`).join('&')
  let pemKey = privateKey
  if (!pemKey.includes('-----BEGIN')) {
    pemKey = `-----BEGIN RSA PRIVATE KEY-----\n${pemKey.match(/.{1,64}/g).join('\n')}\n-----END RSA PRIVATE KEY-----`
  }
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(content, 'utf8')
  return sign.sign({ key: pemKey, padding: crypto.constants.RSA_PKCS1_PADDING }, 'base64')
}

function objToXml(obj) {
  let xml = '<xml>'
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) {
      xml += `<${key}><![CDATA[${value}]]></${key}>`
    }
  }
  xml += '</xml>'
  return xml
}

function xmlToObj(xml) {
  const obj = {}
  const matches = xml.matchAll(/<(\w+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>/g)
  for (const m of matches) {
    obj[m[1]] = m[2]
  }
  // also match non-CDATA
  const simpleMatches = xml.matchAll(/<(\w+)>([^<]+)<\/\1>/g)
  for (const m of simpleMatches) {
    if (!(m[1] in obj)) obj[m[1]] = m[2]
  }
  return obj
}

function isPaymentConfigured() {
  return {
    apiMode: isApiMode(),
    qrMode: isQrMode(),
    wechatApi: !!(WECHAT_APPID && WECHAT_MCH_ID && WECHAT_API_KEY),
    alipayApi: !!(ALIPAY_APP_ID && ALIPAY_PRIVATE_KEY && process.env.ALIPAY_API_READY === 'true'),
    wechatQr: !!WECHAT_QR_URL,
    alipayQr: !!ALIPAY_QR_URL,
    any: isApiMode() || isQrMode()
  }
}

module.exports = {
  getVipPlans,
  getVipPlan,
  getPlan,
  createWechatOrder,
  createAlipayOrder,
  verifyWechatCallback,
  verifyAlipayCallback,
  activateVip,
  adminActivateVip,
  isPaymentConfigured
}
