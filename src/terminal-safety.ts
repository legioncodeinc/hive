const TERMINAL_ESCAPE_OR_CONTROL = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)?)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

/** Strip control sequences from untrusted values before writing human terminal output. */
export function sanitizeTerminalText(value: unknown): string {
  return String(value).replace(TERMINAL_ESCAPE_OR_CONTROL, "");
}
