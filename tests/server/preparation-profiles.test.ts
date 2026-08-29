import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPreparationProfiles,
  ProfileNotFoundError,
  ProfileValidationError,
  ProviderViewNotConfirmedError,
  type PreparationProfiles,
} from "@/server/preparation-profiles";
import { migrateDatabase } from "@/server/persistence/migrate";

describe("PreparationProfiles interface", () => {
  let directory: string;
  let profiles: PreparationProfiles;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rival-learning-profiles-"));
    const databasePath = join(directory, "app.db");
    migrateDatabase(databasePath);
    profiles = createPreparationProfiles({
      databasePath,
      createId: (() => {
        let sequence = 0;
        return () => `id-${++sequence}`;
      })(),
      now: () => new Date("2026-08-27T08:00:00.000Z"),
    });
  });

  afterEach(() => {
    profiles.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects a profile without target role and level", () => {
    expect(() =>
      profiles.create({
        name: "Backend preparation",
        resume: "Built a queue consumer",
        projectNotes: "",
        jobDescription: "Backend role",
        targetRole: "",
        targetLevel: "",
        repoPath: null,
      }),
    ).toThrow(ProfileValidationError);

    try {
      profiles.create({
        name: "Backend preparation",
        resume: "Built a queue consumer",
        projectNotes: "",
        jobDescription: "Backend role",
        targetRole: "",
        targetLevel: "",
        repoPath: null,
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "profile_validation_failed",
        fields: ["targetLevel", "targetRole"],
      });
    }
  });

  it("requires either Resume or Project Notes", () => {
    expect(() =>
      profiles.create({
        name: "Backend preparation",
        resume: "  ",
        projectNotes: "",
        jobDescription: "Backend role",
        targetRole: "Backend Engineer",
        targetLevel: "Senior",
        repoPath: null,
      }),
    ).toThrow(ProfileValidationError);
  });

  it("applies the same typed validation to updates without changing stored data", () => {
    const profile = profiles.create({
      name: "Backend preparation",
      resume: "Built a queue consumer",
      projectNotes: "",
      jobDescription: "Backend role",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    });

    expect(() =>
      profiles.update(profile.id, {
        ...profile,
        resume: "",
        projectNotes: "",
        targetRole: "",
      }),
    ).toThrow(ProfileValidationError);
    expect(profiles.get(profile.id)).toEqual(profile);
  });

  it("creates and lists a reusable PreparationProfile", () => {
    const created = profiles.create({
      name: "Backend preparation",
      resume: "Built a queue consumer",
      projectNotes: "# Payments\nReduced timeout failures",
      jobDescription: "Backend role",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    });

    expect(created).toMatchObject({
      id: "id-1",
      name: "Backend preparation",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      createdAt: "2026-08-27T08:00:00.000Z",
    });
    expect(profiles.list()).toEqual([created]);
    expect(profiles.get(created.id)).toEqual(created);
  });

  it("creates a deterministic line-preserving ProviderView that removes contact data", () => {
    const profile = profiles.create({
      name: "Zhang San",
      resume: [
        "Name: Zhang San",
        "Email: zhang.san@example.com",
        "Phone: +86 138 0013 8000",
        "Address: 88 Century Avenue, Shanghai",
        "GitHub: https://github.com/zhangsan",
        "Company: Acme Payments",
        "Built TypeScript services and reduced timeout failures by 35%.",
      ].join("\n"),
      projectNotes: "# Checkout\nProcessed 1000000000 events (10M daily) with Kafka.",
      jobDescription: "Senior Backend Engineer using TypeScript and Kafka.",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    });

    const first = profiles.previewProviderView(profile.id);
    const second = profiles.previewProviderView(profile.id);

    expect(second).toEqual(first);
    expect(first.redactionVersion).toBe("contact-v1");
    expect(first.confirmedAt).toBeNull();
    expect(first.content.resume.split("\n")).toHaveLength(profile.resume.split("\n").length);
    expect(JSON.stringify(first.content)).not.toContain("Zhang San");
    expect(JSON.stringify(first.content)).not.toContain("zhang.san@example.com");
    expect(JSON.stringify(first.content)).not.toContain("138 0013 8000");
    expect(JSON.stringify(first.content)).not.toContain("88 Century Avenue");
    expect(JSON.stringify(first.content)).not.toContain("github.com/zhangsan");
    expect(first.content.resume).toContain("Acme Payments");
    expect(first.content.resume).toContain("TypeScript");
    expect(first.content.resume).toContain("35%");
    expect(first.content.projectNotes).toContain("1000000000 events");
    expect(first.content.projectNotes).toContain("10M daily");
  });

  it("requires confirmation before creating an immutable ProfileSnapshot", () => {
    const profile = profiles.create({
      name: "Backend preparation",
      resume: "Email: candidate@example.com\nBuilt a queue consumer",
      projectNotes: "",
      jobDescription: "Backend role",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    });
    const preview = profiles.previewProviderView(profile.id);

    expect(() => profiles.createSnapshot(profile.id)).toThrow(ProviderViewNotConfirmedError);

    const confirmed = profiles.confirmProviderView(profile.id);
    const snapshot = profiles.createSnapshot(profile.id);

    expect(confirmed.confirmedAt).toBe("2026-08-27T08:00:00.000Z");
    expect(snapshot).toEqual({
      profile,
      providerView: preview.content,
      redactionVersion: "contact-v1",
      capturedAt: "2026-08-27T08:00:00.000Z",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.profile)).toBe(true);
    expect(Object.isFrozen(snapshot.providerView)).toBe(true);
  });

  it("invalidates confirmation when provider-visible material changes without mutating old snapshots", () => {
    const originalInput = {
      name: "Backend preparation",
      resume: "Built the original queue consumer",
      projectNotes: "",
      jobDescription: "Backend role",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    };
    const profile = profiles.create(originalInput);
    profiles.previewProviderView(profile.id);
    profiles.confirmProviderView(profile.id);
    const originalSnapshot = profiles.createSnapshot(profile.id);

    profiles.update(profile.id, {
      ...originalInput,
      resume: "Built the revised queue consumer",
    });

    expect(profiles.previewProviderView(profile.id).confirmedAt).toBeNull();
    expect(() => profiles.createSnapshot(profile.id)).toThrow(ProviderViewNotConfirmedError);
    expect(originalSnapshot.profile.resume).toBe("Built the original queue consumer");

    profiles.confirmProviderView(profile.id);
    const confirmedInput = profiles.get(profile.id);
    profiles.update(profile.id, {
      name: confirmedInput.name,
      resume: confirmedInput.resume,
      projectNotes: confirmedInput.projectNotes,
      jobDescription: confirmedInput.jobDescription,
      targetRole: confirmedInput.targetRole,
      targetLevel: confirmedInput.targetLevel,
      repoPath: confirmedInput.repoPath,
    });
    expect(profiles.createSnapshot(profile.id).providerView.resume).toContain("revised");
  });

  it("duplicates a Profile as an unconfirmed independent identity and deletes only the source", () => {
    const original = profiles.create({
      name: "Backend preparation",
      resume: "Built a queue consumer",
      projectNotes: "",
      jobDescription: "Backend role",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    });
    profiles.previewProviderView(original.id);
    profiles.confirmProviderView(original.id);

    const duplicate = profiles.duplicate(original.id);

    expect(duplicate).toMatchObject({
      id: "id-3",
      name: "Backend preparation (copy)",
      resume: original.resume,
      targetRole: original.targetRole,
    });
    expect(profiles.previewProviderView(duplicate.id).confirmedAt).toBeNull();

    profiles.delete(original.id);

    expect(() => profiles.get(original.id)).toThrow(ProfileNotFoundError);
    expect(profiles.list()).toEqual([duplicate]);
  });
});
