# <a href="#appendix-c-glossary" class="header">Appendix C: Glossary</a>

This appendix collects the technical terms that appear throughout the
book, sorted alphabetically by English term.

<div class="table-wrapper">

| Term | Definition | First Seen |
|----|----|----|
| Agent Loop | The core execution loop of an AI Agent: receive input -\> call model -\> execute tools -\> decide whether to continue | Chapter 3 |
| AST (Abstract Syntax Tree) | Tree-structured representation of source code that preserves semantic relationships (rather than plain text) | Chapter 28 |
| Cache Break | An event where the prompt cache prefix is invalidated due to content changes | Chapter 14 |
| Circuit Breaker | Forces an automated process to stop after N consecutive failures, degrading to a safe state | Chapters 9, 26 |
| Compaction | Summarizing conversation history to free context window space | Chapter 9 |
| DCE (Dead Code Elimination) | Bun's `feature()` function enables compile-time removal of gated code | Chapter 1 |
| Defensive Git | A pattern that prevents data loss during AI-executed Git operations through explicit safety rules | Chapter 27 |
| Dynamic Boundary | A marker in the system prompt that separates static cacheable content from dynamic session content | Chapter 5 |
| Fail-Closed | The system defaults to the safest option; explicit declaration is required to unlock dangerous operations | Chapters 2, 25 |
| Feature Flag (tengu\_\*) | Experiment gates configured at runtime via GrowthBook, controlling feature enable/disable | Chapters 1, 23 |
| Graduated Autonomy | Multi-level permission modes ranging from manual confirmation to full automation, each with safe fallbacks | Chapter 27 |
| Harness Engineering | The practice of guiding AI model behavior through prompts, tools, and configuration (rather than code logic) | Chapter 1 |
| Hooks | User-defined shell commands that execute at specific events (e.g., before/after tool calls) | Chapter 18 |
| Latch | A session-level state that, once entered, remains stable — preventing cache oscillation or behavioral jitter | Chapters 13, 25 |
| MCP (Model Context Protocol) | A protocol standardizing the interaction between AI models and external tools/data sources | Chapter 22 |
| Microcompact | Precisely removing specific tool results (rather than compacting the entire conversation), keeping the cache prefix stable | Chapter 11 |
| Outline | An overview document of the book's table of contents structure and chapter topics | Preface |
| Partition | Dividing tool calls into parallelizable and must-serialize batches, based on the `isConcurrencySafe` property | Chapter 4 |
| Pattern Extraction | Extracting reusable design patterns from source code analysis, including name, problem, and solution | Throughout |
| Post-Compact Restore | Selectively restoring the most critical file contents and skill information after compaction completes | Chapter 10 |
| Prompt Cache | An Anthropic API feature that caches message prefixes to reduce redundant token processing | Chapter 13 |
| Skill | A callable prompt template, injected into conversation context via SkillTool | Chapter 22 |
| Token Budget | The token usage cap allocated to various types of content within the context window | Chapters 12, 26 |
| Tool Schema | A tool's JSON Schema definition, including name, description, and input parameter format | Chapter 2 |
| YOLO Classifier | A secondary Claude API call used to make permission approve/deny decisions in auto mode | Chapter 17 |

</div>
