const http = require('http');
const handler = require('serve-handler');

const port = process.env.PORT || 8000;

const server = http.createServer((req, res) =>
  handler(req, res, { public: __dirname })
);

server.listen(port, () => {
  console.log(`Serving on http://localhost:${port}`);
});
