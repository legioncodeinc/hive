import {
  createExecFileWhoamiRunner,
  fallbackWindowsAccount,
  parseWhoamiSid,
  resolveWindowsUserId,
  whoamiExecutablePath,
  WINDOWS_SID_PATTERN,
  type WhoamiResult
} from "../../src/service/windows-identity.js";

describe("whoamiExecutablePath", () => {
  it("resolves whoami.exe under %SystemRoot%\\System32 so a git-bash whoami on PATH never shadows it", () => {
    expect(whoamiExecutablePath({ SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\whoami.exe");
  });

  it("falls back to C:\\Windows when SystemRoot is unset", () => {
    expect(whoamiExecutablePath({})).toBe("C:\\Windows\\System32\\whoami.exe");
  });
});

describe("parseWhoamiSid", () => {
  it("parses the SID from a quoted csv row", () => {
    expect(parseWhoamiSid('"CONTOSO\\mario","S-1-5-21-1111111111-2222222222-3333333333-1001"')).toBe(
      "S-1-5-21-1111111111-2222222222-3333333333-1001"
    );
  });

  it("takes the last non-empty line, defensively skipping a stray blank trailing line", () => {
    const stdout = '"CONTOSO\\mario","S-1-5-21-1-2-3-1001"\r\n\r\n';
    expect(parseWhoamiSid(stdout)).toBe("S-1-5-21-1-2-3-1001");
  });

  it("returns null for output that does not look like a SID", () => {
    expect(parseWhoamiSid('"CONTOSO\\mario","not-a-sid"')).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(parseWhoamiSid("")).toBeNull();
    expect(parseWhoamiSid("\r\n\r\n")).toBeNull();
  });

  it("WINDOWS_SID_PATTERN matches well-formed SIDs and rejects malformed ones", () => {
    expect(WINDOWS_SID_PATTERN.test("S-1-5-21-1111111111-2222222222-3333333333-1001")).toBe(true);
    expect(WINDOWS_SID_PATTERN.test("S-1-5")).toBe(false);
    expect(WINDOWS_SID_PATTERN.test("not-a-sid")).toBe(false);
  });
});

describe("fallbackWindowsAccount", () => {
  it("joins USERDOMAIN and USERNAME as domain\\user", () => {
    expect(fallbackWindowsAccount({ USERDOMAIN: "CONTOSO", USERNAME: "mario" })).toBe("CONTOSO\\mario");
  });

  it("returns null when USERDOMAIN is missing", () => {
    expect(fallbackWindowsAccount({ USERNAME: "mario" })).toBeNull();
  });

  it("returns null when USERNAME is missing", () => {
    expect(fallbackWindowsAccount({ USERDOMAIN: "CONTOSO" })).toBeNull();
  });

  it("returns null when either value is empty", () => {
    expect(fallbackWindowsAccount({ USERDOMAIN: "", USERNAME: "mario" })).toBeNull();
    expect(fallbackWindowsAccount({ USERDOMAIN: "CONTOSO", USERNAME: "" })).toBeNull();
  });
});

function fakeWhoamiRunner(result: WhoamiResult): (executable: string, args: readonly string[]) => Promise<WhoamiResult> {
  return () => Promise.resolve(result);
}

describe("resolveWindowsUserId", () => {
  it("resolves the SID when whoami.exe succeeds with parseable csv output", async () => {
    const userId = await resolveWindowsUserId({
      env: { SystemRoot: "C:\\Windows" },
      runWhoami: fakeWhoamiRunner({ ok: true, stdout: '"CONTOSO\\mario","S-1-5-21-1-2-3-1001"' })
    });

    expect(userId).toBe("S-1-5-21-1-2-3-1001");
  });

  it("falls back to domain\\user when whoami.exe fails (e.g. Access is denied or ENOENT)", async () => {
    const userId = await resolveWindowsUserId({
      env: { USERDOMAIN: "CONTOSO", USERNAME: "mario" },
      runWhoami: fakeWhoamiRunner({ ok: false, stdout: "" })
    });

    expect(userId).toBe("CONTOSO\\mario");
  });

  it("falls back to domain\\user when whoami.exe succeeds but the output does not parse as a SID", async () => {
    const userId = await resolveWindowsUserId({
      env: { USERDOMAIN: "CONTOSO", USERNAME: "mario" },
      runWhoami: fakeWhoamiRunner({ ok: true, stdout: "unexpected output" })
    });

    expect(userId).toBe("CONTOSO\\mario");
  });

  it("resolves to null (render without UserId) when neither the SID nor the fallback account is available", async () => {
    const userId = await resolveWindowsUserId({
      env: {},
      runWhoami: fakeWhoamiRunner({ ok: false, stdout: "" })
    });

    expect(userId).toBeNull();
  });

  it("invokes whoami.exe under %SystemRoot%\\System32 with /user /fo csv /nh via execFile args", async () => {
    let calledWith: { readonly executable: string; readonly args: readonly string[] } | null = null;
    await resolveWindowsUserId({
      env: { SystemRoot: "C:\\Windows" },
      runWhoami: (executable, args) => {
        calledWith = { executable, args };
        return Promise.resolve({ ok: true, stdout: '"CONTOSO\\mario","S-1-5-21-1-2-3-1001"' });
      }
    });

    expect(calledWith).toEqual({
      executable: "C:\\Windows\\System32\\whoami.exe",
      args: ["/user", "/fo", "csv", "/nh"]
    });
  });
});

describe("createExecFileWhoamiRunner", () => {
  it("returns a runner that reports failure instead of throwing when the executable cannot be found", async () => {
    const runner = createExecFileWhoamiRunner();
    const result = await runner("Z:\\does\\not\\exist\\whoami.exe", ["/user", "/fo", "csv", "/nh"]);

    expect(result.ok).toBe(false);
  });
});
