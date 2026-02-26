import './style.css';
import { EngineSetup } from './core/Engine';
import { HierarchyTreeView } from './plugins/HierarchyTreeView';
import { PropertyView } from './plugins/PropertyView';

async function bootstrap() {
    const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
    if (!canvas) throw new Error("Canvas not found");

    const engineSetup = new EngineSetup(canvas);
    await engineSetup.init();

    // Register UI plugins
    await engineSetup.registerPlugin(new HierarchyTreeView());
    await engineSetup.registerPlugin(new PropertyView());
}

bootstrap().catch(console.error);
