/**
 * problem-service 用構造化ロガー
 *
 * pino と同じ API パターンで、サービス名・ログレベル付きの構造化ログを出力する。
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

function getConfiguredLevel(): LogLevel {
	const envLevel = process.env.LOG_LEVEL?.toLowerCase();
	if (envLevel && envLevel in LOG_LEVEL_PRIORITY) {
		return envLevel as LogLevel;
	}
	return "info";
}

interface Logger {
	debug: (msgOrObj: string | Record<string, unknown>, msg?: string) => void;
	info: (msgOrObj: string | Record<string, unknown>, msg?: string) => void;
	warn: (msgOrObj: string | Record<string, unknown>, msg?: string) => void;
	error: (msgOrObj: string | Record<string, unknown>, msg?: string) => void;
}

function shouldLog(level: LogLevel): boolean {
	const configuredLevel = getConfiguredLevel();
	return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[configuredLevel];
}

function formatMessage(
	name: string,
	level: LogLevel,
	msgOrObj: string | Record<string, unknown>,
	msg?: string,
): string {
	const timestamp = new Date().toISOString();
	if (typeof msgOrObj === "string") {
		return `${timestamp} [${level.toUpperCase()}] ${name}: ${msgOrObj}`;
	}
	const message = msg ?? "";
	return `${timestamp} [${level.toUpperCase()}] ${name}: ${message} ${JSON.stringify(msgOrObj)}`;
}

const consoleMethod: Record<
	LogLevel,
	keyof Pick<Console, "debug" | "info" | "warn" | "error">
> = {
	debug: "debug",
	info: "info",
	warn: "warn",
	error: "error",
};

export function createLogger(name: string): Logger {
	const log =
		(level: LogLevel) =>
		(msgOrObj: string | Record<string, unknown>, msg?: string) => {
			if (!shouldLog(level)) return;
			const formatted = formatMessage(name, level, msgOrObj, msg);
			console[consoleMethod[level]](formatted);
		};

	return {
		debug: log("debug"),
		info: log("info"),
		warn: log("warn"),
		error: log("error"),
	};
}
