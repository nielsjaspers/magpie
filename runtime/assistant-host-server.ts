import { buildRemoteWebUiRoutes } from "../remote/index.js";
import { startWebUiServer } from "../webui/server.js";

const cwd = process.cwd();
const { hostname, port } = await startWebUiServer(cwd, undefined, buildRemoteWebUiRoutes());
console.log(`Assistant host listening on http://${hostname}:${port}`);
