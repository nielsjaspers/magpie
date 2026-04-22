const MAX_MESSAGE_LEN = 3200;

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

interface FencedBlock {
	placeholder: string;
	lang: string;
	content: string;
}

interface InlineCode {
	placeholder: string;
	content: string;
}

export function convertMarkdownToTelegramHtml(text: string): string {
	let result = text;

	// 1. Extract fenced code blocks (must come before inline code)
	const fencedBlocks: FencedBlock[] = [];
	result = result.replace(/^```([^\n]*)\n([\s\S]*?)```$/gm, (_match, lang, code) => {
		const placeholder = `\uE000FENCED_${fencedBlocks.length}\uE001`;
		fencedBlocks.push({ placeholder, lang: lang.trim(), content: code });
		return placeholder;
	});

	// 2. Extract inline code
	const inlineCodes: InlineCode[] = [];
	result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
		const placeholder = `\uE002INLINE_${inlineCodes.length}\uE003`;
		inlineCodes.push({ placeholder, content: code });
		return placeholder;
	});

	// 3. Escape HTML in remaining text
	result = escapeHtml(result);

	// 4. Convert markdown to Telegram-supported HTML
	// Bold: **text**
	result = result.replace(/(?<!\*)\*\*(?!\*)(.+?)(?<!\*)\*\*(?!\*)/g, "<b>$1</b>");
	// Bold: __text__
	result = result.replace(/(?<!_)__(?!_)(.+?)(?<!_)__(?!_)/g, "<b>$1</b>");

	// Italic: *text*
	result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
	// Italic: _text_
	result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>");

	// Strikethrough: ~~text~~
	result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

	// Links: [text](url)
	result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
		return `<a href="${escapeHtml(url)}">${escapeHtml(linkText)}</a>`;
	});

	// Headings: # text -> bold line
	result = result.replace(/^#{1,6}\s+([^\n]+)$/gm, "<b>$1</b>");

	// Blockquotes: > text (handle line by line)
	result = result.replace(/^\s*&gt; ([^\n]+)$/gm, "<blockquote>$1</blockquote>");

	// 5. Restore inline code
	for (const { placeholder, content } of inlineCodes) {
		result = result.replace(placeholder, `<code>${escapeHtml(content)}</code>`);
	}

	// 6. Restore fenced code blocks
	for (const { placeholder, lang, content } of fencedBlocks) {
		const escaped = escapeHtml(content);
		if (lang) {
			result = result.replace(
				placeholder,
				`<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`,
			);
		} else {
			result = result.replace(placeholder, `<pre><code>${escaped}</code></pre>`);
		}
	}

	return result;
}

export function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LEN): string[] {
	if (text.length <= maxLen) return [text];

	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + maxLen, text.length);
		if (end < text.length) {
			const newlineIndex = text.lastIndexOf("\n", end);
			if (newlineIndex > start) {
				end = newlineIndex;
			}
		}
		chunks.push(text.slice(start, end));
		// Skip the newline if we split on it, to avoid leading newlines in next chunk
		if (end < text.length && text[end] === "\n") {
			start = end + 1;
		} else {
			start = end;
		}
	}
	return chunks;
}
