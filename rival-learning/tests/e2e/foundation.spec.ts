import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

test("Profile confirmation, Session snapshot, reuse, duplicate, and retained history", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByLabel("名称").fill("Backend preparation");
  await page.getByLabel("目标岗位").fill("Backend Engineer");
  await page.getByLabel("职级").fill("Senior");
  await page
    .getByLabel("Resume")
    .fill("Email: candidate@example.com\nBuilt the original queue consumer and reduced failures by 35%.");
  await page.getByLabel("Project Notes (Markdown)").fill("# Payments\nProcessed 10M events.");
  await page.getByLabel("JD").fill("Own distributed backend services.");
  await page.getByRole("button", { name: "创建 Profile", exact: true }).click();

  await expect(page.getByRole("status")).toContainText("Profile 已创建");
  const providerViewPanel = page.locator("section").filter({
    has: page.getByRole("heading", { name: "ProviderView" }),
  });
  await expect(providerViewPanel).toContainText("[REDACTED_EMAIL]");
  await expect(providerViewPanel).toContainText("35%");
  await expect(providerViewPanel).toContainText("Processed 10M events");
  await expect(providerViewPanel).toContainText("Own distributed backend services");
  await expect(providerViewPanel).toContainText("Backend Engineer");
  await expect(providerViewPanel).toContainText("Senior");
  await expect(page.getByRole("button", { name: "创建 Session" })).toBeDisabled();

  await page.getByRole("button", { name: "确认 ProviderView" }).click();
  await expect(page.getByRole("status")).toContainText("ProviderView 已确认");
  await page.getByRole("button", { name: "创建 Session" }).click();

  await expect(page.getByRole("status")).toContainText("不可变 ProfileSnapshot");
  await expect(page.getByLabel("Session timeline")).toContainText("session_created");
  await page.getByRole("button", { name: "生成 Fake Plan" }).click();
  await expect(page.getByLabel("Session timeline")).toContainText("plan_generated");
  await page.getByRole("button", { name: "启动 Session" }).click();
  await expect(page.getByRole("status")).toContainText("Foundation Session 已启动");
  await expect(page.getByLabel("Session timeline")).toContainText("session_started");

  await page
    .getByLabel("Resume")
    .fill("Email: candidate@example.com\nBuilt the revised queue consumer and reduced failures by 40%.");
  await page.getByRole("button", { name: "保存 Profile" }).click();
  await expect(page.getByRole("status")).toContainText("重新确认 ProviderView");
  await expect(page.getByRole("button", { name: "创建 Session" })).toBeDisabled();
  await page.getByRole("button", { name: "确认 ProviderView" }).click();

  const originalCard = page.locator("article").filter({
    has: page.getByRole("button", { name: "选择 Backend preparation", exact: true }),
  });
  await originalCard.getByRole("button", { name: "复制" }).click();
  await expect(page.getByRole("status")).toContainText("副本已创建");
  await expect(page.getByRole("button", { name: "选择 Backend preparation (copy)" })).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("已有 1 个历史 Session");
    await dialog.accept();
  });
  await originalCard.getByRole("button", { name: "删除" }).click();
  await expect(page.getByRole("status")).toContainText("历史 Session snapshot 保持可读");
  await expect(
    page.getByRole("button", { name: "选择 Backend preparation", exact: true }),
  ).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Session history" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Backend preparation.*active/ })).toBeVisible();
});
