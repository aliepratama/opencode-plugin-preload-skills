import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import plugin from "./index.js"

describe("PreloadSkillsPlugin V2", () => {
  const testDir = join(process.cwd(), ".test-plugin")
  const opencodeDir = join(testDir, ".opencode")
  const skillsDir = join(opencodeDir, "skills")

  interface MockContextOptions {
    eventBus?: {
      emit: (event: any) => void
      subscribe: (opts?: { signal?: AbortSignal }) => AsyncIterable<any>
    }
  }

  const createEventBus = () => {
    type Listener = (event: any) => void
    const listeners: Listener[] = []

    return {
      emit(event: any) {
        for (const l of listeners) {
          l(event)
        }
      },
      subscribe(opts?: { signal?: AbortSignal }) {
        return {
          async *[Symbol.asyncIterator]() {
            const queue: any[] = []
            let resolveNext: (() => void) | null = null

            const listener: Listener = (event: any) => {
              queue.push(event)
              resolveNext?.()
            }
            listeners.push(listener)

            opts?.signal?.addEventListener("abort", () => {
              resolveNext?.()
            })

            try {
              while (!opts?.signal?.aborted) {
                if (queue.length === 0) {
                  await new Promise<void>((r) => {
                    resolveNext = r
                  })
                }
                while (queue.length > 0) {
                  yield queue.shift()
                }
              }
            } finally {
              const idx = listeners.indexOf(listener)
              if (idx >= 0) listeners.splice(idx, 1)
            }
          },
        }
      },
    }
  }

  const createMockContext = (options: MockContextOptions = {}) => {
    const sessionHooks: Record<string, Function> = {}
    const toolHooks: Record<string, Function> = {}
    let toolTransformFn: ((editor: any) => void) | undefined
    const eventBus = options.eventBus ?? createEventBus()

    const ctx = {
      location: {
        directory: testDir,
      },
      session: {
        hook: vi.fn((name: string, fn: Function) => {
          sessionHooks[name] = fn
          return Promise.resolve({ dispose: vi.fn() })
        }),
      },
      tool: {
        hook: vi.fn((name: string, fn: Function) => {
          toolHooks[name] = fn
          return Promise.resolve({ dispose: vi.fn() })
        }),
        transform: vi.fn((fn: (editor: any) => void) => {
          toolTransformFn = fn
          return Promise.resolve({ dispose: vi.fn() })
        }),
      },
      event: {
        subscribe: vi.fn((opts?: { signal?: AbortSignal }) => {
          return eventBus.subscribe(opts)
        }),
      },
    }

    return {
      ctx: ctx as any,
      sessionHooks,
      toolHooks,
      getToolTransform: () => toolTransformFn,
      eventBus,
    }
  }

  const createConfig = (config: Record<string, unknown>) => {
    mkdirSync(opencodeDir, { recursive: true })
    writeFileSync(join(opencodeDir, "preload-skills.json"), JSON.stringify(config))
  }

  const createSkill = (name: string, content: string) => {
    const skillDir = join(skillsDir, name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), content)
  }

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  describe("initialization", () => {
    it("initializes without config file and registers V2 hooks", async () => {
      const { ctx, sessionHooks, toolHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      expect(sessionHooks["context"]).toBeDefined()
      expect(sessionHooks["prompt"]).toBeDefined()
      expect(toolHooks["execute.after"]).toBeDefined()
      expect(sessionHooks["compaction"]).toBeDefined()
      expect(ctx.event.subscribe).toHaveBeenCalled()
      if (typeof cleanup === "function") cleanup()
    })

    it("loads config from .opencode directory", async () => {
      createConfig({ skills: ["test-skill"], debug: true })
      createSkill("test-skill", "---\nname: test-skill\ndescription: Test\n---\nContent")

      const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
      const { ctx } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      expect(consoleInfoSpy).toHaveBeenCalledWith(
        expect.stringContaining("[preload-skills] Loaded 1 initial skills"),
        expect.any(Object)
      )
      if (typeof cleanup === "function") cleanup()
    })

    it("logs warning when no skills configured", async () => {
      createConfig({})

      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const { ctx } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("No skills configured")
      )
      if (typeof cleanup === "function") cleanup()
    })

    it("loads initial skills on startup", async () => {
      createSkill("skill-a", "---\nname: skill-a\ndescription: A\n---\nContent A")
      createSkill("skill-b", "---\nname: skill-b\ndescription: B\n---\nContent B")
      createConfig({ skills: ["skill-a", "skill-b"] })

      const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
      const { ctx } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      expect(consoleInfoSpy).toHaveBeenCalledWith(
        expect.stringContaining("Loaded 2 initial skills"),
        expect.objectContaining({
          loaded: ["skill-a", "skill-b"],
        })
      )
      if (typeof cleanup === "function") cleanup()
    })

    it("logs missing skills", async () => {
      createSkill("exists", "---\nname: exists\ndescription: E\n---\nContent")
      createConfig({ skills: ["exists", "missing"] })

      const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
      const { ctx } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      expect(consoleInfoSpy).toHaveBeenCalledWith(
        expect.stringContaining("Loaded 1 initial skills"),
        expect.objectContaining({
          missing: ["missing"],
        })
      )
      if (typeof cleanup === "function") cleanup()
    })
  })

  describe("context hook (system prompt injection)", () => {
    it("injects initial skills into system prompt", async () => {
      createSkill("test-skill", "---\nname: test-skill\ndescription: Test\n---\nSkill Content Here")
      createConfig({ skills: ["test-skill"] })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const event: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(event)

      expect(event.system).toHaveLength(1)
      expect(event.system[0].type).toBe("text")
      expect(event.system[0].text).toContain("<preloaded-skills>")
      expect(event.system[0].text).toContain("Skill Content Here")
      if (typeof cleanup === "function") cleanup()
    })

    it("triggers agent-specific skills during context hook", async () => {
      createSkill("plan-skill", "---\nname: plan-skill\ndescription: Plan\n---\nPlan Content")
      createConfig({ agentSkills: { plan: ["plan-skill"] } })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const event: any = {
        sessionID: "test-session",
        agent: "plan",
        system: [],
      }
      await sessionHooks["context"]!(event)

      expect(event.system).toHaveLength(1)
      expect(event.system[0].text).toContain("Plan Content")
      if (typeof cleanup === "function") cleanup()
    })

    it("handles missing sessionID gracefully", async () => {
      createConfig({ skills: ["test-skill"] })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const event: any = {
        sessionID: "",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(event)

      expect(event.system).toHaveLength(0)
      if (typeof cleanup === "function") cleanup()
    })
  })

  describe("prompt hook (content triggers)", () => {
    it("queues skills on prompt content keyword match and injects on next context hook", async () => {
      createSkill("db-skill", "---\nname: db-skill\ndescription: DB\n---\nDatabase Content")
      createConfig({ contentTriggers: { database: ["db-skill"] } })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const promptEvent: any = {
        sessionID: "test-session",
        prompt: {
          text: "I need help with database queries",
        },
      }
      await sessionHooks["prompt"]!(promptEvent)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system).toHaveLength(1)
      expect(contextEvent.system[0].text).toContain("Database Content")
      if (typeof cleanup === "function") cleanup()
    })

    it("strips ignored tags before running content trigger keyword match", async () => {
      createSkill("image-skill", "---\nname: image-skill\ndescription: Image\n---\nImage Content")
      createConfig({
        contentTriggers: { "cover image": ["image-skill"] },
      })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      // Prompt has "cover image" inside <session-history>, should not trigger
      const promptEvent: any = {
        sessionID: "test-session",
        prompt: {
          text: "<session-history>Previous conversation about cover image</session-history>\nHello world",
        },
      }
      await sessionHooks["prompt"]!(promptEvent)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system).toHaveLength(0)
      if (typeof cleanup === "function") cleanup()
    })
  })

  describe("tool.execute.after hook", () => {
    it("triggers file type skills from execute.after input and injects on context", async () => {
      createSkill("ts-skill", "---\nname: ts-skill\ndescription: TS\n---\nTypeScript Content")
      createConfig({ fileTypeSkills: { ".ts": ["ts-skill"] } })

      const { ctx, sessionHooks, toolHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      await toolHooks["execute.after"]!({
        tool: "read",
        sessionID: "test-session",
        input: { filePath: "src/index.ts" },
        status: "completed",
      })

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system[0].text).toContain("TypeScript Content")
      if (typeof cleanup === "function") cleanup()
    })

    it("triggers path pattern skills", async () => {
      createSkill("api-skill", "---\nname: api-skill\ndescription: API\n---\nAPI Content")
      createConfig({ pathPatterns: { "src/api/**": ["api-skill"] } })

      const { ctx, sessionHooks, toolHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      await toolHooks["execute.after"]!({
        tool: "edit",
        sessionID: "test-session",
        input: { filePath: "src/api/users.ts" },
        status: "completed",
      })

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system[0].text).toContain("API Content")
      if (typeof cleanup === "function") cleanup()
    })

    it("ignores non-file tools", async () => {
      createSkill("ts-skill", "---\nname: ts-skill\ndescription: TS\n---\nTypeScript Content")
      createConfig({ fileTypeSkills: { ".ts": ["ts-skill"] } })

      const { ctx, sessionHooks, toolHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      await toolHooks["execute.after"]!({
        tool: "bash",
        sessionID: "test-session",
        input: { command: "echo test.ts" },
        status: "completed",
      })

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system).toHaveLength(0)
      if (typeof cleanup === "function") cleanup()
    })

    it("ignores non-completed tool executions", async () => {
      createSkill("ts-skill", "---\nname: ts-skill\ndescription: TS\n---\nTypeScript Content")
      createConfig({ fileTypeSkills: { ".ts": ["ts-skill"] } })

      const { ctx, sessionHooks, toolHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      await toolHooks["execute.after"]!({
        tool: "read",
        sessionID: "test-session",
        input: { filePath: "src/index.ts" },
        status: "error",
      })

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system).toHaveLength(0)
      if (typeof cleanup === "function") cleanup()
    })

    it("handles various file path argument names (path, file)", async () => {
      createSkill("ts-skill", "---\nname: ts-skill\ndescription: TS\n---\nTS Content")
      createConfig({ fileTypeSkills: { ".ts": ["ts-skill"] } })

      const { ctx, sessionHooks, toolHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      await toolHooks["execute.after"]!({
        tool: "read",
        sessionID: "test-session",
        input: { path: "test.ts" },
        status: "completed",
      })

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system[0].text).toContain("TS Content")
      if (typeof cleanup === "function") cleanup()
    })
  })

  describe("compaction hook", () => {
    it("adds loaded skills to compaction context system array", async () => {
      createSkill("test-skill", "---\nname: test-skill\ndescription: Test\n---\nContent")
      createConfig({ skills: ["test-skill"], persistAfterCompaction: true })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      const compactionEvent: any = {
        sessionID: "test-session",
        system: [],
      }
      await sessionHooks["compaction"]!(compactionEvent)

      expect(compactionEvent.system).toHaveLength(1)
      expect(compactionEvent.system[0].type).toBe("text")
      expect(compactionEvent.system[0].text).toContain("## Preloaded Skills")
      expect(compactionEvent.system[0].text).toContain("Content")
      if (typeof cleanup === "function") cleanup()
    })

    it("respects persistAfterCompaction=false", async () => {
      createSkill("test-skill", "---\nname: test-skill\ndescription: Test\n---\nContent")
      createConfig({ skills: ["test-skill"], persistAfterCompaction: false })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      const compactionEvent: any = {
        sessionID: "test-session",
        system: [],
      }
      await sessionHooks["compaction"]!(compactionEvent)

      expect(compactionEvent.system).toHaveLength(0)
      if (typeof cleanup === "function") cleanup()
    })
  })

  describe("session.deleted event", () => {
    it("cleans up session state on session.deleted", async () => {
      createSkill("test-skill", "---\nname: test-skill\ndescription: Test\n---\nContent")
      createConfig({ skills: ["test-skill"], debug: true, analytics: true })

      const eventBus = createEventBus()
      const { ctx, sessionHooks } = createMockContext({ eventBus })
      const cleanup = await plugin.setup(ctx)

      const contextEvent: any = {
        sessionID: "session-to-delete",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      eventBus.emit({
        type: "session.deleted",
        data: { sessionID: "session-to-delete" },
      })

      // Give async microtask a cycle to process
      await new Promise((r) => setTimeout(r, 20))

      const analyticsPath = join(testDir, ".opencode", "preload-skills-analytics.json")
      expect(existsSync(analyticsPath)).toBe(true)

      if (typeof cleanup === "function") cleanup()
    })
  })

  describe("conditional skills", () => {
    it("loads skill when file exists condition is met", async () => {
      createSkill("prisma-skill", "---\nname: prisma-skill\ndescription: Prisma\n---\nPrisma Content")
      mkdirSync(join(testDir, "prisma"), { recursive: true })
      writeFileSync(join(testDir, "prisma", "schema.prisma"), "model User {}")
      createConfig({
        conditionalSkills: [
          { skill: "prisma-skill", if: { fileExists: "prisma/schema.prisma" } },
        ],
      })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system[0].text).toContain("Prisma Content")
      if (typeof cleanup === "function") cleanup()
    })

    it("loads skill when package dependency condition is met", async () => {
      createSkill("react-skill", "---\nname: react-skill\ndescription: React\n---\nReact Content")
      writeFileSync(join(testDir, "package.json"), JSON.stringify({ dependencies: { react: "^18" } }))
      createConfig({
        conditionalSkills: [
          { skill: "react-skill", if: { packageHasDependency: "react" } },
        ],
      })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system[0].text).toContain("React Content")
      if (typeof cleanup === "function") cleanup()
    })

    it("skips skill when condition is not met", async () => {
      createSkill("react-skill", "---\nname: react-skill\ndescription: React\n---\nReact Content")
      writeFileSync(join(testDir, "package.json"), JSON.stringify({ dependencies: { vue: "^3" } }))
      createConfig({
        conditionalSkills: [
          { skill: "react-skill", if: { packageHasDependency: "react" } },
        ],
      })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system).toHaveLength(0)
      if (typeof cleanup === "function") cleanup()
    })
  })

  describe("skill groups", () => {
    it("expands group references", async () => {
      createSkill("react", "---\nname: react\ndescription: React\n---\nReact Content")
      createSkill("css", "---\nname: css\ndescription: CSS\n---\nCSS Content")
      createConfig({
        groups: { frontend: ["react", "css"] },
        skills: ["@frontend"],
      })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system[0].text).toContain("React Content")
      expect(contextEvent.system[0].text).toContain("CSS Content")
      if (typeof cleanup === "function") cleanup()
    })
  })

  describe("token budget", () => {
    it("respects maxTokens limit", async () => {
      createSkill("small", "---\nname: small\ndescription: Small\n---\nSmall")
      createSkill("large", "---\nname: large\ndescription: Large\n---\n" + "x".repeat(10000))
      createConfig({
        skills: ["small", "large"],
        maxTokens: 100,
      })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system[0].text).toContain("Small")
      expect(contextEvent.system[0].text).not.toContain("xxxx")
      if (typeof cleanup === "function") cleanup()
    })
  })

  describe("useSummaries and skillSettings", () => {
    it("uses summaries when enabled", async () => {
      createSkill("test", "---\nname: test\ndescription: Test\nsummary: Brief summary\n---\nFull content here")
      createConfig({ skills: ["test"], useSummaries: true })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system[0].text).toContain("Brief summary")
      expect(contextEvent.system[0].text).not.toContain("Full content here")
      if (typeof cleanup === "function") cleanup()
    })

    it("applies per-skill summary settings", async () => {
      createSkill("full", "---\nname: full\ndescription: Full\nsummary: Full summary\n---\nFull content")
      createSkill("brief", "---\nname: brief\ndescription: Brief\nsummary: Brief summary\n---\nBrief content")
      createConfig({
        skills: ["full", "brief"],
        useSummaries: false,
        skillSettings: { brief: { useSummary: true } },
      })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system[0].text).toContain("Full content")
      expect(contextEvent.system[0].text).toContain("Brief summary")
      expect(contextEvent.system[0].text).not.toContain("Brief content")
      if (typeof cleanup === "function") cleanup()
    })
  })

  describe("useMinification", () => {
    it("minifies skill content when enabled", async () => {
      createSkill("verbose", "---\nname: verbose\ndescription: Verbose\n---\n\n# Title\n\n\n\nSome    spaced    content\n\n<!-- comment -->\n\nEnd")
      createConfig({ skills: ["verbose"], useMinification: true })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system[0].text).toContain("# Title")
      expect(contextEvent.system[0].text).toContain("Some spaced content")
      expect(contextEvent.system[0].text).not.toContain("<!-- comment -->")
      if (typeof cleanup === "function") cleanup()
    })

    it("does not minify when disabled (default)", async () => {
      createSkill("verbose", "---\nname: verbose\ndescription: Verbose\n---\n\nSome    spaced    content")
      createConfig({ skills: ["verbose"] })

      const { ctx, sessionHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system[0].text).toContain("Some    spaced    content")
      if (typeof cleanup === "function") cleanup()
    })
  })

  describe("loaded_skills tool", () => {
    it("registers tool when enableTools is true (default)", async () => {
      createSkill("test", "---\nname: test\ndescription: Test\n---\nContent")
      createConfig({ skills: ["test"] })

      const { ctx, getToolTransform } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const toolTransform = getToolTransform()
      expect(toolTransform).toBeDefined()

      const addedTools: Record<string, any> = {}
      const mockEditor = {
        add: vi.fn((toolDef: any) => {
          addedTools[toolDef.name] = toolDef
        }),
      }

      toolTransform!(mockEditor)
      expect(addedTools["loaded_skills"]).toBeDefined()
      expect(addedTools["loaded_skills"].description).toContain("List all preloaded skills")
      if (typeof cleanup === "function") cleanup()
    })

    it("does not register tool when enableTools is false", async () => {
      createSkill("test", "---\nname: test\ndescription: Test\n---\nContent")
      createConfig({ skills: ["test"], enableTools: false })

      const { ctx, getToolTransform } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      expect(getToolTransform()).toBeUndefined()
      if (typeof cleanup === "function") cleanup()
    })

    it("returns loaded skills and adheres to Tool.Result ({ content: string })", async () => {
      createSkill("my-skill", "---\nname: my-skill\ndescription: My Skill Desc\n---\nContent here")
      createConfig({ skills: ["my-skill"] })

      const { ctx, sessionHooks, getToolTransform } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      const addedTools: Record<string, any> = {}
      getToolTransform()!({
        add: (tool: any) => {
          addedTools[tool.name] = tool
        },
      })

      const tool = addedTools["loaded_skills"]
      const result = await tool.execute({}, { sessionID: "test-session" })

      expect(result).toHaveProperty("content")
      expect(result.content).toContain("my-skill")
      expect(result.content).toContain("My Skill Desc")
      expect(result.content).toContain("1 skill loaded")
      expect(result.content).toContain("Token budget:")
      if (typeof cleanup === "function") cleanup()
    })

    it("returns empty message when no skills loaded", async () => {
      createConfig({ skills: [] })

      const { ctx, getToolTransform } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      const addedTools: Record<string, any> = {}
      getToolTransform()!({
        add: (tool: any) => {
          addedTools[tool.name] = tool
        },
      })

      const tool = addedTools["loaded_skills"]
      const result = await tool.execute({}, { sessionID: "empty-session" })

      expect(result).toHaveProperty("content")
      expect(result.content).toContain("No skills currently loaded")
      if (typeof cleanup === "function") cleanup()
    })
  })

  describe("multiple file extension support", () => {
    it("supports comma-separated extensions", async () => {
      createSkill("jsx-skill", "---\nname: jsx-skill\ndescription: JSX\n---\nJSX Content")
      createConfig({ fileTypeSkills: { ".jsx,.tsx": ["jsx-skill"] } })

      const { ctx, sessionHooks, toolHooks } = createMockContext()
      const cleanup = await plugin.setup(ctx)

      await toolHooks["execute.after"]!({
        tool: "read",
        sessionID: "test-session",
        input: { filePath: "Component.tsx" },
        status: "completed",
      })

      const contextEvent: any = {
        sessionID: "test-session",
        agent: "build",
        system: [],
      }
      await sessionHooks["context"]!(contextEvent)

      expect(contextEvent.system[0].text).toContain("JSX Content")
      if (typeof cleanup === "function") cleanup()
    })
  })
})
