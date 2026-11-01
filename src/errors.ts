/** 退出码语义固定：见 AGENTS.md。 */
export const EXIT = {
  OK: 0,
  GENERAL: 1,
  BUSY: 2,
  ENV: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const LONG_PATH_HINT = '可开启 Windows 长路径支持，并确认 Git core.longpaths=true；也可将仓库移到更短的目录后重试。';

/** 不把 260 当作硬上限；只在操作实际失败后识别 OS/Git 的路径错误。 */
export function isLongPathFailure(err: unknown, paths: readonly string[] = [], platform = process.platform): boolean {
  const item = err as { code?: unknown; path?: unknown; message?: unknown; stderr?: unknown } | null;
  const text = `${String(item?.message ?? err)} ${String(item?.stderr ?? '')}`;
  if (item?.code === 'ENAMETOOLONG' || /ENAMETOOLONG|filename too long|file name too long|路径过长/i.test(text)) return true;
  const candidates = typeof item?.path === 'string' ? [...paths, item.path] : paths;
  return platform === 'win32' && (item?.code === 'ENOENT' || /\bENOENT\b/.test(text)) &&
    candidates.some((candidate) => candidate.length > 260);
}

export function pathError(err: unknown, ...paths: string[]): CoworkError | null {
  return isLongPathFailure(err, paths) ? new CoworkError(EXIT.ENV, `路径过长${paths.length === 0 ? '' : `: ${paths[0]}`}`, LONG_PATH_HINT) : null;
}

/** 带退出码的错误。消息必须说明「谁占着」和「怎么解决」。 */
export class CoworkError extends Error {
  readonly code: ExitCode;
  readonly hint: string | undefined;

  constructor(code: ExitCode, message: string, hint?: string) {
    // 上层包装错误时仍保留 ENAMETOOLONG/Git filename-too-long 的统一退出语义。
    const tooLong = isLongPathFailure({ message });
    super(tooLong ? `路径过长（${message}）` : message);
    this.name = 'CoworkError';
    this.code = tooLong ? EXIT.ENV : code;
    this.hint = tooLong ? LONG_PATH_HINT : hint;
  }
}

export function general(message: string, hint?: string): CoworkError {
  return new CoworkError(EXIT.GENERAL, message, hint);
}

export function busy(message: string, hint?: string): CoworkError {
  return new CoworkError(EXIT.BUSY, message, hint);
}

export function env(message: string, hint?: string): CoworkError {
  return new CoworkError(EXIT.ENV, message, hint);
}
