'use strict';

// Reconstructed from NF 6.5.8: j6.o0.y -> la.m.e -> la.m.c + la.a.b.
// This module prepares a request bean; it does not authorize a device/session.
var crypto = require('crypto');
var SALT = 'ntFT65w6itH!lHCPw7D=@qnsFC5adD28';
var PASSWORD_AES_KEY = 'ntFT65w6itH!lHCP';

function encodePassword(password) {
  if (typeof password !== 'string' || !password.trim()) {
    throw new Error('La contraseña no puede estar vacía');
  }
  password = password.trim();
  var digest = crypto.createHash('md5').update(password + SALT, 'utf8').digest('hex');
  var cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(PASSWORD_AES_KEY, 'utf8'), null);
  var encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]).toString('base64');
  // android.util.Base64.DEFAULT wraps at 76 characters; la.m.e trims the end.
  return digest + encrypted.match(/.{1,76}/g).join('\n');
}

function createLoginBean(credentials, macAddr) {
  if (!credentials || typeof credentials.userName !== 'string' || !credentials.userName.trim()) {
    throw new Error('La cuenta no puede estar vacía');
  }
  if (typeof macAddr !== 'string' || !macAddr) throw new Error('Falta la MAC del dispositivo');
  var name = credentials.userName.trim();
  return {
    accountType: name.indexOf('@') !== -1 ? '2' : (/^[0-9]+$/.test(name) ? '1' : '6'),
    areaCode: '', userName: name, password: encodePassword(credentials.password),
    macAddr: macAddr, verificationCode: ''
  };
}

module.exports = { encodePassword: encodePassword, createLoginBean: createLoginBean };
