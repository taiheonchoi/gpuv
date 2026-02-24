import './style.css';
import { EngineSetup } from './core/Engine';

async function bootstrap() {
    const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
    if (!canvas) throw new Error("Canvas not found");

    const engineSetup = new EngineSetup(canvas);
    await engineSetup.init();
}

bootstrap().catch(console.error);
