import { rmSync } from 'node:fs';

/**
 * 删除测试用的临时仓库。Windows 上 .git 里的对象/索引文件偶尔还被 git 或杀软短暂占用，
 * rmSync 会抛 ENOTEMPTY/EBUSY；重试几次让测试的退出码可信。
 */
export function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
