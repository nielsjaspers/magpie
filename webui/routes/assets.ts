import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";

export interface StaticAssetRoute {
	pathname: string;
	filePath: string;
	contentType: string;
}

export function createStaticAssetRoutes(clientDir: string): StaticAssetRoute[] {
	return [
		{ pathname: "/", filePath: resolve(clientDir, "index.html"), contentType: "text/html; charset=utf-8" },
		{ pathname: "/enroll", filePath: resolve(clientDir, "enroll.html"), contentType: "text/html; charset=utf-8" },
		{ pathname: "/assets/app.js", filePath: resolve(clientDir, "app.js"), contentType: "text/javascript; charset=utf-8" },
		{ pathname: "/assets/css/style.css", filePath: resolve(clientDir, "css/style.css"), contentType: "text/css; charset=utf-8" },
	];
}

export async function serveStaticAsset(res: ServerResponse, route: StaticAssetRoute): Promise<void> {
	res.statusCode = 200;
	res.setHeader("content-type", route.contentType);
	res.end(await readFile(route.filePath, "utf8"));
}
