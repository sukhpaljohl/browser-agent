const http = require('http');

const data = JSON.stringify({
  prompt: 'navigate to iPhone',
  target: 'headless'
});

const req = http.request({
  hostname: '127.0.0.1',
  port: 3847,
  path: '/api/prompt',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('API Response:', body);
  });
});

req.on('error', e => console.error('Error:', e));
req.write(data);
req.end();
