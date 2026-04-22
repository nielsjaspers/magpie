export interface PreferenceEntry {
	id: string;
	content: string;
	createdAt: string;
	source: "user" | "auto";
	category?: string;
	active: boolean;
}
