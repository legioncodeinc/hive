export class DaemonAlreadyRunningError extends Error {
  readonly pid: number;
  readonly lockFilePath: string;

  constructor(pid: number, lockFilePath: string) {
    super(`thehive is already running (pid ${pid}) and holds lock ${lockFilePath}`);
    this.name = "DaemonAlreadyRunningError";
    this.pid = pid;
    this.lockFilePath = lockFilePath;
  }
}
