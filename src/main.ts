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

    const tilesetUrl = new URLSearchParams(window.location.search).get('tileset')
        || '/data/tiles/tileset.json';
    try {
        await engineSetup.loadTileset(tilesetUrl);
    } catch (e) {
        console.error('Tileset load failed:', tilesetUrl, e);
    }
    // Fallback: if no geometry (load failed or 0 instances), seed test instances so something renders
    engineSetup.seedTestInstancesIfEmpty();
}

bootstrap().catch(console.error);
