# Mimo desktop companion

Mimo creates and delivers reminders in a floating Windows avatar. Reminders and preferences are stored in SQLite in Mimo’s application data directory. Closing the dashboard leaves Mimo running in the tray.

## Run and package

Install Node.js 24 or later. Double-click `Start-Mimo.cmd`, or run:

```powershell
npm install
node node_modules/electron/install.js
npm start
```

The first install downloads Electron. For a portable Windows build, run `npm run package:win` and keep the entire `release/Mimo-win-x64` folder together. Launch `Mimo.exe` from that folder. The portable build uses the same application data as the development launch.

## Talk to Mimo

- Press **Ctrl+Alt+Space** or choose **Talk to avatar** from the tray. On first use, choose whether to enable the microphone or type.
- Say or type “Remind me to check the deployment in five minutes.” If a date or time is missing, Mimo asks for it. Say “confirm” or select **Confirm** to save. Select **Edit** to correct recognized text or change a detail.
- Say “nothing else” to close the conversation. When a reminder arrives, say “I completed it,” “remind me again in ten minutes,” “move it to 4 PM,” or “dismiss.” The bubble also has buttons for completing, snoozing, and dismissing.
- In **Avatar studio**, **Memo — cartoon voice** is the default. It uses the bundled Kokoro model and a custom voice blend to synthesize dialogue locally. You can select an installed voice and adjust speed and volume. The default stop shortcut is **Ctrl+Alt+Backspace**. Click the avatar or press the activation shortcut again while the controls are visible to move keyboard focus into the widget. Drag the avatar to reposition it.
- Enable **Listen for “Hey Memo” while in the tray** in Avatar Studio if you want hands-free activation. Say “Hey Memo” or “Pay Memo,” wait for the greeting, then speak your request. Say “Close Memo” for a spoken goodbye and to hide the avatar. The tray menu can turn off the wake microphone.

Recognition uses the installed Windows English speech component. Windows microphone privacy settings must allow desktop applications to use the input device. The widget shows a listening indicator during conversation turns. When voice wake is enabled, the tray tooltip indicates that the wake microphone is active. While the avatar is hidden, the recognizer only matches wake phrases. Speech is processed on the device. Mimo retains the reminder’s spoken transcript in SQLite and creates no microphone recordings.

Daily and weekly reminders keep their local time. Dismissing a one-time alert leaves the reminder available in the dashboard. Completing or dismissing a recurring occurrence advances it to the next scheduled occurrence. Overdue reminders are reconciled when Mimo starts or Windows resumes.

## Verify

Run `npm test` for language parsing, SQLite migration, recovery, deduplication, snoozing, and recurring schedules. The desktop integration test uses synthesized speech files and an isolated profile. Run it in a Windows desktop session with English recognition and synthesis installed:

```powershell
$env:MIMO_TEST_DATA = Join-Path $env:TEMP ('mimo-test-' + [Guid]::NewGuid().ToString('N'))
$env:MIMO_TEST_PHASE = 'flow'
npm run test:desktop
$env:MIMO_TEST_PHASE = 'restart'
npm run test:desktop
```

The desktop suite sends the global shortcut, plays system speech, and makes test reminders due immediately after checking their original scheduled times. To check the physical microphone and audible output on a specific computer, follow the conversation steps above in a regular Mimo session.

## Actions and pins

Open **Actions** or say “Ask Claude to…” as “Ask Claude, [your text],” “Search Chrome for…,” or “Open folder [pin name].” Voice opens the Actions panel for review. The panel waits for your click before it runs the action.

- **Give text** and **Give a comment** let you compose a draft. **Copy text and open chat** opens ChatGPT or Claude in your browser and copies the draft for you to paste and send.
- For direct replies in Memo, save your provider’s API key under **Cloud connection**, then click **Send via API**. Keys are encrypted using Windows, and each request sends the current draft to the selected provider. The visible reply stays in the current window. Each request is a separate API turn.
- **Chrome search** opens a Google search in Chrome when available in its standard install locations. Memo uses the default browser if Chrome is unavailable.
- Use **Add a pin** to save a local folder, a Windows executable, or an HTTPS website. Web pins open in your browser. Folder and app pins work on the current PC.

Run `npm run test:actions-desktop` to verify Actions in an isolated desktop profile with simulated browser, folder, and cloud destinations.

