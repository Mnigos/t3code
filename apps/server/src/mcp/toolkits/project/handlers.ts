import {
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  type Project as ProjectRecord,
  ProjectId,
  type ProjectSettingsOverrides,
  type ProjectUpdatePayload,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Settings from "../../../serverSettings.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import { newCommandId, readCaller, readMutationCaller, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});
const mutation = Effect.gen(function* () {
  const { caller } = yield* readMutationCaller();
  if (
    caller.archivedAt !== null ||
    caller.runtimeMode !== "full-access" ||
    caller.interactionMode !== "default"
  )
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Project changes require a live full-access/default calling thread.",
    });
  return yield* Project.ProjectService;
});
type ProjectSettingsFields = Pick<
  ProjectUpdatePayload,
  "defaultModelSelection" | "defaultThreadEnvMode" | "autoPull" | "scripts"
>;

/**
 * Saves the project-scoped fields a caller set and returns the settings
 * afterwards. Launch and the new-thread UI read them from
 * `projectSettingsOverrides`, and once project settings are folded they never
 * read the project record, so they go there rather than through
 * `ProjectService`. Title, icon, favicon and workspace root stay on the record.
 * A cleared value removes the override so the environment default applies:
 * `null` (a stored null model would mean "no default model") and an empty
 * script list, which on the record always meant "use the environment's actions".
 */
const saveProjectSettings = (projectId: ProjectId, fields: ProjectSettingsFields) =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const current = yield* settings.getSettings;
    const { defaultModelSelection, defaultThreadEnvMode, autoPull, scripts } = fields;
    if (
      defaultModelSelection === undefined &&
      defaultThreadEnvMode === undefined &&
      autoPull === undefined &&
      scripts === undefined
    )
      return current;
    // The patch replaces the project's whole entry, so start from the stored one.
    const entry: ProjectSettingsOverrides = { ...current.projectSettingsOverrides[projectId] };
    const set = <K extends keyof ProjectSettingsOverrides>(
      key: K,
      value: ProjectSettingsOverrides[K] | undefined,
    ) => {
      if (value === undefined) delete entry[key];
      else entry[key] = value;
    };
    if (defaultModelSelection !== undefined)
      set("defaultModelSelection", defaultModelSelection ?? undefined);
    if (defaultThreadEnvMode !== undefined)
      set("defaultThreadEnvMode", defaultThreadEnvMode ?? undefined);
    if (autoPull !== undefined) set("defaultAutoPull", autoPull);
    if (scripts !== undefined)
      set("defaultProjectScripts", scripts.length === 0 ? undefined : scripts);
    return yield* settings.updateSettings({
      projectSettingsOverrides: { [projectId]: Object.keys(entry).length === 0 ? null : entry },
    });
  }).pipe(Effect.mapError(unavailable));

/** The project with the model, env mode, auto-pull and scripts its new threads get. */
function effectiveProject<P extends ProjectRecord>(settings: ServerSettings, project: P): P {
  const resolved = resolveProjectSettings(settings, project.id, project).settings;
  return {
    ...project,
    defaultModelSelection: resolved.defaultModelSelection,
    defaultThreadEnvMode: resolved.defaultThreadEnvMode,
    autoPull: resolved.defaultAutoPull,
    scripts: resolveProjectScripts(settings, project),
  };
}
const currentSettings = Settings.ServerSettingsService.pipe(
  Effect.flatMap((settings) => settings.getSettings),
  Effect.mapError(unavailable),
);

