import { describe, expect, it, vi } from "vitest";
import type { SwitchRow } from "../shared/timeline";

vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: () => null }));
vi.mock("react-native", () => ({ Text: () => null, View: () => null }));

const { describeRow } = await import("./switch-row");

function row(partial: Partial<SwitchRow>): SwitchRow {
  return {
    family: "claude",
    from: "alice@example.com",
    to: "seat-a",
    reason: "pace",
    resetsAt: null,
    continued: false,
    continuedIn: null,
    toFamily: null,
    outcome: "switched",
    detail: null,
    at: "2026-11-10T12:00:00Z",
    ...partial,
  };
}

describe("the switch note", () => {
  it("says a pace move was to pace weekly usage", () => {
    expect(describeRow(row({}))).toBe("Moved from alice@example.com to seat-a to pace weekly usage.");
  });

  it("says why an agent is back on the default once pacing is off", () => {
    expect(describeRow(row({ reason: "pace_off", from: "seat-a", to: "alice@example.com" }))).toBe(
      "Back on alice@example.com, the default, now that weekly pacing is off.",
    );
  });

  it("says a move before the limit was because the account is nearly full", () => {
    expect(describeRow(row({ reason: "near_limit", from: "main", to: "seat" }))).toBe("main is nearly at its usage limit. Switched to seat.");
  });
});
