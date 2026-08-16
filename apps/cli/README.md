# `@ai-mesh/cli`

Headless product entry point over `@ai-mesh/workspace`. It exposes workspace
initialization and inspection, Agent lifecycle, messages, tasks, timeline, and a
real-Agent smoke flow without defining a second collaboration model.

Keep Room and Agent behavior in the packages below the CLI. New commands should
delegate to the workspace service and remain suitable for automation.
