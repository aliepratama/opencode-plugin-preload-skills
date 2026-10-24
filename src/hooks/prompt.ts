import type { SessionPrompt } from "@opencode/plugin/promise/session"
import type { PluginContext } from "../types.js"
import { textContainsKeyword, stripIgnoredTags } from "../utils.js"

export function createPromptHook(ctx: PluginContext) {
  const { config, sessionManager, skillResolver } = ctx

  return async (event: SessionPrompt): Promise<void> => {
    if (!event.sessionID) return

    const rawText = event.prompt?.text
    if (!rawText || typeof rawText !== "string") return

    // Strip plugin-injected context blocks (e.g. <session-history>,
    // <project-memory>) before keyword matching. This prevents false triggers
    // when injected historical summaries happen to contain a contentTrigger
    // keyword (e.g. "cover image", "rebase fixup") that the user never typed.
    // Tag names are configurable via `triggerIgnoreTags`; see DEFAULT_TRIGGER_IGNORE_TAGS.
    const messageText = stripIgnoredTags(
      rawText,
      config.triggerIgnoreTags ?? []
    )

    if (config.contentTriggers) {
      const state = sessionManager.getState(event.sessionID)
      for (const [keyword, skillNames] of Object.entries(config.contentTriggers)) {
        if (textContainsKeyword(messageText, [keyword])) {
          const result = skillResolver.loadWithBudget(
            skillNames,
            state.totalTokensUsed,
            event.sessionID,
            "content"
          )
          if (result.skills.length > 0) {
            sessionManager.queueSkills(event.sessionID, result.skills, "content")
          }
        }
      }
    }
  }
}
