import { Plugin } from "@opencode/plugin"
import type { PreloadSkillsConfig, ParsedSkill, PluginContext, Logger, ToastFn } from "./types.js"
import { loadConfig } from "./config/loader.js"
import { loadSkills, formatSkillsForInjection, calculateTotalTokens } from "./skills/loader.js"
import { SkillResolverImpl, resolveSkillGroups } from "./skills/resolver.js"
import { SessionManagerImpl } from "./session/manager.js"
import {
  createSystemPromptHook,
  createPromptHook,
  createToolExecuteAfterHook,
  createCompactionHook,
} from "./hooks/index.js"
import { registerLoadedSkillsTool } from "./tools/loaded-skills.js"
import { checkCondition } from "./utils.js"

export type { PreloadSkillsConfig, ParsedSkill }
export { loadSkills, formatSkillsForInjection }
// Exposed so programmatic consumers can extend (rather than retype) the default
// ignore-tag list, e.g. `[...DEFAULT_TRIGGER_IGNORE_TAGS, "my-plugin-context"]`.
export { DEFAULT_TRIGGER_IGNORE_TAGS } from "./config/loader.js"
export { stripIgnoredTags } from "./utils.js"

function resolveConditionalSkills(config: PreloadSkillsConfig, projectDir: string): string[] {
  if (!config.conditionalSkills?.length) return []

  const resolved: string[] = []
  for (const { skill, if: condition } of config.conditionalSkills) {
    if (checkCondition(condition, projectDir)) {
      resolved.push(skill)
    }
  }

  return resolved
}

export default Plugin.define({
  id: "preload-skills",
  async setup(ctx) {
    const projectDir = ctx.location.directory
    const config = loadConfig(projectDir)

    const log: Logger = (level, message, extra) => {
      if (level === "debug" && !config.debug) return
      const logFn =
        level === "error"
          ? console.error
          : level === "warn"
          ? console.warn
          : level === "debug"
          ? console.debug
          : console.info
      if (extra) {
        logFn(`[preload-skills] ${message}`, extra)
      } else {
        logFn(`[preload-skills] ${message}`)
      }
    }

    const allInitialSkillNames = [
      ...config.skills,
      ...resolveConditionalSkills(config, projectDir),
    ]

    const resolvedInitialNames = resolveSkillGroups(allInitialSkillNames, config.groups ?? {})
    let initialSkills = loadSkills(resolvedInitialNames, projectDir)
    let initialTokensUsed = calculateTotalTokens(initialSkills)

    if (config.maxTokens && initialTokensUsed > config.maxTokens) {
      const { filterSkillsByTokenBudget } = await import("./skills/loader.js")
      initialSkills = filterSkillsByTokenBudget(initialSkills, config.maxTokens)
      initialTokensUsed = calculateTotalTokens(initialSkills)
    }

    const initialFormattedContent = formatSkillsForInjection(initialSkills, {
      useSummaries: config.useSummaries,
      useMinification: config.useMinification,
      skillSettings: config.skillSettings,
    })

    if (initialSkills.length > 0) {
      const loadedNames = initialSkills.map((s) => s.name)
      const missingNames = allInitialSkillNames.filter(
        (s) => !loadedNames.includes(s) && !s.startsWith("@")
      )

      log("info", `Loaded ${initialSkills.length} initial skills`, {
        loaded: loadedNames,
        tokens: initialTokensUsed,
        missing: missingNames.length > 0 ? missingNames : undefined,
      })
    }

    const hasTriggeredSkills =
      Object.keys(config.fileTypeSkills ?? {}).length > 0 ||
      Object.keys(config.agentSkills ?? {}).length > 0 ||
      Object.keys(config.pathPatterns ?? {}).length > 0 ||
      Object.keys(config.contentTriggers ?? {}).length > 0

    if (allInitialSkillNames.length === 0 && !hasTriggeredSkills) {
      log("warn", "No skills configured. Create .opencode/preload-skills.json")
    }

    const sessionManager = new SessionManagerImpl(
      config,
      projectDir,
      log,
      new Set(initialSkills.map((s) => s.name)),
      initialTokensUsed
    )

    for (const skill of initialSkills) {
      sessionManager.cacheSkill(skill)
    }

    const skillResolver = new SkillResolverImpl(config, projectDir)

    const toast: ToastFn = (message, variant = "info") => {
      if (!config.showToasts) return
      log(variant === "error" ? "error" : variant === "warning" ? "warn" : "info", message)
    }

    const pluginContext: PluginContext = {
      config,
      projectDir,
      log,
      toast,
      sessionManager,
      skillResolver,
      initialSkills,
      initialFormattedContent,
      initialTokensUsed,
    }

    ctx.session.hook("context", createSystemPromptHook(pluginContext))
    ctx.session.hook("prompt", createPromptHook(pluginContext))
    ctx.tool.hook("execute.after", createToolExecuteAfterHook(pluginContext))
    ctx.session.hook("compaction", createCompactionHook(pluginContext))

    if (config.enableTools !== false) {
      ctx.tool.transform((editor) => {
        registerLoadedSkillsTool(editor, sessionManager, toast)
      })
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.deleted") {
            sessionManager.cleanup(event.data.sessionID)
          }
        }
      } catch {
        // Aborted on cleanup
      }
    })()

    return () => controller.abort()
  },
})
