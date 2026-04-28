import { dirname, resolve } from "node:path";
import type { ScheduleEntry, ScheduleRuntimeOptions, ScheduleStore } from "./types.js";

const SCHEDULE_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const COMMON_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const NODE_MIN_MAJOR = 22;

export function shellEscape(value: string) {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function createPiCommand(entry: ScheduleEntry, piCommand: string, runtime: ScheduleRuntimeOptions, extensionPaths: string[]): string {
	const args = [
		shellEscape(piCommand),
		"--print",
		`--session-dir \"$SESSION_DIR\"`,
	];
	if (runtime.extensionMode === "magpie") {
		args.push("--no-extensions");
		for (const extensionPath of extensionPaths) args.push(`--extension ${shellEscape(extensionPath)}`);
	} else {
		args.push(`--tools ${shellEscape(SCHEDULE_BUILTIN_TOOLS.join(","))}`);
	}
	if (runtime.model) args.push(`--model ${shellEscape(runtime.model)}`);
	if (runtime.thinkingLevel) args.push(`--thinking ${shellEscape(runtime.thinkingLevel)}`);
	if (runtime.systemPrompt?.text) {
		const flag = runtime.systemPrompt.strategy === "replace" ? "--system-prompt" : "--append-system-prompt";
		args.push(`${flag} ${shellEscape(runtime.systemPrompt.text)}`);
	}
	args.push(shellEscape(entry.task));
	return args.join(" ");
}

function createNotificationScript(entry: ScheduleEntry, runtime: ScheduleRuntimeOptions): string {
	if (!entry.notify || runtime.notifier.kind === "none") return "";
	if (runtime.notifier.kind === "macos") {
		return `
if command -v osascript >/dev/null 2>&1; then
  SUMMARY="$(head -c 200 "$RESULT_PATH" 2>/dev/null | tr '\n' ' ' | tr '\r' ' ' || true)"
  MAGPIE_NOTIFY_TITLE=${shellEscape("Magpie")} \\
  MAGPIE_NOTIFY_SUBTITLE=${shellEscape(`Scheduled task ${entry.id} complete`)} \\
  MAGPIE_NOTIFY_MESSAGE="$SUMMARY" \\
  osascript <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run
  set ttl to system attribute "MAGPIE_NOTIFY_TITLE"
  set sub to system attribute "MAGPIE_NOTIFY_SUBTITLE"
  set msg to system attribute "MAGPIE_NOTIFY_MESSAGE"
  display notification msg with title ttl subtitle sub
end run
APPLESCRIPT
fi
`;
	}
	return `
if command -v curl >/dev/null 2>&1; then
  TELEGRAM_HEADER=${shellEscape(`Magpie schedule ${entry.id} completed ($EXIT_CODE)\nTask: ${entry.task}\nCwd: ${entry.cwd}\n\n`)}
  TELEGRAM_BODY="$(head -c 3500 "$RESULT_PATH" 2>/dev/null || true)"
  TELEGRAM_TEXT="\${TELEGRAM_HEADER}\${TELEGRAM_BODY}"
  curl -sS -X POST ${shellEscape(`https://api.telegram.org/bot${runtime.notifier.botToken}/sendMessage`)} \\
    --data-urlencode ${shellEscape(`chat_id=${runtime.notifier.chatId}`)} \\
    --data-urlencode "text=$TELEGRAM_TEXT" \\
    --data-urlencode "parse_mode=HTML" \\
    >/dev/null 2>&1 || true
fi
`;
}

function createIndexUpdateScript(store: ScheduleStore, entry: ScheduleEntry) {
	return `
${shellEscape(process.execPath)} <<'NODE' >/dev/null 2>&1 || true
const fs = require('node:fs');
const path = ${JSON.stringify(store.indexPath)};
const entryId = ${JSON.stringify(entry.id)};
const run = {
  startedAt: process.env.MAGPIE_RUN_STARTED_AT,
  endedAt: process.env.MAGPIE_RUN_ENDED_AT,
  exitCode: Number(process.env.MAGPIE_RUN_EXIT_CODE),
  resultPath: process.env.MAGPIE_RUN_RESULT_PATH,
  statePath: process.env.MAGPIE_RUN_STATE_PATH,
  sessionDir: process.env.MAGPIE_RUN_SESSION_DIR,
};
try {
  const entries = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!Array.isArray(entries)) process.exit(0);
  const idx = entries.findIndex((item) => item && item.id === entryId);
  if (idx < 0) process.exit(0);
  const current = entries[idx] || {};
  const runs = Array.isArray(current.runs) ? current.runs : [];
  runs.push(run);
  current.runs = runs;
  current.resultPath = run.resultPath;
  current.statePath = run.statePath;
  current.sessionDir = run.sessionDir;
  entries[idx] = current;
  fs.writeFileSync(path, JSON.stringify(entries, null, 2) + '\n', 'utf8');
} catch {}
NODE
`;
}

function createNodeVersionBootstrapScript() {
	return `
# pi currently depends on Node.js >= ${NODE_MIN_MAJOR} (pi-tui uses modern RegExp flags).
# Cron often has a minimal PATH, so prefer the Node runtime that created this
# schedule, then common nvm/asdf/homebrew locations, and fail clearly if only an
# older system node is available.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  nvm use ${NODE_MIN_MAJOR} >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true
fi
for MAGPIE_NODE_DIR in \
  ${shellEscape(dirname(process.execPath))} \
  "$HOME/.nvm/versions/node/v${NODE_MIN_MAJOR}/bin" \
  $HOME/.nvm/versions/node/v${NODE_MIN_MAJOR}*/bin \
  "$HOME/.asdf/shims" \
  "/opt/homebrew/bin" \
  "/usr/local/bin"; do
  for MAGPIE_NODE_BIN in $MAGPIE_NODE_DIR/node; do
    [ -x "$MAGPIE_NODE_BIN" ] || continue
    MAGPIE_NODE_MAJOR="$($MAGPIE_NODE_BIN -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    if [ "$MAGPIE_NODE_MAJOR" -ge ${NODE_MIN_MAJOR} ] 2>/dev/null; then
      export PATH="$(dirname "$MAGPIE_NODE_BIN"):$PATH"
      break 2
    fi
  done
done
MAGPIE_ACTIVE_NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if ! [ "$MAGPIE_ACTIVE_NODE_MAJOR" -ge ${NODE_MIN_MAJOR} ] 2>/dev/null; then
  {
    printf 'Scheduled task failed: pi requires Node.js >= ${NODE_MIN_MAJOR}, but cron resolved node as: %s (%s)\\n' "$(command -v node || echo not-found)" "$(node -v 2>/dev/null || echo unavailable)"
    printf 'Install Node.js >= ${NODE_MIN_MAJOR} for the cron user or ensure ~/.nvm/nvm.sh can select it.\\n'
  } | tee -a "\${RESULT_PATH:-/dev/stdout}"
  exit 1
fi
`;
}

export function createRunnerScript(store: ScheduleStore, entry: ScheduleEntry, piCommand: string, runtime: ScheduleRuntimeOptions, extensionPaths: string[]): string {
	const runtimeNodeDir = dirname(process.execPath);
	const inheritedPath = process.env.PATH || "";
	const runnerPath = [runtimeNodeDir, inheritedPath, ...COMMON_PATHS].filter(Boolean).join(":");
	const cleanup = entry.type === "one-shot" && entry.backend === "cron_fallback" && entry.cronId
		? `
if command -v crontab >/dev/null 2>&1; then
  TMP_CRON="$(mktemp)"
  (crontab -l 2>/dev/null || true) | grep -v ${shellEscape(`# ${entry.cronId}`)} > "$TMP_CRON"
  crontab "$TMP_CRON" || true
  rm -f "$TMP_CRON"
fi
`
		: "";
	const piInvocation = createPiCommand(entry, piCommand, runtime, extensionPaths);
	const notify = createNotificationScript(entry, runtime);
	const updateIndex = createIndexUpdateScript(store, entry);
	return `#!/usr/bin/env bash
set -euo pipefail
export PATH=${shellEscape(runnerPath)}
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
RESULT_DIR=${shellEscape(resolve(store.resultsDir, entry.id))}
SESSION_ROOT=${shellEscape(runtime.sessionRootDir)}
RESULT_PATH="$RESULT_DIR/$RUN_STAMP.result.md"
STATE_PATH="$RESULT_DIR/$RUN_STAMP.state"
SESSION_DIR="$SESSION_ROOT/$RUN_STAMP"
mkdir -p "$RESULT_DIR" "$SESSION_DIR"
printf 'startedAt=%s\nresultPath=%s\nsessionDir=%s\n' "$STARTED_AT" "$RESULT_PATH" "$SESSION_DIR" > "$STATE_PATH"
${createNodeVersionBootstrapScript()}
${cleanup}
EXIT_CODE=0
if ! cd ${shellEscape(entry.cwd)}; then
  printf 'Scheduled task failed: cwd does not exist: %s\n' ${shellEscape(entry.cwd)} > "$RESULT_PATH"
  EXIT_CODE=1
else
  set +e
  ${piInvocation} > "$RESULT_PATH" 2>&1
  EXIT_CODE=$?
  set -e
fi
ENDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'startedAt=%s\nendedAt=%s\nexitCode=%s\nresultPath=%s\nsessionDir=%s\n' "$STARTED_AT" "$ENDED_AT" "$EXIT_CODE" "$RESULT_PATH" "$SESSION_DIR" > "$STATE_PATH"
export MAGPIE_RUN_STARTED_AT="$STARTED_AT"
export MAGPIE_RUN_ENDED_AT="$ENDED_AT"
export MAGPIE_RUN_EXIT_CODE="$EXIT_CODE"
export MAGPIE_RUN_RESULT_PATH="$RESULT_PATH"
export MAGPIE_RUN_STATE_PATH="$STATE_PATH"
export MAGPIE_RUN_SESSION_DIR="$SESSION_DIR"
${updateIndex}
${notify}
exit "$EXIT_CODE"
`;
}
