# Accio BYOK

**Bring your own model keys to [Accio](https://www.accio.com).** Switch providers without restarting, track usage, and back up or migrate sessions.

**English** · [简体中文](README.zh-CN.md)

> An independent community tool. Not affiliated with Alibaba or Accio. It does not register accounts, rotate accounts, or bypass quotas.

**1.4.1 local validation build · Windows x64.** This source includes the features below; 1.4.1 has not been published. The [published preview remains 1.3.0](https://github.com/w2112515/accio-byok/releases/tag/v1.3.0). The app defaults to English and also supports Simplified Chinese. Change **Language / 语言** in the top bar or Settings; your choice is saved for the next launch.

## Download and get started

1. Download the [Windows installer](https://github.com/w2112515/accio-byok/releases/download/v1.3.0/Accio-BYOK-Setup-1.3.0.exe) or [portable app](https://github.com/w2112515/accio-byok/releases/download/v1.3.0/Accio-BYOK-1.3.0-portable.exe). [SHA-256 checksums](https://github.com/w2112515/accio-byok/releases/download/v1.3.0/SHA256SUMS.txt) are provided. If an older version is running, quit it from the system tray first.
2. Open **Providers → Add provider**, choose a connection type, and enter your API key. You can paste a base URL or a full Chat Completions, Responses, Anthropic Messages, or Gemini endpoint. The app normalizes the URL when you leave the field, preserving deployment subpaths.
3. Select a model and choose **Test & enable**. After a successful check the connection is saved; review the destination, billing and compatibility before switching. **Save only** does not switch providers. Checks consume usage and are excluded from Accio totals. A tool round trip makes up to two requests. ChatGPT plan requests use server output limits; other checks request up to 1,024 output tokens. Bailian subscription plans exclude API test tools: save and verify through a permitted interactive task in Accio instead.
4. Choose **Start Accio**. If Accio is already running, connecting requires a confirmed restart and interrupts active tasks. A successful launch only confirms that the process started.
5. Send a message in Accio, then check **Overview** or **Usage & diagnostics** for the actual model and result. Switch providers from the top bar or tray; the next request uses your selection.

Closing the window normally leaves the proxy running in the tray. When quitting while Accio uses the proxy, the app offers to restart Accio with a direct connection to its official gateway.

The installer offers English and Simplified Chinese. The app's language setting is independent of the installer language. Provider names, notes, conversation content, historical logs, and upstream responses retain their original text.

## How it works

```text
Accio ── GATEWAY_BASE_URL ──▶ Accio BYOK (127.0.0.1:18920)
                              ├─ /api/adk/llm/generateContent → selected model provider
                              └─ sign-in, plugins, sync, etc. → phoenix-gw.alibaba.com
```

Accio reads `GATEWAY_BASE_URL`. Accio BYOK launches it with this variable and **does not modify Accio's installation files**. Model requests are translated to the selected provider's API; streamed text, reasoning, tool calls, usage, and errors are translated back into Accio frames. Other gateway traffic passes through.

Routing is selected per request, so switching providers does not restart Accio or affect responses already in progress. Thought signatures are bound to the provider record, protocol, URL, key, headers, and model; changing the connection prevents reuse of its old signatures.

The interface was inspired by [cc-switch](https://github.com/farion1231/cc-switch). Session migration was inspired by the accio switch script and rewritten to handle SQLite and embedded identifiers.

## Features

Version 1.4 adds saved official authorizations, separate subscription-key channels, connection-specific capability evidence, manual fallback candidates, context warnings, provider usage lookups, verified automatic session backups, recovery previews, and update/diagnostic controls. Existing navigation and provider presets remain in place. Real provider sign-in and paid inference have not yet been verified; local fixtures do not establish account eligibility or vendor compatibility.

| Area | Support |
|---|---|
| Providers | 18 visible presets: official APIs, Chinese providers, aggregators, local models, CPA / CLIProxyAPI, Sub2API, Grok2API, New API, and generic gateways |
| Protocols | OpenAI Chat Completions and Responses, Anthropic Messages, and native Gemini; use the protocol supported by your gateway |
| Models | Fetch model lists, force refresh, and map individual Accio models; lists are cached by connection for 5 minutes and duplicate requests are merged |
| Claude | Adaptive reasoning, multi-turn thought signatures, prompt caching, and reasoning effort; unmatched reasoning blocks are dropped when history changes |
| Network | Chromium networking with the system proxy, direct access, or a custom HTTP/SOCKS5 proxy |
| Usage | Time to first token, duration, tokens, cache reads/writes, estimated cost, and pricing coverage; unknown values are distinct from zero |
| Sessions | Back up, restore, and migrate to another account; writes require Accio to be closed, with safety backups and explicit partial-migration reporting |
| Desktop | English / Simplified Chinese, light/dark themes, Windows 11 Mica, tray switching, and an “Accio (BYOK)” shortcut |
| Protection | Encrypted keys and custom headers, browser-origin checks, redirect blocking, unsafe-header rejection, cooldowns, concurrency limits, and credential redaction |
| Recovery | Corrupt configuration is preserved and cannot be overwritten until explicit recovery; stalled requests time out with actionable errors |
| Model information | Source and timestamp for context limits and capabilities; optional tool and image tests; unknown information stays unknown |

## Official authorization and subscription connections

In a provider form, select **Authentication**. API-key connections remain available independently of plan connections. Do not paste website cookies or reuse a subscription login token as an API key.

| Provider | Connection choices and limits |
|---|---|
| OpenAI | API key, or **Continue with ChatGPT** using the [public open-source token-sharing flow](https://developers.openai.com/siwc/token-sharing-open-source). The account and workspace must be eligible and grant plan permission. OAuth credentials stay on the official endpoint. App limits pause new requests until you review usage and explicitly resume; no API-billing fallback occurs. |
| Kimi / Moonshot | Existing Moonshot API key, or a separate [Kimi Code key](https://www.kimi.com/help/kimi-code/membership-guide). Check personal development eligibility; a general Accio research task is not automatically permitted. Extra usage follows your provider settings. |
| DeepSeek | Existing API key; model IDs come from the service instead of an old default. The optional [balance lookup](https://api-docs.deepseek.com/api/get-user-balance/) uses only the official endpoint. No consumer-plan OAuth is assumed. |
| MiniMax | Ordinary API key, or a region-specific subscription key. The international [M Plan](https://www.minimax.io/m-plan) usage endpoint can return a snapshot; undocumented numeric fields retain their original names and are not converted to guessed tokens or reset times. China-region usage opens the provider console. |
| GLM / Bailian | Ordinary API keys remain. Separate [GLM Coding Plan](https://docs.bigmodel.cn/cn/coding-plan/tool/others) and [Bailian Token/Coding Plan](https://help.aliyun.com/zh/model-studio/more-tools) routes require acknowledgment of permitted interactive use. Restrictions and supported models vary by plan. |
| OpenRouter | API key or [official OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth), which issues this app a key using OpenRouter billing. Its reported key limit is not the whole account balance or another provider's subscription. |
| Claude, Gemini and other existing presets | Existing API connections remain; no new Claude subscription OAuth or consumer Google AI subscription transfer is provided. Local models can use a loopback-only no-key mode. |

Access documentation was reviewed on 2026-10-01. The app does not impersonate official clients. Saved authorization tokens are encrypted in a separate local vault and never returned to the renderer, session backups, configuration backups or diagnostic exports. Signing out reports whether remote revocation was confirmed; for OpenRouter, remove the app key in its console when needed. Refresh tokens are never restored from an old backup.

## Everyday use, recovery and maintenance

- **Capability evidence:** text, tool, image and tool-result round trips are separate checks. Changes to the connection or model invalidate the matching record. Checks older than 30 days get a manual-review reminder; the app does not automatically generate requests. Overview's review action opens the relevant checks. A synthetic pass is not a real long-task acceptance result.
- **Switching:** marked fallback connections appear after failures. Switching affects future requests and their conversation/tool context. It requires destination and billing review; in-flight work is not replayed.
- **Context and spending:** Overview and Usage show the current connection's latest default-model request, provider-reported tokens or a labelled text estimate, the window source/date, and an 80% warning. After connection changes they wait for matching requests; older logs remain in history. Media and opaque reasoning may be missing from estimates. API cost coverage excludes subscription/local requests. Missing price or allowance never means free.
- **Automatic backups:** opt in under Session backups. Once a day, changed accounts are backed up while Accio is closed; keep 1–30 automatic snapshots per account. Manual and protection backups are retained. SHA-256 and SQLite integrity are checked on the staged copy before restore/migration writes. A preview identifies scope, conflicts, unknown structures and consistency limits.
- **Backup status:** Overview and Session backups read the latest closed-session snapshot from disk, including after restart. The summary names its account; other accounts may have older or no backups. Snapshots over seven days old prompt review if work has changed. Enabling automatic backups is separate from completing one. These dates do not replace restore-time integrity checks.
- **Updates:** Settings checks this repository's GitHub releases, shows notes and prerelease status, and permits downloads only with a published SHA-256 digest. The digest is checked again before opening the package. Installation is explicit and requires Accio to be closed. The encrypted configuration backup stays under `updates/` in the data directory.
- **Rollback:** retain the previous executable. Run the version that created the backup, then choose **Restore configuration backup**. Only an exact-version backup is accepted. The current configuration is preserved, active routing returns to official, and automatic launch/backups are disabled for review. This does not downgrade Accio data or restore OAuth tokens. Versions before 1.4 do not support these new connection types.
- **Diagnostics:** preview before saving. Default reports contain status/timing/usage only. Up to three captured conversations may be included explicitly; known credentials are masked, but arbitrary private prose requires your review. Reports are saved locally, never uploaded.

## Gateways and credentials

Gateway presets provide connection starting points. They do not deploy gateways, sign in to subscription accounts, or change gateway account pools. Enter a **client API key issued by the gateway**, not an admin key, OAuth login token, or website cookie. Fetch model IDs from the actual API or follow its documentation.

| Connection | URL and protocol |
|---|---|
| [CPA / CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | Local example: `http://127.0.0.1:8317/v1`. Port 8317 comes from its configuration template. Chat, Responses, or other protocols depend on the deployment. |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | Match Anthropic, OpenAI Responses, or another compatible API to the key's group. Preserve specialized prefixes such as `/antigravity`. |
| [Grok2API](https://github.com/chenyme/grok2api) | Use the deployed URL; Chat is the preset default. Models and endpoints vary by version, fork, and account source. |
| [New API](https://github.com/QuantumNous/new-api) / generic gateway | Follow the site's token, channel, and API instructions. OpenAI base URLs usually include `/v1`; existing subpaths are preserved. |

- **Request protection:** up to 4 concurrent requests per target site and credentials. Slots release when the response finishes or is cancelled. Excess requests are rejected locally rather than queued. HTTP 429 follows `Retry-After` seconds or a date, defaulting to 60 seconds. Cooldowns last only within the current process. There is no automatic retry or account rotation. Gateway-side retries and account pools remain the gateway's responsibility.
- **Visible status:** Overview, provider cards, and test results show concurrency and cooldowns. Countdown updates are local and do not poll providers. Diagnostics mark blocked requests as **Not sent**. Success rate includes local rejections and measures requests received by this proxy, not upstream availability alone.
- **Credentials and URLs:** API redirects are not followed, browser cookies are not attached, and custom authentication headers are merged case-insensitively. Remote HTTP requires explicit consent; local HTTP is allowed. Errors redact configured key and header values. The custom-header editor still shows original values.
- **Sign-in and sync gateway:** the upstream gateway in Settings receives Accio credentials and sync data. Remote URLs must use HTTPS; HTTP is allowed only locally. Settings, HTTP forwarding, and WebSocket upgrades enforce this boundary. There is no remote-HTTP exception for this gateway.
- **Local boundary:** the proxy listens only on `127.0.0.1` and checks Host, Origin, and cross-site request markers. Model calls require JSON. WebSocket upgrades also check the origin. These checks protect against browser access; they do not authenticate local programs. Individual upstream SSE events are limited to 16 Mi characters; error bodies to 64 Ki characters.
- **Responses:** supports text, image input, function calls/results, usage, and encrypted reasoning continuation bound to the current connection and model. Requests use `store: false` and do not use `previous_response_id`. Incomplete streams or tool arguments do not execute tools. Custom stop sequences are rejected explicitly. The storage parameter does not guarantee a third-party gateway's privacy practices. [Official protocol guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)

These measures reduce accidental credential forwarding and request bursts. They **do not guarantee protection against account restrictions**. Each platform controls permitted access, quotas, and enforcement. Gateways can access request content; connect only to services you trust and are authorized to use. There is no official-client impersonation, automatic proxy-IP switching, or account-limit evasion.

## Caching, context limits, and completion

**Prompt caching and context compaction are different.** Caching can lower repeated-input costs; it does not expand a context window. Claude cache reads, writes, and uncached input are tracked separately. Official Claude 5-minute cache writes are estimated at 1.25× input price when no write price is entered; custom providers can set their own. Prices and usage are estimates; the provider's bill is authoritative. [Official caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

**Accio manages automatic compaction.** Inspection of local Accio 0.33 showed that it reads context limits from its own model catalog. BYOK switching changes the outbound model but does not update that catalog or compaction threshold. A smaller target window can overflow before Accio compacts. Compact or start a new conversation and check the output token limit. The proxy reports context-limit errors; it does not silently trim history or send extra summarization requests.

**Compaction changes cache prefixes.** Rewriting history, tool definitions, or some reasoning settings can invalidate cached prefixes. Enabling caching does not guarantee a hit. [Official invalidation rules](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#what-invalidates-the-cache)

Resource bounds:

- Model lists: memory only, up to 20 connections for 5 minutes; cleared when outbound network settings change.
- Usage-statistics cache: up to 31 days and 16 MiB by file size. On-disk history remains until **Clear all logs** is used.
- Debug captures: memory only, up to 30 entries, 2 MiB each and 16 MiB total. Response frames are capped at 2,000 or 1 MiB, with truncation marked. Disabling capture clears it immediately. Common authentication fields are hidden; message bodies may still contain sensitive content.
- HTTP gzip, deflate, Brotli, and Zstd decompression runs asynchronously with a decoded-size limit. It does not change conversation content or token counts.

Empty responses, missing completion markers, cancellation, and incomplete tool arguments are not successful replies. Headers time out after 60 seconds; valid upstream events have a default 180-second idle limit, adjustable in Settings. Local heartbeat frames do not extend this deadline. Timeouts do not replay requests.

Tool calls are delivered as a complete batch only after normal completion. Output limits, refusal, or safety stops prevent delivery even when arguments are valid JSON. Reasoning-only, blank, or empty results are reported as errors; providers may still charge. Partial visible text can remain visible.

Connection tests verify short text only. Optional tool and image tests each send one synthetic request, execute no tools, and read no user files. Real multi-turn tools and long conversations still need verification in Accio. Model information is advisory and does not change native compaction thresholds.

## Backups and migration

Restore checks backup directories and file counts, stages the complete data before replacement, and keeps a safety backup. Migration preparation failures stop before writing; failures during commit report partial completion and a recovery entry point. SQLite online backup is supported, but close Accio before creating an important cross-file restore point. File counts cannot detect every form of content corruption.

Migration rewrites only known ownership/reference fields and identifier paths. Account numbers in message text, titles, tool arguments, and generated content are preserved. Artifact and skill file contents remain unchanged; SQLite uses consistent snapshots. Unknown reference fields or unsupported formats stop migration before target writes. Arbitrary Accio versions and structures are not guaranteed.

Account-list statistics skip symbolic-link targets. **Actual backup and restore still reject symbolic links** to avoid copying or overwriting their targets. If list loading fails, the app keeps the reason and a retry action; stale lists remain disabled until a successful reload.

## Upgrading and compatibility

The app keeps `%APPDATA%/Accio Switch`, its installation identity, and the internal executable name `Accio Switch.exe` to preserve existing startup entries and shortcuts. Older release assets do not include later changes.

Existing OpenAI connections keep their protocol; new official OpenAI connections default to Responses. Legacy plain-text custom headers are encrypted on the next configuration save. Version 1.1 and earlier cannot read the new encrypted headers: restore a complete pre-upgrade application-data copy or re-enter them when downgrading.

Since 1.2.1, old Anthropic/Gemini signatures bound only to provider ID are no longer forwarded. Text and tool history remain; start a new conversation if a provider rejects continuation. Legacy remote-HTTP upstream gateway settings remain readable and editable, but forwarding is blocked until changed to a trusted HTTPS URL. Provider configuration is preserved.

Version 1.3.0 adds a saved language preference. Configurations without it open in English. Switching language does not rename saved providers or rewrite notes, sessions, historical logs, or upstream content.

## Development and verification

See [Implementation and acceptance notes](docs/next-stage.md) for scope, evidence, and the compaction investigation's stop condition. All 48 checks pass, including targeted authorization, update integrity and recovery checks in addition to the existing protocol, credential and migration protections. Type checking and builds pass. UI and package evidence is recorded separately.

Real paid providers, native long-conversation compaction, actual upgrade installation, and Windows login startup have not been fully tested.

```bash
npm install                 # Set ELECTRON_MIRROR if an Electron download mirror is needed
npm run dev                 # Development mode
npm test                    # Protocol, proxy, configuration, and session checks (node:test)
npm run typecheck
npm run build && npm start   # Build and run current source; existing release assets do not update
npm run dist                # Build Windows NSIS and portable packages in release/
```

`scripts/seed-demo.mjs <new-directory>` creates synthetic demo data only. The target directory must not exist; the script never clears an existing directory. Demo keys are invalid placeholders.

```text
src/main/proxy/       API translation and local proxy; accio.ts describes the observed ADK frames
src/main/sessions.ts  Backup, restore, and cross-account migration
src/main/index.ts     Windows, tray, IPC, and Accio process control
src/shared/i18n.ts    Shared language selection and message interpolation
src/shared/translations.ts  English translations of app-owned copy
src/renderer/        React, Tailwind v4, and Radix UI
tests/               Includes an Accio frame parser replica for checking output
```
