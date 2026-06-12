const crypto = require('crypto');
require('dotenv').config({path:'/root/VideoNote/Video-Backend/.env'});

const pk = process.env.ALIPAY_PRIVATE_KEY;

function toPem(key, type) {
  if (key.includes('-----BEGIN')) return key;
  const label = type === 'private' ? 'RSA PRIVATE KEY' : 'PUBLIC KEY';
  return '-----BEGIN ' + label + '-----\n' + key.match(/.{1,64}/g).join('\n') + '\n-----END ' + label + '-----\n';
}

const pemPrivate = toPem(pk, 'private');
const ownPub = crypto.createPublicKey(pemPrivate).export({type:'spki',format:'pem'});
console.log(ownPub);
