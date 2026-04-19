import { startWebUiServer } from "../webui/server.js";

const cwd = process.cwd();
const { runtime } = await startWebUiServer(cwd);
console.log(`Assistant host listening on ${runtime.hostUrl}`);
