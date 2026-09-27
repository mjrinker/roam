import { describe, expect, it } from "vitest";
import { canEditExtended, canEditProfile, canManageAccount, canSelfManage } from "./roles";

describe("canManageAccount", () => {
  it("is true only for owner", () => {
    expect(canManageAccount({ role: "owner" })).toBe(true);
    expect(canManageAccount({ role: "admin" })).toBe(false);
    expect(canManageAccount({ role: "limited" })).toBe(false);
  });
});

describe("canSelfManage", () => {
  it("is true for owner and admin, false for limited", () => {
    expect(canSelfManage({ role: "owner" })).toBe(true);
    expect(canSelfManage({ role: "admin" })).toBe(true);
    expect(canSelfManage({ role: "limited" })).toBe(false);
  });
});

describe("canEditExtended", () => {
  it("owner can extend-edit anyone", () => {
    expect(canEditExtended({ id: "owner-1", role: "owner" }, "someone-else")).toBe(true);
  });
  it("admin can extend-edit only itself", () => {
    expect(canEditExtended({ id: "admin-1", role: "admin" }, "admin-1")).toBe(true);
    expect(canEditExtended({ id: "admin-1", role: "admin" }, "someone-else")).toBe(false);
  });
  it("limited can never extend-edit, even itself", () => {
    expect(canEditExtended({ id: "kid-1", role: "limited" }, "kid-1")).toBe(false);
  });
});

describe("canEditProfile", () => {
  it("owner can edit anyone; everyone can edit themselves", () => {
    expect(canEditProfile({ id: "owner-1", role: "owner" }, "someone-else")).toBe(true);
    expect(canEditProfile({ id: "kid-1", role: "limited" }, "kid-1")).toBe(true);
    expect(canEditProfile({ id: "kid-1", role: "limited" }, "someone-else")).toBe(false);
    expect(canEditProfile({ id: "admin-1", role: "admin" }, "someone-else")).toBe(false);
  });
});
