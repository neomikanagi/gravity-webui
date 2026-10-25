'use strict';
const crypto=require('node:crypto');
// Public request-encryption key from libgbus.so (cs.d); not a login secret.
const PUBLIC_KEY='MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA1RkoPhcnXkqpklU9uCtQocKqZrFOlYnUbRP1Zc1Xmjl+zHTKEkfRfhRU80/Zqr0FdO78dAkExMBGZ1+8MMkmtvYFskpFIWPXBdtcWxlx13L5d1+31T+GUg4X1xqn+jidzXwR4pMaYE68hKGHGcjDhBpM8JPxYSrjtvhPA3MWHo80SKIQzXqgShNPNPx1EcDRYTeYliGZg41AeNAqCbB6CEVsa4CV4ZrvBh6tY1DL95YOA6IwMazczg9zMFM5ntAwgaKTrOmKpsF1omcvuSnooD4EE367xfTuM9D5ADRT7FRWrtO5lvAsMXXftR1HIum0dmfPV9dWCVthd4EKFQ16A1NoUeBG8nQ5i+qZUcm76MqY/IaPAlRq/7j8ukpXg4vEBYzFZ/PDYQS/+rdQ3UxmnlO/w47ZrLLJV5qZOh/NriRhVWEZ3E941gbEjuh69dIV0iM3MvPFHwti5QG86NsobEIIM6O2VfScljrWUxnyLmfD8zroHIwxOJc4kZdO0HUbpwoqTq78vi/4LzkC/Hyh89VYYJ+XQSE1jCsi51R+lxRP18a5zX6NxmRYCCEyYDeyfel0MKkoTkcqasuyChIipmQ+cIHa1rR46Kaxeey2tEkHSPaR6pJwPd56S1KZvtjUvqrHdNuv/G9rLa32PRsVhUP6j+2fecmQfr6MwP9H4EcCAwEAAQ==';
const DEFAULT_PUBLIC_KEY=crypto.createPublicKey({key:Buffer.from(PUBLIC_KEY,'base64'),format:'der',type:'spki'});
const randomKey=()=>Buffer.from(crypto.randomUUID().replace(/-/g,'').slice(0,16),'utf8');
function aesEncrypt(data,key){const padded=Buffer.alloc(Math.ceil(data.length/16)*16);data.copy(padded);
 const cipher=crypto.createCipheriv('aes-128-cbc',key,key);cipher.setAutoPadding(false);return Buffer.concat([cipher.update(padded),cipher.final()]);}
function encryptRequest(params,{publicKey=DEFAULT_PUBLIC_KEY,responseKey=randomKey(),envelopeKey=randomKey()}={}){
 const data=aesEncrypt(Buffer.from(JSON.stringify({...params,secret_key:responseKey.toString('utf8')})),envelopeKey);
 const key=crypto.publicEncrypt({key:publicKey,padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(envelopeKey.toString('base64')));
 return {body:Buffer.from(JSON.stringify({data:data.toString('base64'),key:key.toString('base64')})).toString('base64'),responseKey};
}
function decryptResponse(body,key){const text=body.toString('utf8').trim();if(text.startsWith('{'))return text;
 if(!/^[A-Za-z0-9+/]+={0,2}$/.test(text))throw Error('invalid_encrypted_response');const data=Buffer.from(text,'base64');
 if(!data.length||data.length%16)throw Error('invalid_encrypted_response');
 const cipher=crypto.createDecipheriv('aes-128-cbc',key,key);cipher.setAutoPadding(false);
 return Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8').replace(/\0+$/,'');
}
module.exports={encryptRequest,decryptResponse,aesEncrypt};
