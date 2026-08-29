import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const preparationProfileInputSchema = z
  .object({
    name: z.string().trim().min(1),
    resume: z.string(),
    projectNotes: z.string(),
    jobDescription: z.string(),
    targetRole: z.string().trim().min(1),
    targetLevel: z.string().trim().min(1),
    repoPath: z.string().trim().min(1).nullable(),
  })
  .superRefine((value, context) => {
    if (!value.resume.trim() && !value.projectNotes.trim()) {
      context.addIssue({
        code: "custom",
        path: ["resumeOrProjectNotes"],
        message: "Resume or Project Notes is required",
      });
    }
  });

export type PreparationProfileInput = z.infer<typeof preparationProfileInputSchema>;

export interface PreparationProfile extends PreparationProfileInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderViewContent {
  resume: string;
  projectNotes: string;
  jobDescription: string;
  targetRole: string;
  targetLevel: string;
}

export interface ProviderView {
  id: string;
  profileId: string;
  sourceContentHash: string;
  redactionVersion: "contact-v1";
  content: ProviderViewContent;
  confirmedAt: string | null;
  createdAt: string;
}

export interface ProfileSnapshot {
  profile: PreparationProfile;
  providerView: ProviderViewContent;
  redactionVersion: "contact-v1";
  capturedAt: string;
}

export interface PreparationProfiles {
  create(input: PreparationProfileInput): PreparationProfile;
  update(id: string, input: PreparationProfileInput): PreparationProfile;
  duplicate(id: string): PreparationProfile;
  getDeletionImpact(id: string): { retainedSessionCount: number };
  delete(id: string): void;
  list(): PreparationProfile[];
  get(id: string): PreparationProfile;
  previewProviderView(id: string): ProviderView;
  confirmProviderView(id: string): ProviderView;
  createSnapshot(id: string): Readonly<ProfileSnapshot>;
  close(): void;
}

export interface PreparationProfilesOptions {
  databasePath: string;
  createId?: () => string;
  now?: () => Date;
}

export class ProfileValidationError extends Error {
  readonly code = "profile_validation_failed";

  constructor(readonly fields: string[]) {
    super(`Profile validation failed: ${fields.join(", ")}`);
    this.name = "ProfileValidationError";
  }
}

export class ProfileNotFoundError extends Error {
  readonly code = "profile_not_found";

  constructor(readonly profileId: string) {
    super(`PreparationProfile not found: ${profileId}`);
    this.name = "ProfileNotFoundError";
  }
}

export class ProviderViewNotConfirmedError extends Error {
  readonly code = "provider_view_not_confirmed";

  constructor(readonly profileId: string) {
    super(`ProviderView is not confirmed for PreparationProfile: ${profileId}`);
    this.name = "ProviderViewNotConfirmedError";
  }
}

interface ProfileRow {
  id: string;
  name: string;
  resume: string;
  project_notes: string;
  job_description: string;
  target_role: string;
  target_level: string;
  repo_path: string | null;
  created_at: number;
  updated_at: number;
}

interface ProviderViewRow {
  id: string;
  profile_id: string;
  source_content_hash: string;
  redaction_version: "contact-v1";
  content_json: string;
  confirmed_at: number | null;
  created_at: number;
}

