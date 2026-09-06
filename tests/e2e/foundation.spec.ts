import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

test("A2A Take Over path, refresh recovery, Profile reuse, and retained history", async ({
  page,
}) => {
  let sessionCreateRequest:
    | {
        body: { profileId?: string; sessionId?: string; interviewLanguage?: string };
        idempotencyKey?: string;
      }
    | undefined;
  let eventStreamRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/sessions") {
      sessionCreateRequest = {
        body: request.postDataJSON() as {
          profileId?: string;
          sessionId?: string;
          interviewLanguage?: string;
        },
        idempotencyKey: request.headers()["idempotency-key"],
      };
    }
    if (request.method() === "GET" && /\/api\/sessions\/[^/]+\/events$/.test(url.pathname)) {
      eventStreamRequests += 1;
    }
  });

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
  await page.getByLabel("面试语言").selectOption("zh-CN");
  await page.getByRole("button", { name: "创建 Session" }).click();

  await expect(page.getByRole("status")).toContainText("不可变 ProfileSnapshot");
  expect(sessionCreateRequest?.body.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(sessionCreateRequest?.idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  expect(sessionCreateRequest?.body.interviewLanguage).toBe("zh-CN");
  await expect.poll(() => eventStreamRequests).toBeGreaterThan(0);
  await expect(page.getByLabel("Session timeline")).toContainText("session_created");
  await page.getByRole("button", { name: "生成 InterviewPlan" }).click();
  await expect(page.getByLabel("Session timeline")).toContainText("interview_plan_generated");
  await page.getByRole("button", { name: "启动 Session" }).click();
  await expect(page.getByRole("status")).toContainText("Session 已启动并展示首题");
  await expect(page.getByLabel("Session timeline")).toContainText("session_started");
  await expect(page.getByText("这项成果中你亲自负责的范围是什么，哪项关键决策由你做出？")).toBeVisible();
  await expect(
    page.getByLabel("Session timeline").locator("li").filter({ hasText: "session_created" }),
  ).toHaveCount(1);
  await expect(
    page.getByLabel("Session timeline").locator("li").filter({ hasText: "interview_plan_generated" }),
  ).toHaveCount(1);
  await expect(
    page.getByLabel("Session timeline").locator("li").filter({ hasText: "question_presented" }),
  ).toHaveCount(1);
  await expect(
    page.getByLabel("Session timeline").locator("li").filter({ hasText: "session_started" }),
  ).toHaveCount(1);

  await page.getByRole("button", { name: "Candidate 回答", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Candidate 回答已保存");
  await expect(page.getByText(/我亲自负责迁移范围与回滚决策/)).toBeVisible();
  await page.getByRole("button", { name: "继续追问", exact: true }).click();
  await expect(page.getByText("你为什么选择幂等重试，而不是依赖一次性投递或人工补偿？")).toBeVisible();

  await page.getByRole("button", { name: "Take Over", exact: true }).click();
  await expect(page.getByText(/本链余下所有问题都由你回答/)).toBeVisible();
  await page.getByRole("button", { name: "确认 Take Over", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("余下问题均由你回答");
  await page
    .getByLabel("你的回答（Question 2）")
    .fill("我会比较重复处理风险、恢复时间和人工补偿成本，再用压测数据验证选择。");
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  await page.getByRole("button", { name: "继续追问", exact: true }).click();
  await expect(page.getByText("如果迁移指标开始恶化，你会依据哪些信号触发回滚？")).toBeVisible();
  await page
    .getByLabel("你的回答（Question 3）")
    .fill("如果重复率或尾延迟持续越过阈值，我会停止扩量并按预案回滚。");
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect(page.getByText("本条 AttackChain 已完成，transcript 现为只读。")).toBeVisible();
  await expect(page.getByText("Checkpoint 将在 Step 4 提供。")).toBeVisible();
  await expect(page.getByRole("button", { name: "Candidate 回答", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "继续追问", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Auto", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Hand Back", exact: true })).toHaveCount(0);

  const sessionTimeline = page.getByLabel("Session timeline");
  await expect(sessionTimeline.locator("li").filter({ hasText: "question_presented" })).toHaveCount(3);
  await expect(sessionTimeline.locator("li").filter({ hasText: "answer_recorded" })).toHaveCount(3);
  await expect(sessionTimeline.locator("li").filter({ hasText: "control_taken_over" })).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get("session")).toBe(
    sessionCreateRequest?.body.sessionId,
  );

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
  await expect(page.getByText("本条 AttackChain 已完成，transcript 现为只读。")).toBeVisible();
  await expect(page.getByText(/我亲自负责迁移范围与回滚决策/)).toBeVisible();
  await expect(page.getByText(/我会比较重复处理风险/)).toBeVisible();
  await expect(page.getByText(/如果重复率或尾延迟持续越过阈值/)).toBeVisible();
  await expect(page.getByLabel("Session timeline").locator("li").filter({ hasText: "question_presented" })).toHaveCount(3);
  await expect(page.getByLabel("Session timeline").locator("li").filter({ hasText: "answer_recorded" })).toHaveCount(3);

  await page.goto("/?session=missing-session");
  await expect(page.getByRole("status")).toContainText("无法恢复 URL 中的 Session");
  await expect(page.getByRole("button", { name: /Backend preparation.*active/ })).toBeVisible();
});
