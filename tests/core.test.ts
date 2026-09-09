import { describe,it,expect } from "vitest";
import { parseUsd } from "../packages/core/src/money.js";
import { evaluateAction, type PolicyContext } from "../packages/policy/src/evaluate.js";
import type { ActionIntent } from "../packages/core/src/types.js";

describe("Exact USD",()=>{
  it("preserves microdollars and exact decimal sums",()=>{
    expect(parseUsd("0.1")+parseUsd("0.2")).toBe(parseUsd("0.3"));
    expect(parseUsd("999999999999.999999")).toBe(999999999999999999n);
    expect(parseUsd("0.000001")).toBe(1n);
  });
  it.each(["-1","NaN","Infinity","1e3","1.0000001","01","1.",".1","1000000000000"," 1"])("rejects malformed or unrepresentable %s",v=>expect(()=>parseUsd(v)).toThrow());
});
describe("Preliminary policy",()=>{
  const context:PolicyContext={companyStatus:"RUNNING",dailySpendRemainingUsd:"0.30",companyCapitalRemainingUsd:"200",allowedActionTypes:["read","buy"],registeredEffects:{read:"READ_ONLY",buy:"MONEY"},now:new Date("2026-09-08T01:00:00Z")};
  const action:ActionIntent={id:"a",agentId:"agent",actionType:"read",effectClass:"READ_ONLY",target:"internal",payload:{},businessRationale:"test",maxCostUsd:"0.30",expiresAt:"2026-09-09T00:00:00Z"};
  it("enforces an exact boundary",()=>{expect(evaluateAction(action,context).decision).toBe("ALLOW");expect(evaluateAction({...action,maxCostUsd:"0.300001"},context).decision).toBe("DENY");});
  it.each(["not-a-date","2026-02-30T00:00:00Z","2026-09-08T01:00:00Z","2026-09-10"])("denies invalid/expired timestamp %s",expiresAt=>expect(evaluateAction({...action,expiresAt},context).decision).toBe("DENY"));
  it("cannot downgrade a registered money tool to read-only",()=>expect(evaluateAction({...action,actionType:"buy"},context).decision).toBe("DENY"));
  it("kill overrides every preliminary action",()=>expect(evaluateAction(action,{...context,companyStatus:"KILLED"}).decision).toBe("DENY"));
});
