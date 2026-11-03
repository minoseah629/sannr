import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
  if (req.url === '/hold') { writeFileSync(process.argv[2], 'received'); await new Promise(resolve => setTimeout(resolve, 250)); }
  let value;
  if (req.url === '/capture') value = { id: 'captured-value', path: 'fixture.txt', descriptor: { $file: { path: 'fixture.txt', encoding: 'utf8' } } };
  else if (req.url === '/multipart') {
    const boundary = /boundary=(.*)/.exec(req.headers['content-type'] ?? '')?.[1];
    value = { parts: text.split(`--${boundary}`).filter(part => part.includes('Content-Disposition:')).map(part => ({
      name: /name="([^"]+)"/.exec(part)?.[1], filename: /filename="([^"]+)"/.exec(part)?.[1] ?? null,
      type: /Content-Type: ([^\r\n]+)/i.exec(part)?.[1] ?? null,
      text: part.split('\r\n\r\n')[1]?.replace(/\r\n$/, ''),
    })) };
  } else if (req.url === '/digest') {
    const body = JSON.parse(text);
    const describe = value => typeof value === 'string' ? { length: value.length, sha256: createHash('sha256').update(value).digest('hex') }
      : Array.isArray(value) ? value.map(describe) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k, describe(v)])) : value;
    value = describe(body);
  } else value = JSON.parse(text || '{}');
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
});
server.listen(0, '127.0.0.1', () => process.send?.({ origin: `http://127.0.0.1:${server.address().port}` }));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