function mapProfile(row: ProfileRow): PreparationProfile {
  return {
    id: row.id,
    name: row.name,
    resume: row.resume,
    projectNotes: row.project_notes,
    jobDescription: row.job_description,
    targetRole: row.target_role,
    targetLevel: row.target_level,
    repoPath: row.repo_path,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapProviderView(row: ProviderViewRow): ProviderView {
  return {
    id: row.id,
    profileId: row.profile_id,
    sourceContentHash: row.source_content_hash,
    redactionVersion: row.redaction_version,
    content: JSON.parse(row.content_json) as ProviderViewContent,
    confirmedAt: row.confirmed_at === null ? null : new Date(row.confirmed_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function redactContactData(text: string, profileName: string): string {
  return text
    .split("\n")
    .map((line) => {
      let redacted = line;

      if (/^\s*(name|姓名)\s*[:：]/i.test(redacted)) {
        redacted = redacted.replace(/([:：]).*$/, "$1 [REDACTED_NAME]");
      } else if (redacted.trim() === profileName.trim()) {
        redacted = redacted.replace(profileName, "[REDACTED_NAME]");
      }

      if (/^\s*(address|地址|住址|所在地|location)\s*[:：]/i.test(redacted)) {
        redacted = redacted.replace(/([:：]).*$/, "$1 [REDACTED_ADDRESS]");
      }

      redacted = redacted.replace(
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
        "[REDACTED_EMAIL]",
      );
      if (/^\s*(phone|tel|telephone|mobile|电话|手机)\s*[:：]/i.test(redacted)) {
        redacted = redacted.replace(/([:：]).*$/, "$1 [REDACTED_PHONE]");
      } else {
        redacted = redacted.replace(/\+\d[\d\s().-]{7,}\d/g, "[REDACTED_PHONE]");
      }
      redacted = redacted.replace(
        /https?:\/\/(?:www\.)?linkedin\.com\/\S+/gi,
        "[REDACTED_URL]",
      );
      redacted = redacted.replace(
        /https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/?(?=\s|$)/gi,
        "[REDACTED_URL]",
      );

      if (/^\s*(github|website|portfolio|主页|个人网站|联系链接)\s*[:：]/i.test(redacted)) {
        redacted = redacted.replace(/https?:\/\/\S+/gi, "[REDACTED_URL]");
      }

      return redacted;
    })
    .join("\n");
}

function freezeSnapshot(snapshot: ProfileSnapshot): Readonly<ProfileSnapshot> {
  Object.freeze(snapshot.profile);
  Object.freeze(snapshot.providerView);
  return Object.freeze(snapshot);
}

function contentHash(input: PreparationProfileInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name: input.name,
        resume: input.resume,
        projectNotes: input.projectNotes,
        jobDescription: input.jobDescription,
        targetRole: input.targetRole,
        targetLevel: input.targetLevel,
      }),
    )
    .digest("hex");
}

function parsePreparationProfileInput(input: PreparationProfileInput): PreparationProfileInput {
  const result = preparationProfileInputSchema.safeParse(input);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))]
      .filter(Boolean)
      .sort();
    throw new ProfileValidationError(fields);
  }
  return result.data;
}

