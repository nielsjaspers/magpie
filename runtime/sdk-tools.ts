import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";

const BUILT_IN_TOOL_FACTORIES: Record<string, (cwd: string) => unknown> = {
	read: createReadTool,
	bash: createBashTool,
	edit: createEditTool,
	write: createWriteTool,
	grep: createGrepTool,
	find: createFindTool,
	ls: createLsTool,
};

function getToolName(tool: unknown): string | undefined {
	if (!tool || typeof tool !== "object") return undefined;
	const name = (tool as { name?: unknown }).name;
	return typeof name === "string" && name.trim().length > 0 ? name : undefined;
}

export function isBuiltInToolName(name: string): boolean {
	return Object.hasOwn(BUILT_IN_TOOL_FACTORIES, name);
}

export function createBuiltInToolsForNames(cwd: string, toolNames: string[]): unknown[] {
	return toolNames.map((name) => {
		const factory = BUILT_IN_TOOL_FACTORIES[name];
		if (!factory) throw new Error(`Unknown built-in Pi tool: ${name}`);
		return factory(cwd);
	});
}

export function resolveToolsForNames(cwd: string, toolNames: string[], availableTools: unknown[] = []): unknown[] {
	const availableByName = new Map<string, unknown>();
	for (const tool of availableTools) {
		const name = getToolName(tool);
		if (name && !availableByName.has(name)) availableByName.set(name, tool);
	}

	const unknown: string[] = [];
	const resolved = toolNames.map((name) => {
		const available = availableByName.get(name);
		if (available) return available;
		const factory = BUILT_IN_TOOL_FACTORIES[name];
		if (factory) return factory(cwd);
		unknown.push(name);
		return undefined;
	});

	if (unknown.length > 0) {
		throw new Error(`Unknown Pi tool${unknown.length === 1 ? "" : "s"} requested: ${unknown.join(", ")}`);
	}

	return resolved as unknown[];
}
