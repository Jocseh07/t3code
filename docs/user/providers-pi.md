# pi

T3 Code runs the pi installed on the connected environment. With a remote environment, its pi
setup applies, not the one on your desktop or phone.

## Set up

1. Install pi and log in to at least one model provider: run `pi` in a terminal, then `/login`.
2. In T3 Code, open **Settings** > **Providers** and turn on **pi**.
3. Pick a pi model in the composer. Models appear as `provider/model`, and only models with
   working credentials are listed. **pi default** keeps whatever pi would pick on its own.

If the card says pi has no model with credentials, log in from the terminal and refresh the
provider status.

## Settings

**Binary path**: the `pi` executable. Leave empty to use the one on `PATH`.

**Agent directory**: a custom `PI_CODING_AGENT_DIR`. Use it to keep a separate set of
credentials, models, extensions, and sessions for this T3 Code instance.

**Launch arguments**: extra flags for every pi session, for example `-e ./my-extension.ts`.

## Extensions, packages, skills, and models

Everything in your pi setup loads in T3 Code threads: global extensions, installed packages,
skills, prompt templates, custom providers from `models.json`, and any MCP servers you attach
through a pi extension. Manage them from the terminal with `pi install` and `pi remove`.

Project-local `.pi/` resources load only if you trusted that folder in pi with `/trust`.

Skills and prompt templates that pi finds for the thread's folder appear under `/` in the
composer.

## Permission modes

**Full access** runs commands and edits without asking.

**Auto-accept edits** lets file edits through and asks before commands and other tools.

**Supervised** and **Auto** ask before commands, edits, and other tools. Reads never ask.
pi has no built-in risk reviewer, so **Auto** behaves like **Supervised**.

**Allow for this session** remembers that exact tool and input for the rest of the session.
Denying a request tells pi the action was declined and lets it continue.

## Questions from the agent

When a pi extension asks you a multiple-choice question, it appears as a question card in the
thread. Pick an option or type your own answer. Dismissing the card tells the agent you declined.
The extension has to support this; the `ask_user` extension does.

## Thinking

Reasoning models show a **Thinking** control with the levels pi exposes for that model. Changing
the model or thinking level applies to the next message without starting a new thread.

## Sessions

Each thread is a pi session. It is saved where pi normally saves sessions, so `pi -r` in the
terminal lists your T3 Code threads by title, and a restarted server resumes the same history.

## Preview browser

pi threads get the T3 Code preview tools, prefixed `t3_`, alongside pi's own tools.

## Limits

- Images are sent to the model. Other attachments reach pi as file paths.
- Plan mode and conversation rollback are not available for pi threads.
- Updates are yours: run `pi update`.
