import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT) || 3000;
const modulesPath = path.resolve(__dirname, 'node_modules');

app.use('/tesseract', express.static(path.join(modulesPath, 'tesseract.js', 'dist')));
app.use('/tesseract-core', express.static(path.join(modulesPath, 'tesseract.js-core')));
app.use('/tessdata', express.static(path.join(modulesPath, '@tesseract.js-data', 'rus', '4.0.0_best_int')));

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
  });
}

startServer();
