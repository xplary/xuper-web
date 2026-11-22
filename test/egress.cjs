// Build-time smoke test. A local SOCKS listener rejects each connection after the greeting.
const assert = require('node:assert/strict');
const net = require('node:net');
const {spawn} = require('node:child_process');
const path = require('node:path');
const httpUrl = 'http://192.0.2.1:80/test';
let greetings = 0;
const proxy = net.createServer(socket => {
  socket.once('data', bytes => {
    if (bytes[0] === 5) greetings++;
    socket.end(Buffer.from([5,255]));
  });
  socket.on('error',()=>{});
});
async function check(command,args) {
  const before = greetings;
  const env = {...process.env,LD_PRELOAD:'libproxychains.so.4',PROXYCHAINS_CONF_FILE:path.resolve('proxychains.conf')};
  const child = spawn(command,args,{env,stdio:'ignore',timeout:6000});
  await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);});
  assert.ok(greetings > before,command+' did not connect through SOCKS5');
}
proxy.listen(1080,'127.0.0.1',async()=>{
  try {
    await check(process.execPath,['-e','fetch('+JSON.stringify(httpUrl)+').catch(()=>{})']);
    await check('ffmpeg',['-nostdin','-loglevel','error','-i',httpUrl,'-f','null','-']);
  } catch(err) {console.error(err);process.exitCode=1;}
  finally {proxy.close();}
});
