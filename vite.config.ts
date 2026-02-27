import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';

const MODEL_DATA_DIR = 'C:/dev/models/1018/sot/sot';

export default defineConfig({
    server: {
        port: 3000,
        open: true,
        fs: {
            allow: [
                path.resolve(__dirname),
                'C:/dev/models',
            ],
        },
    },
    build: {
        target: 'esnext'
    },
    plugins: [
        {
            name: 'serve-model-data',
            configureServer(server) {
                server.middlewares.use('/data', (req, res, next) => {
                    const filePath = path.join(MODEL_DATA_DIR, req.url || '');
                    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                        const stat = fs.statSync(filePath);
                        const ext = path.extname(filePath).toLowerCase();
                        const mimeTypes: Record<string, string> = {
                            '.bin': 'application/octet-stream',
                            '.json': 'application/json',
                            '.glb': 'model/gltf-binary',
                        };
                        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
                        res.setHeader('Content-Length', String(stat.size));
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        fs.createReadStream(filePath).pipe(res);
                    } else {
                        next();
                    }
                });
            },
        },
    ],
});
