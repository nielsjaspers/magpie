export function setActiveModel(alias: string, ref: string): void {
	activeAlias = alias;
	activeRef = ref;
}

export function getActiveModel(): { alias: string; ref: string } {
	return { alias: activeAlias, ref: activeRef };
}

let activeAlias = "";
let activeRef = "";