export const ProjectHandlersLive = ProjectToolkit.toLayer({
  t3_thread_launch: (input) =>
    Effect.gen(function* () {
      const { caller, scope } = yield* readMutationCaller();
      if (caller.runtimeMode !== "full-access" || caller.interactionMode !== "default")
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Project launches require a full-access/default calling thread.",
        });
      const commandId = yield* newCommandId();
      const threadId = ThreadId.make(commandId);
      const messageId = MessageId.make(commandId);
      const attachments = input.attachments ?? [];
      if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "A new thread accepts only pending attachment uploads.",
        });
      if (
        input.scratch === true &&
        (input.projectId !== undefined || input.workspaceStrategy !== undefined)
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
        });
      const projectId =
        input.scratch === true
          ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
              Effect.flatMap((folders) => folders.ensureScratchProject),
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.message,
                  }),
              ),
            )).projectId
          : (input.projectId ?? caller.projectId);
      const result = yield* ThreadMessageIntake.launchThread({
        commandId,
        threadId,
        projectId,
        title: input.title,
        modelSelection: input.modelSelection ?? caller.modelSelection,
        runtimeMode: input.runtimeMode ?? caller.runtimeMode,
        interactionMode: input.interactionMode ?? caller.interactionMode,
        workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
        ...(input.message === undefined && attachments.length === 0
          ? {}
          : {
              initialMessage: {
                messageId,
                senderThreadId: scope.threadId,
                text: input.message ?? "",
                attachments,
              },
            }),
        createdBy: "agent",
        creationSource: "mcp",
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "AttachmentClaimError"
            ? new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message })
            : unavailable(),
        ),
      );
      const thread = result.projection.thread;
      const run = result.projection.runs.find((run) => run.userMessageId === messageId);
      return {
        threadId: thread.id,
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        runId: run?.id ?? null,
        status: run?.status ?? null,
      };
    }),
  t3_project_list: (input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
      const settings = yield* currentSettings;
      const rows = snapshot.projects
        .filter((project) => project.deletedAt === null)
        .map((project) => effectiveProject(settings, project));
      const start = input.cursor ?? 0,
        end = start + (input.limit ?? 20);
      return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
    }),
  t3_project_read: (input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(result))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      return effectiveProject(yield* currentSettings, result.value);
    }),
  t3_project_create: ({ workspaceRoot, scripts, defaultModelSelection, ...input }) =>
    Effect.gen(function* () {
      const projects = yield* mutation;
      if (workspaceRoot === undefined) {
        // Project creation records no model default (only an update does), so
        // reject what this mode would otherwise drop silently.
        if (
          scripts !== undefined ||
          input.createWorkspaceRootIfMissing !== undefined ||
          defaultModelSelection !== undefined
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with t3_project_update.",
          });
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const created = yield* folders
          .createNamedProject({ name: input.title })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
          );
        const project = yield* projects
          .getById(created.projectId)
          .pipe(
            Effect.mapError(unavailable),
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
            ),
          );
        return {
          ...effectiveProject(yield* currentSettings, project),
          ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
        };
      }
      const commandId = yield* newCommandId();
      const project = yield* projects
        .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
        .pipe(Effect.mapError(projectFailure));
      const settings = yield* saveProjectSettings(project.id, { scripts, defaultModelSelection });
      return effectiveProject(settings, project);
    }),
  t3_project_update: ({
    defaultModelSelection,
    defaultThreadEnvMode,
    autoPull,
    scripts,
    ...input
  }) =>
    Effect.gen(function* () {
      const projects = yield* mutation;
      // The record update runs first: it rejects an unknown project before
      // any override is stored for it. A clear also reaches the record, whose
      // own copy still backs a cleared override until settings are folded.
      const project = yield* projects
        .update({
          ...input,
          ...(defaultModelSelection === null ? { defaultModelSelection } : {}),
          ...(defaultThreadEnvMode === null ? { defaultThreadEnvMode } : {}),
          ...(scripts?.length === 0 ? { scripts } : {}),
          commandId: yield* newCommandId(),
        })
        .pipe(Effect.mapError(projectFailure));
      const settings = yield* saveProjectSettings(project.id, {
        defaultModelSelection,
        defaultThreadEnvMode,
        autoPull,
        scripts,
      });
      return effectiveProject(settings, project);
    }),
  t3_project_delete: (input) =>
    Effect.gen(function* () {
      const projects = yield* mutation;
      return yield* projects
        .delete({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  t3_project_clone: (input) =>
    Effect.gen(function* () {
      yield* mutation;
      const repositories = yield* Repositories.SourceControlRepositoryService;
      return yield* repositories.cloneRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.detail,
            }),
        ),
      );
    }),
});
