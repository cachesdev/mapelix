import { createServer } from "node:http";

const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Mapelix visual check</title></head>
  <body><main><h1>Mapelix</h1><p>Playwright smoke test</p></main></body>
</html>`;

createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}).listen(4173, "127.0.0.1", () => {
  console.log("Visual check listening on http://127.0.0.1:4173");
});
