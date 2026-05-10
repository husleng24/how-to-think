# How to Think

> AI-native, Markdown-based mind mapping for local-first knowledge work.

How to Think is a desktop mind map tool built with Rust, Tauri, and React. It treats Markdown as the source of truth, supports Obsidian-compatible linking, renders hierarchical Markdown in a Markmap-friendly way, and brings AI, Git history, and CLI automation into the core workflow.

## Vision

Most mind map tools store ideas in proprietary formats. Most Markdown tools store ideas as documents, not as editable maps. How to Think is designed to bridge both worlds:

- Think visually in a mind map.
- Save everything as plain Markdown.
- Link knowledge across files using familiar wiki-style references.
- Use AI agents to reshape, expand, summarize, or discuss your map.
- Track every meaningful change with native Git history.
- Automate the desktop app from the command line.

## Core Features

### Mind Map Basics

- Create, edit, move, fold, and delete nodes.
- Drag nodes across branches.
- Zoom, pan, focus, search, and navigate large maps.
- Support keyboard-first editing.
- Import and export Markdown-based maps.
- Render Markdown headings and nested lists as mind map hierarchy.
- Preserve formatting such as links, code, emphasis, tasks, and notes where possible.

### Local-First Markdown Storage

- Store maps as human-readable `.md` files.
- Keep user data fully local by default.
- Use standard Markdown as the canonical file format.
- Support Obsidian-style links such as `[[Note]]`, `[[Note#Heading]]`, and `[[Note|Alias]]`.
- Support Markdown links such as `[title](./path/to/file.md)`.
- Support file-to-file graph navigation.
- Keep heading and nested-list structures compatible with Markmap-style rendering.

### AI-Native Workflow

- Call local AI coding and writing agents from inside the app.
- Planned local agent adapters:
  - Codex CLI
  - Claude CLI
  - Custom local command adapters
- Ask AI to restructure a branch, expand an outline, summarize a map, generate alternatives, or convert free-form notes into a structured mind map.
- Support conversational editing with visible diffs before changes are applied.
- Keep AI execution local-first when using local models or local agent CLIs.

### Native Git Versioning

- Initialize and manage Git repositories directly from the desktop app.
- Commit map changes with generated or user-written messages.
- View file and branch history.
- Restore previous versions of a map or branch.
- Compare current Markdown with historical versions.
- Support local repositories first, with remote workflows planned.

### CLI-First Automation

The CLI should be able to call every desktop feature, making the app useful in scripts, terminals, editors, and agent workflows.

Planned examples:

```bash
how-to-think open ./ideas/product-strategy.md
how-to-think new ./maps/ai-native-editor.md
how-to-think render ./ideas.md --format png
how-to-think ask ./ideas.md "turn this into a launch plan"
how-to-think git commit ./ideas.md -m "Refine product map"
how-to-think history ./ideas.md
how-to-think restore ./ideas.md --commit <sha>
```

## Tech Stack

- **Rust** for core logic, file operations, Git integration, CLI, and native system APIs.
- **Tauri** for the lightweight cross-platform desktop shell.
- **React** for the interactive mind map UI.
- **TypeScript** for frontend application code.
- **Markdown** as the storage format.
- **Git** as the versioning engine.

## Architecture

```text
how-to-think/
  apps/
    desktop/          # Tauri + React desktop app
    cli/              # Native CLI entry point
  crates/
    core/             # Markdown model, mind map operations, command system
    markdown/         # Markdown parsing, serialization, Obsidian/Markmap compatibility
    git/              # Git history, diff, restore, repository operations
    ai/               # Local agent adapters for Codex, Claude, and custom commands
  packages/
    ui/               # Shared React components
    mindmap/          # Mind map canvas and interaction layer
```

## Markdown Model

How to Think aims to support two common Markdown mind map patterns:

### Heading-Based Maps

```markdown
# Product Strategy

## Positioning

### Audience

### Differentiation

## Roadmap
```

### List-Based Maps

```markdown
# Product Strategy

- Positioning
  - Audience
  - Differentiation
- Roadmap
  - MVP
  - Beta
  - Launch
```

The app should preserve the source structure instead of forcing all files into one internal format.

## AI Editing Flow

1. User selects a node, branch, or file.
2. User asks Codex, Claude, or another local adapter to perform an operation.
3. The AI returns a proposed Markdown patch.
4. The app shows a structured diff.
5. User accepts, edits, or rejects the result.
6. Accepted changes are written to Markdown and can be committed to Git.

## Git Workflow

```bash
how-to-think git init
how-to-think git status
how-to-think git diff
how-to-think git commit -m "Add first product map"
how-to-think history ./maps/product.md
how-to-think restore ./maps/product.md --commit <sha>
```

Git is treated as a first-class product feature, not as an external afterthought.

## Roadmap

- [ ] Markdown parser and serializer
- [ ] Mind map data model
- [ ] Tauri desktop shell
- [ ] React canvas prototype
- [ ] Node editing, drag-and-drop, fold, zoom, and search
- [ ] Obsidian-style link support
- [ ] Markmap-compatible heading/list rendering
- [ ] Local Git init, commit, diff, history, and restore
- [ ] CLI command surface
- [ ] Codex CLI adapter
- [ ] Claude CLI adapter
- [ ] AI diff preview and apply flow
- [ ] Cross-file graph navigation
- [ ] Export to PNG, SVG, PDF, and Markdown

## Development Status

This project is in the planning and early implementation stage. The README defines the product direction, core requirements, and intended architecture.

## Name

`how-to-think` is the repository name. The product can also be referred to as **How to Think**.

## License

License to be decided.
