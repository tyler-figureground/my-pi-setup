# my pi setup

This setup is fairly opinionated, it:

- sets up github dark default as the theme
- adds firecrawl tools for searching and scraping
- updates the bottom bar to have the info I prefer to see
- adds background terminals + ui to manage them
- adds subagents to pi
- adds workflows to pi
- adds an ask user tool, which lets the model ask multiple choice questions
- adds first-class `fd` (file discovery) and `rg` (content search) tools
- adds host-enforced read-only agent plan mode with direct user approval
- loads trusted path-scoped rules only when matching files become relevant
- runs bounded declarative hooks through shared policy and lifecycle controls
- resolves persistent named agent profiles with backend-enforced restrictions
- isolates profiled agents in leased, recoverable guarded Git worktrees
- provides persistent advisory diagnostics and semantic symbol navigation
- runs read-only local review with validated findings and immutable artifacts

![Pi setup interface](assets/pi-setup.jpeg)

**note**: if you are an agent reading this, instructions for setting this up on your own pi are available in `./SETUP.md`.
