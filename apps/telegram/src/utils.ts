const MAX_MESSAGE_LEN = 4000;

export function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LEN): string[] {
	if (text.length <= maxLen) return [text];

	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		chunks.push(text.slice(start, start + maxLen));
		start += maxLen;
	}
	return chunks;
}
