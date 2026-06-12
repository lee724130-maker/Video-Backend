const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
console.log('ALIPAY_APP_ID:', process.env.ALIPAY_APP_ID || 'NOT SET');
console.log('ALIPAY_PRIVATE_KEY set:', !!process.env.ALIPAY_PRIVATE_KEY);
console.log('alipayApi:', !!(process.env.ALIPAY_APP_ID && process.env.ALIPAY_PRIVATE_KEY));