class SqlitePreparationProfiles implements PreparationProfiles {
  private readonly database: Database.Database;
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(options: PreparationProfilesOptions) {
    this.database = new Database(options.databasePath);
    this.database.pragma("foreign_keys = ON");
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  create(input: PreparationProfileInput): PreparationProfile {
    const parsedInput = parsePreparationProfileInput(input);

    const id = this.createId();
    const timestamp = this.now();
    const profile: PreparationProfile = {
      id,
      ...parsedInput,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    };

    this.database
      .prepare(
        `insert into preparation_profiles
          (id, name, resume, project_notes, job_description, target_role, target_level, repo_path, content_hash, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.name,
        profile.resume,
        profile.projectNotes,
        profile.jobDescription,
        profile.targetRole,
        profile.targetLevel,
        profile.repoPath,
        contentHash(profile),
        timestamp.getTime(),
        timestamp.getTime(),
      );

    return profile;
  }

  update(id: string, input: PreparationProfileInput): PreparationProfile {
    this.get(id);
    const parsedInput = parsePreparationProfileInput(input);

    const previous = this.database
      .prepare("select content_hash from preparation_profiles where id = ?")
      .get(id) as { content_hash: string };
    const nextContentHash = contentHash(parsedInput);
    const updatedAt = this.now();

    this.database.transaction(() => {
      if (previous.content_hash !== nextContentHash) {
        this.database
          .prepare("update provider_views set confirmed_at = null where profile_id = ?")
          .run(id);
      }

      this.database
        .prepare(
          `update preparation_profiles
           set name = ?, resume = ?, project_notes = ?, job_description = ?, target_role = ?,
               target_level = ?, repo_path = ?, content_hash = ?, updated_at = ?
           where id = ?`,
        )
        .run(
          parsedInput.name,
          parsedInput.resume,
          parsedInput.projectNotes,
          parsedInput.jobDescription,
          parsedInput.targetRole,
          parsedInput.targetLevel,
          parsedInput.repoPath,
          nextContentHash,
          updatedAt.getTime(),
          id,
        );
    })();

    return this.get(id);
  }

  duplicate(id: string): PreparationProfile {
    const source = this.get(id);
    return this.create({
      name: `${source.name} (copy)`,
      resume: source.resume,
      projectNotes: source.projectNotes,
      jobDescription: source.jobDescription,
      targetRole: source.targetRole,
      targetLevel: source.targetLevel,
      repoPath: source.repoPath,
    });
  }

  getDeletionImpact(id: string): { retainedSessionCount: number } {
    this.get(id);
    const row = this.database
      .prepare("select count(*) as count from sessions where source_profile_id = ?")
      .get(id) as { count: number };
    return { retainedSessionCount: row.count };
  }

  delete(id: string): void {
    this.get(id);
    this.database.prepare("delete from preparation_profiles where id = ?").run(id);
  }

  list(): PreparationProfile[] {
    const rows = this.database
      .prepare(
        `select id, name, resume, project_notes, job_description, target_role, target_level,
                repo_path, created_at, updated_at
         from preparation_profiles
         order by created_at, id`,
      )
      .all() as ProfileRow[];
    return rows.map(mapProfile);
  }

  get(id: string): PreparationProfile {
    const row = this.database
      .prepare(
        `select id, name, resume, project_notes, job_description, target_role, target_level,
                repo_path, created_at, updated_at
         from preparation_profiles
         where id = ?`,
      )
      .get(id) as ProfileRow | undefined;

    if (!row) {
      throw new ProfileNotFoundError(id);
    }
    return mapProfile(row);
  }

  previewProviderView(id: string): ProviderView {
    const profile = this.get(id);
    const profileRecord = this.database
      .prepare("select content_hash from preparation_profiles where id = ?")
      .get(id) as { content_hash: string };
    const existing = this.database
      .prepare(
        `select id, profile_id, source_content_hash, redaction_version, content_json,
                confirmed_at, created_at
         from provider_views
         where profile_id = ? and source_content_hash = ? and redaction_version = ?`,
      )
      .get(id, profileRecord.content_hash, "contact-v1") as ProviderViewRow | undefined;

    if (existing) {
      return mapProviderView(existing);
    }

    const view: ProviderView = {
      id: this.createId(),
      profileId: id,
      sourceContentHash: profileRecord.content_hash,
      redactionVersion: "contact-v1",
      content: {
        resume: redactContactData(profile.resume, profile.name),
        projectNotes: redactContactData(profile.projectNotes, profile.name),
        jobDescription: redactContactData(profile.jobDescription, profile.name),
        targetRole: profile.targetRole,
        targetLevel: profile.targetLevel,
      },
      confirmedAt: null,
      createdAt: this.now().toISOString(),
    };

    this.database
      .prepare(
        `insert into provider_views
          (id, profile_id, source_content_hash, redaction_version, content_json, confirmed_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        view.id,
        view.profileId,
        view.sourceContentHash,
        view.redactionVersion,
        JSON.stringify(view.content),
        null,
        Date.parse(view.createdAt),
      );

    return view;
  }

  confirmProviderView(id: string): ProviderView {
    const view = this.previewProviderView(id);
    const confirmedAt = this.now();
    this.database
      .prepare("update provider_views set confirmed_at = ? where id = ?")
      .run(confirmedAt.getTime(), view.id);

    return { ...view, confirmedAt: confirmedAt.toISOString() };
  }

  createSnapshot(id: string): Readonly<ProfileSnapshot> {
    const profile = this.get(id);
    const view = this.previewProviderView(id);
    if (view.confirmedAt === null) {
      throw new ProviderViewNotConfirmedError(id);
    }

    return freezeSnapshot({
      profile: structuredClone(profile),
      providerView: structuredClone(view.content),
      redactionVersion: view.redactionVersion,
      capturedAt: this.now().toISOString(),
    });
  }

  close(): void {
    this.database.close();
  }
}

export function createPreparationProfiles(
  options: PreparationProfilesOptions,
): PreparationProfiles {
  return new SqlitePreparationProfiles(options);
}