To talk directly with a connected model, say “Talk to Claude” or “Talk to ChatGPT” after waking Memo. Ask your question, then say “Confirm” or use the confirmation button. Memo speaks the reply and shows it in the bubble. Recent turns stay in memory for follow-up questions in that conversation. Say “Back to reminders” to exit model chat.

## Workflows and n8n

**Workflows** lets you save and reorder up to eight steps, review them before running, and inspect completion or failure by step. **Open Documents** runs without a cloud connection. Folders, apps, and websites you save in **Actions** are available as **Open pin** steps. A Chrome search uses the input you entered. Say “Run workflow [name]” to open a workflow for review from the avatar.

### Connect an n8n agent

1. In Mimo, open **Workflows → n8n connection → Save n8n starter template**. Import the JSON into n8n.
2. Configure the **Mimo POST** node’s **Header Auth** credential with a header name, such as `X-Mimo-Key`, and a secret you choose. Publish the workflow and copy its **Production URL**. To use a test URL, enable **Listen for Test Event** in n8n first.
3. Paste the webhook URL, header name, and matching secret into Mimo’s **n8n connection** and save. Select **Ask n8n**, enter your input, and click **Run workflow**. The starter replies “Mimo reached n8n.”
4. To use an existing AI Agent, place it between **Mimo POST** and **Reply to Mimo**. Set its input to `{{ $json.body.input }}` (or use the Webhook node by name if other nodes intervene). Attach the chat model and tools in n8n. In **Reply to Mimo**, return JSON such as `{{ { reply: $json.output } }}`.

Mimo posts `{"input":"your text","runId":"unique id"}` to the webhook. A reply may be plain text or a JSON object with a `reply` or `output` string. Use a JSON boolean `continue` if you want a configured downstream step to run conditionally. Only that boolean influences conditions. The webhook reply cannot select programs, files, or URLs on your PC.

Use a webhook credential rather than an n8n administration key. Mimo encrypts the credential with Windows and keeps the last 20 run receipts locally. Receipts contain step status rather than prompts or replies. A stopped run may already have opened a target or reached n8n. After an unexpected exit, unfinished runs are marked interrupted.

`npm run test:workflows-desktop` uses a real HTTP request to a local fixture with a webhook key and checks the resulting desktop action path. Set `MIMO_WORKFLOW_OPEN_DOCUMENTS=1` before that command to actually open File Explorer on Windows.

## Ask Memo Agent

Use **Agent → Model connection** to choose OpenAI or Anthropic and save an API key. Enter a task, or wake the avatar and say “Ask Memo” followed by your request. **Create plan** sends the task to that provider. The provider proposes one to five nodes, and **Run selected nodes** runs your selection in order. Side-effect nodes start unselected, and a failed node stops the remaining sequence.

Enable the capabilities you want: **Answer**, **Open a pin**, **Web search**, **Save a reminder**, and **Move Memo**. Open pin is limited to existing entries in Actions. The provider sees pin names and IDs when that capability is enabled. The review shows the exact target before you run anything. The model cannot add software, run an arbitrary command or give itself capabilities.

Enable **Remember completed replies** to keep recent completed turns on this PC and include up to four in a subsequent plan. Turn it off to stop sharing saved turns, or use **Clear memory** to remove them.

In **Avatar studio**, choose a character card, then customize color, expression, accessory and size. Use **Dance**, **Jump** or **Wave** to play the move in the floating avatar. You can play moves from the tray or say “Dance” or “Jump” after waking Memo.

Run `npm run test:agent-desktop` to verify a five-node plan using a simulated provider. Set `MEMO_AGENT_SHOW_ACTIONS=1` to actually open Documents during the test.

## Voice wake from the desktop

Keep Mimo running in the Windows notification area. Closing the dashboard leaves it running there. With **Avatar studio → Listen for “Hey Mimo” while Mimo runs in the tray** enabled, say **Hey Mimo**, then wait for the listening indicator before speaking. Say **Close Mimo** during a conversation to hear a goodbye and hide the avatar. Voice wake resumes after the avatar closes. The home screen shows the current wake status. **Talk to Mimo** and **Ctrl+Alt+Space** also open the avatar.

Completed agent tasks with action nodes and finished workflow runs show a short avatar notice. If another conversation is open, the notice waits until that conversation ends.
