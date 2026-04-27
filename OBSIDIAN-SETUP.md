# Obsidian setup for the BNI-Masta vault

The vault files are written by `install.sh`. These are the steps *you* click inside Obsidian.app.

## 1. Open the vault

1. Launch **Obsidian.app**.
2. On the vault-switcher screen → **Open folder as vault** → `~/Documents/BNI AGENT/BNI AGENT/` → Open.
3. **Trust author and enable plugins** when prompted.

## 2. Turn on community plugins

1. **Settings (⌘,)** → **Community plugins**.
2. **Turn on community plugins** → confirm.
3. **Browse** → install + enable each of these four:
   - **Dataview** (by Michael Brenan) — drives `_dashboards/`
   - **Templater** (by SilentVoid) — drives `_templates/`
   - **Tasks** (by Clare Macrae) — drives `_dashboards/follow_ups.md`
   - **Calendar** (by Liam Cain) — sidebar calendar

## 3. Configure Templater

**Settings → Community plugins → Templater (gear icon)**

- **Template folder location** → `_templates`
- **Trigger Templater on new file creation** → ON
- **Folder Templates** → Add three:
  - `wiki/members` → `_templates/member.md`
  - `wiki/meetings` → `_templates/meeting.md`
  - `wiki/events` → `_templates/event.md`

## 4. Configure Dataview

- **Enable JavaScript Queries** → ON
- **Enable Inline JavaScript Queries** → ON

## 5. Configure Tasks

Leave defaults.

## 6. Files & links

**Settings → Files and links**

- **Default location for new attachments** → *In the folder specified below* → `raw/inbox`
- **New link format** → *Relative path to file*
- **Automatically update internal links** → ON

## 7. Verify

Open `_dashboards/traffic_lights.md`. You should see empty tables with Chinese headers — not raw ```dataview``` code blocks. If raw code, re-enable Dataview.

Open `wiki/index.md`. You should see a list of rule pages under "規則 (Rules)" including `[[rules/traffic_lights]]`, `[[rules/封閉會議]]`, `[[rules/點名規則]]`, etc.

## 8. (Optional) Mobile sync

**Leave off for now.** The vault contains sensitive member PII once populated. Revisit after v1 is stable.

## 9. (Optional) Graph-view filter

To focus the graph on the wiki (exclude raw/ and dashboards):

- **Graph view (⌘G)** → Settings → Filters →
  - Paths to include: `wiki/`
  - Paths to exclude: `raw/, _templates, _dashboards`
