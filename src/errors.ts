/** 退出码语义固定：见 AGENTS.md。 */
export const EXIT = {
  OK: 0,
  GENERAL: 1,
  BUSY: 2,
  ENV: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** 带退出码的错误。消息必须说明「谁占着」和「怎么解决」。 */
export class CoworkError extends Error {
  readonly code: ExitCode;
  readonly hint: string | undefined;

  constructor(code: ExitCode, message: string, hint?: string) {
    super(message);
    this.name = 'CoworkError';
    this.code = code;
    this.hint = hint;
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
