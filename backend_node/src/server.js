require('dotenv').config();

const app = require('./app');

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '127.0.0.1';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

app.listen(port, host, () => {
  console.log(`Smart Campus API foundation listening on http://${host}:${port}`);
});
