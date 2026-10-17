import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
import { renderToStaticMarkup } from "react-dom/server";
import { LabelsMenu } from "./labels-menu";
import { LabelActions } from "./label-actions";

describe("LabelsMenu", () => {
  it("is a Labels button, with how many labels the title has once it has any", () => {
    expect(renderToStaticMarkup(<LabelsMenu titleId="t1" />)).toContain("Labels");
    expect(renderToStaticMarkup(<LabelsMenu titleId="t1" />)).not.toContain("Labels ·");
    expect(renderToStaticMarkup(<LabelsMenu titleId="t1" initialCount={2} />)).toContain("Labels · 2");
  });
});

describe("LabelActions", () => {
  it("offers Rename and Delete", () => {
    const html = renderToStaticMarkup(<LabelActions serverId="s1" id="l1" name="Date night" />);
    expect(html).toContain("Rename");
    expect(html).toContain("Delete");
  });
});
