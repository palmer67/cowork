import { rmSync } from 'node:fs';

// 测试进程及其 git 子进程专用，不改用户配置。某些 Windows 文件系统上的
// init symlink 探测会留下 Node 无法 unlink 的 reparse 文件，使清理必然失败。
if (process.platform === 'win32') {
  const index = Number(process.env['GIT_CONFIG_COUNT'] ?? '0');
  process.env[`GIT_CONFIG_KEY_${index}`] = 'core.symlinks';
  process.env[`GIT_CONFIG_VALUE_${index}`] = 'false';
  process.env['GIT_CONFIG_COUNT'] = String(index + 1);
}

/**
 * 删除测试用的临时仓库。Windows 上 .git 里的对象/索引文件偶尔还被 git 或杀软短暂占用，
 * rmSync 会抛 ENOTEMPTY/EBUSY；重试几次让测试的退出码可信。
 */
export function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
