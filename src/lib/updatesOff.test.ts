import { describe, expect, it } from "bun:test";
import { updatesState } from "./updatesOff.ts";

describe("what the health answer says about updates", () => {
  it("asks nothing until the answer is read", () => {
    expect(updatesState(null)).toBe("unknown");
  });
  it("is off only where the server says so", () => {
    expect(updatesState({ updates_off: true })).toBe("off");
    expect(updatesState({})).toBe("on");
    expect(updatesState({ updates_off: undefined })).toBe("on");
  });
});
