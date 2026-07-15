const express = require('express');

const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

function start() {
  app.listen(PORT, () => {
    console.log(`render-service listening on ${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
