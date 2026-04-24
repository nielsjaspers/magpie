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

export function createBuiltInToolsForNames(cwd: string, toolNames: string[]): unknown[] {
	return toolNames.map((name) => {
		const factory = BUILT_IN_TOOL_FACTORIES[name];
		if (!factory) throw new Error(`Unknown built-in Pi tool: ${name}`);
		return factory(cwd);
	});
}
